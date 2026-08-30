import { randomUUID } from "node:crypto";
import type { QuotaGuardService } from "./service.js";
import { profileKey, type StateStore } from "./store.js";
import { MONITOR_INTERVAL_MS } from "./monitor-state.js";
import type { StoredDefer } from "./types.js";

export interface SchedulerDefinition { serialized: string; [key: string]: unknown }
export interface SchedulerBridge {
  available(): boolean;
  read(defer: StoredDefer): Promise<SchedulerDefinition | null>;
  expected(definition: SchedulerDefinition): string;
  advance(defer: StoredDefer, definition: SchedulerDefinition, authorize: () => boolean): Promise<boolean>;
  cancel(defer: StoredDefer, expected: string, authorize: () => boolean): Promise<boolean>;
  close(): Promise<void>;
}

/** Many instances may tick; SQLite chooses one winner, including within one process. */
export class QuotaMonitor {
  private readonly key: string;
  private readonly owner = randomUUID();
  private running = false;
  private stopped = false;
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hasLiveClients: () => boolean = () => true;
  constructor(codexHome: string, private readonly store: StateStore, private readonly service: QuotaGuardService,
    private readonly scheduler: SchedulerBridge, private readonly now: () => number = Date.now) {
    this.key = profileKey(codexHome);
  }

  setLiveClients(read: () => boolean): void { this.hasLiveClients = read; }
  isBusy(): boolean { return this.running || this.active !== undefined; }
  wake(): void { if (!this.stopped) void this.tick(); }

  start(): void {
    const loop = async (): Promise<void> => {
      try { await this.tick(); } catch { /* Next tick remains bounded by the durable deadline. */ }
      if (!this.stopped) { this.timer = setTimeout(() => { void loop(); }, 15_000); this.timer.unref(); }
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
    await this.scheduler.close();
  }

  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.runTick().finally(() => { this.active = undefined; });
    return this.active;
  }

  private async cleanup(): Promise<void> {
    const records = this.store.monitor.list(this.key).filter(record => record.stage !== "waiting"
      && this.store.getDefer(this.key, record.deferId)?.state !== "active");
    if (!records.length) return;
    const key = `${this.key}:cleanup`;
    const ticket = this.store.monitor.claim(key, this.owner, this.now(), 15_000);
    if (!ticket) return;
    const owns = (): boolean => !this.stopped && this.hasLiveClients() && this.store.monitor.owns(key, ticket, this.now());
    let error: string | null = null;
    try {
      for (const record of records) {
        const defer = this.store.getDefer(this.key, record.deferId);
        if (!defer || !record.expectedAutomation || !owns()) continue;
        const cancelled = await this.scheduler.cancel(defer, record.expectedAutomation, owns);
        if (cancelled && owns()) {
          this.store.monitor.mark(this.key, defer.id, "cancelled", this.now());
        } else if (!cancelled) error = "SCHEDULER_CLEANUP_FAILED";
      }
    } catch { error = "SCHEDULER_CLEANUP_FAILED"; }
    finally { this.store.monitor.finish(key, ticket, this.now() + (error ? MONITOR_INTERVAL_MS : 15_000), error); }
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.running || !this.hasLiveClients() || !this.scheduler.available()) return;
    await this.cleanup();
    if (this.stopped) return;
    const records = this.store.monitor.list(this.key);
    if (!records.length) return;
    const ticket = this.store.monitor.claim(this.key, this.owner, this.now());
    if (!ticket) return;
    this.running = true;
    let next = this.now() + MONITOR_INTERVAL_MS;
    let error: string | null = null;
    const owns = (): boolean => !this.stopped && this.hasLiveClients() && this.store.monitor.owns(this.key, ticket, this.now());
    const renewal = setInterval(() => { if (!this.stopped) this.store.monitor.renew(this.key, ticket, this.now()); }, 20_000);
    renewal.unref();
    try {
      const waiting = records.filter(record => record.stage === "waiting");
      if (!waiting.length || !owns()) return;
      const quota = await this.service.monitorQuota();
      if (quota.backoffUntil) next = Math.max(next, Date.parse(quota.backoffUntil));
      if (quota.stale || quota.refreshInProgress || quota.error || !owns()) return;
      for (const recovery of waiting) {
        const defer = this.store.getDefer(this.key, recovery.deferId);
        if (!defer || defer.state !== "active" || (defer.resumeAt && Date.parse(defer.resumeAt) <= this.now() + 120_000)
          || !this.service.monitorCanResume(defer, quota) || !owns()) continue;
        const definition = await this.scheduler.read(defer);
        if (!definition || !recovery.originalAutomation || definition.serialized !== recovery.originalAutomation || !owns()) continue;
        const expected = this.scheduler.expected(definition);
        let claimed = false;
        try {
          const sent = await this.scheduler.advance(defer, definition, () => {
            claimed = owns() && this.store.monitor.dispatch(this.key, ticket, defer.id, expected, this.now());
            return claimed;
          });
          if (claimed && owns()) this.store.monitor.mark(this.key, defer.id, sent ? "scheduled" : "uncertain", this.now());
          if (claimed && !sent) error = "SCHEDULER_UPDATE_UNCONFIRMED";
        } catch {
          if (claimed && owns()) this.store.monitor.mark(this.key, defer.id, "uncertain", this.now());
          error = "SCHEDULER_UPDATE_FAILED";
        }
      }
    } catch { error = "MONITOR_FAILED"; }
    finally {
      clearInterval(renewal);
      this.store.monitor.finish(this.key, ticket, next, error);
      this.running = false;
    }
  }
}

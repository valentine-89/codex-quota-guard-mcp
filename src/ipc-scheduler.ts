import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { IpcClient, ipcPath } from "./ipc-client.js";
import type { GuardConfig } from "./config.js";
import type { QuotaGuardService } from "./service.js";
import { profileKey, type StateStore } from "./store.js";
import type { StoredDefer, QuotaSnapshot } from "./types.js";
import { taskContext, type TaskContext } from "./task-context.js";
import type { WakeState } from "./ipc-state.js";

export interface SchedulingStatus { mechanism: "desktop" | "ipc" | "unavailable"; state: WakeState; reason: string | null }
export function ipcResumePrompt(defer: StoredDefer): string {
  return `Quota Guard scheduled resume. First call resume_prepare with ${JSON.stringify({ workspaceRoot: defer.workspaceRoot,
    taskId: defer.taskId, deferId: defer.id, laneId: defer.laneId, trigger: "automation" })}. Proceed only if action=continue; wait means quota-blocked, exit means invalid/consumed wake. Otherwise retrieve the saved checkpoint and continue its authorized work. Do not create an unrelated task.`;
}
type Binding = { context: TaskContext; cwd: string; verifiedAt: number };
/** One timer in the existing core; durable schedules never keep the process alive. */
export class IpcScheduler {
  private readonly key: string;
  private bindings = new Map<string, Binding>();
  private reasons = new Map<string, string>();
  private live: (id: string) => boolean = () => false;
  private active: Promise<void> | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly config: GuardConfig, private readonly store: StateStore, private readonly service: QuotaGuardService,
    private readonly factory: () => IpcClient = () => new IpcClient(), private readonly now: () => number = Date.now,
    private readonly platform: NodeJS.Platform = process.platform) { this.key = profileKey(config.codexHome); }
  setLiveClients(live: (id: string) => boolean): void { this.live = live; }
  private prune(): void { for (const [id, b] of this.bindings) if (!this.live(b.context.clientId)) { this.bindings.delete(id); this.reasons.delete(id); } }
  private correctProfile(rolloutPath: string): boolean {
    const root = ipcPath(this.config.codexHome);
    const path = ipcPath(rolloutPath);
    return ["sessions", "archived_sessions"].some(folder => path.startsWith(resolve(root, folder).toLowerCase() + (this.platform === "win32" && process.platform === "win32" ? "\\" : "/")));
  }
  async bind(context: TaskContext): Promise<void> {
    this.prune();
    if (context.desktop || this.platform !== "win32" || !this.live(context.clientId) || this.stopped) return;
    if (this.bindings.size >= 128 && !this.bindings.has(context.taskId)) return;
    const old = this.bindings.get(context.taskId);
    if (old?.context.clientId === context.clientId && this.now() - old.verifiedAt < 60_000) return;
    const client = this.factory();
    try {
      await client.connect(); const snapshot = await client.inspect(context.taskId);
      if (!this.correctProfile(snapshot.rolloutPath)) throw new Error("IPC_PROFILE_MISMATCH");
      if (this.live(context.clientId)) {
        this.bindings.set(context.taskId, { context, cwd: snapshot.cwd, verifiedAt: this.now() });
        this.reasons.delete(context.taskId);
      }
    } catch { this.bindings.delete(context.taskId); if (this.reasons.size >= 128) this.reasons.clear(); this.reasons.set(context.taskId, "IPC_CONTEXT_UNAVAILABLE"); }
    finally { client.close(); }
  }
  status(context = taskContext.getStore()): SchedulingStatus {
    this.prune();
    if (context?.desktop) return { mechanism: "desktop", state: "waiting", reason: null };
    const binding = context ? this.bindings.get(context.taskId) : undefined;
    const ready = !!binding && this.live(binding.context.clientId) && binding.context.clientId === context?.clientId;
    return { mechanism: ready ? "ipc" : "unavailable", state: "waiting",
      reason: ready ? null : context ? this.reasons.get(context.taskId) ?? "IPC_CONTEXT_UNAVAILABLE" : "TASK_CONTEXT_MISSING" };
  }
  schedule(defer: StoredDefer, canSchedule: boolean): SchedulingStatus {
    const context = taskContext.getStore(); const status = this.status(context);
    // Existing direct/older clients retain the original host-created heartbeat contract.
    if (!context) return { mechanism: "desktop", state: "waiting", reason: null };
    if (status.mechanism !== "ipc") return status;
    const binding = this.bindings.get(defer.taskId);
    if (!context || context.taskId !== defer.taskId || !binding || ipcPath(binding.cwd) !== ipcPath(defer.workspaceRoot)) {
      return { mechanism: "unavailable", state: "waiting", reason: "IPC_WORKSPACE_OR_TASK_MISMATCH" };
    }
    if (!canSchedule || !defer.resumeAt) return { ...status, reason: "RESET_NOT_SCHEDULABLE" };
    this.store.ipc.create(this.key, defer.id, Date.parse(defer.resumeAt), this.now());
    return { mechanism: "ipc", state: "scheduled", reason: null };
  }
  diagnostics(): object {
    const context = taskContext.getStore();
    return { ...this.status(context), records: context ? this.store.ipc.list(this.key)
      .filter(r => this.store.getDefer(this.key, r.deferId)?.taskId === context.taskId) : [] };
  }
  isBusy(): boolean { return this.active !== undefined; }
  start(): void {
    const loop = async () => { await this.tick(); if (!this.stopped) { this.timer = setTimeout(() => { void loop(); }, 15_000); this.timer.unref(); } };
    void loop();
  }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.active; this.bindings.clear(); }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().catch(() => undefined).finally(() => { this.active = undefined; }); return this.active;
  }
  private async run(): Promise<void> {
    this.prune(); if (this.stopped || !this.bindings.size) return;
    let batchQuota: QuotaSnapshot | undefined;
    for (const wake of this.store.ipc.list(this.key)) {
      if (this.stopped || wake.attempt || !["scheduled", "waiting"].includes(wake.state) || wake.nextCheck > this.now()) continue;
      const defer = this.store.getDefer(this.key, wake.deferId);
      const binding = defer ? this.bindings.get(defer.taskId) : undefined;
      if (!defer || defer.state !== "active" || !binding || !this.live(binding.context.clientId)) continue;
      if (this.config.monitorEnabled === false && this.now() < wake.due) continue;
      const client = this.factory();
      try {
        await client.connect(); const snapshot = await client.inspect(defer.taskId);
        if (!snapshot.idle || !this.correctProfile(snapshot.rolloutPath) || ipcPath(snapshot.cwd) !== ipcPath(defer.workspaceRoot)) {
          this.store.ipc.postpone(this.key, defer.id, this.now() + 15_000, "IPC_TASK_NOT_IDLE_OR_CHANGED"); continue;
        }
        if (!batchQuota) {
          const ticket = this.store.monitor.claim(`${this.key}:ipc`, binding.context.clientId, this.now());
          if (!ticket) continue;
          try { batchQuota = await this.service.monitorQuota(); }
          finally { this.store.monitor.finish(`${this.key}:ipc`, ticket, this.now() + 300_000, null); }
        }
        const ready = !batchQuota.stale && !batchQuota.refreshInProgress && !batchQuota.error && this.service.monitorCanResume(defer, batchQuota);
        if (!ready) { this.store.ipc.postpone(this.key, defer.id, this.now() + 300_000, "QUOTA_NOT_READY"); continue; }
        const fresh = await client.inspect(defer.taskId);
        if (!this.correctProfile(fresh.rolloutPath)) throw new Error("IPC_PROFILE_MISMATCH");
        const attempt = randomUUID();
        const turnId = await client.send(fresh, defer.workspaceRoot, ipcResumePrompt(defer), () => !this.stopped
          && this.live(binding.context.clientId) && this.store.ipc.claim(this.key, defer.id, attempt, this.now()));
        this.store.ipc.confirm(this.key, defer.id, attempt, turnId);
      } catch { this.store.ipc.postpone(this.key, defer.id, this.now() + 60_000, "IPC_UNAVAILABLE_OR_UNCONFIRMED"); }
      finally { client.close(); }
    }
  }
}

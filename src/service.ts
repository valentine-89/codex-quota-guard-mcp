import { randomUUID } from "node:crypto";
import type { GuardConfig } from "./config.js";
import { toGuardError } from "./errors.js";
import { normalizeRateLimits, preflightJob, recommendationFor, ttlForWindow } from "./policy.js";
import {
  accountFingerprint,
  profileKey,
} from "./store.js";
import type { StateStore } from "./store.js";
import type {
  AppServerQuotaResult,
  CheckpointPayload,
  JobClass,
  JobPreflightResult,
  QuotaSnapshot,
  StoredCheckpoint,
} from "./types.js";

export interface QuotaReader {
  readQuota(): Promise<AppServerQuotaResult>;
}

export interface ServiceDependencies {
  now?: () => number;
  random?: () => number;
  ownerId?: string;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function unknownSnapshot(nowMs: number, nextRefreshAtMs: number, refreshInProgress: boolean): QuotaSnapshot {
  return {
    fiveHour: null,
    weekly: null,
    planType: null,
    rateLimitReachedType: null,
    recommendation: "caution",
    fetchedAt: null,
    nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
    stale: true,
    refreshInProgress,
    backoffUntil: null,
    source: "unavailable",
    error: null,
  };
}

export class QuotaGuardService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ownerId: string;
  private readonly key: string;

  constructor(
    private readonly config: GuardConfig,
    private readonly store: StateStore,
    private readonly reader: QuotaReader,
    dependencies: ServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.ownerId = dependencies.ownerId ?? randomUUID();
    this.key = profileKey(config.codexHome);
  }

  async quotaStatus(): Promise<QuotaSnapshot> {
    const nowMs = this.now();
    const cached = this.store.getCache(this.key);
    const backoff = this.store.getBackoff(this.key);

    if (cached && nowMs < cached.nextRefreshAtMs) {
      return this.cachedStatus(cached.snapshot, cached.nextRefreshAtMs, false, backoff?.untilMs ?? null);
    }
    if (backoff && nowMs < backoff.untilMs) {
      const base = cached
        ? this.cachedStatus(cached.snapshot, Math.max(cached.nextRefreshAtMs, backoff.untilMs), true, backoff.untilMs)
        : unknownSnapshot(nowMs, backoff.untilMs, false);
      return {
        ...base,
        backoffUntil: iso(backoff.untilMs),
        error: { code: backoff.errorCode, message: "Quota refresh is in shared backoff; using the latest safe state." },
      };
    }

    const acquired = this.store.tryAcquireLease(this.key, this.ownerId, nowMs, this.config.leaseDurationMs);
    if (!acquired) {
      return cached
        ? this.cachedStatus(cached.snapshot, cached.nextRefreshAtMs, true, backoff?.untilMs ?? null)
        : unknownSnapshot(nowMs, nowMs + this.config.ttlMs.low, true);
    }

    try {
      const raw = await this.reader.readQuota();
      const normalized = normalizeRateLimits(raw.rateLimits);
      const account = raw.account.account;
      const accountPlan = account && typeof account.planType === "string" ? account.planType : null;
      const planType = accountPlan ?? normalized.planType;
      const recommendation = recommendationFor(normalized.fiveHour, normalized.rateLimitReachedType, this.config);
      const ttl = ttlForWindow(normalized.fiveHour, nowMs, this.config);
      const nextRefreshAtMs = nowMs + ttl;
      const snapshot: QuotaSnapshot = {
        fiveHour: normalized.fiveHour,
        weekly: normalized.weekly,
        planType,
        rateLimitReachedType: normalized.rateLimitReachedType,
        recommendation,
        fetchedAt: new Date(nowMs).toISOString(),
        nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
        stale: false,
        refreshInProgress: false,
        backoffUntil: null,
        source: "codex-app-server",
        error: null,
      };
      this.store.saveCache(
        this.key,
        snapshot,
        nextRefreshAtMs,
        accountFingerprint(account?.type, account?.email),
        nowMs,
      );
      return snapshot;
    } catch (error) {
      const guardError = toGuardError(error);
      const kind = guardError.retryAfterMs !== null || /429|RATE_LIMIT/i.test(guardError.code)
        ? "rate-limit"
        : /TIMEOUT|SERVER|CLOSED|FAILED/i.test(guardError.code)
          ? "server"
          : "other";
      const nextBackoff = this.store.recordFailure(
        this.key,
        kind,
        guardError.code,
        nowMs,
        guardError.retryAfterMs,
        this.random,
      );
      const base = cached
        ? this.cachedStatus(cached.snapshot, Math.max(cached.nextRefreshAtMs, nextBackoff.untilMs), true, nextBackoff.untilMs)
        : unknownSnapshot(nowMs, nextBackoff.untilMs, false);
      return {
        ...base,
        backoffUntil: iso(nextBackoff.untilMs),
        error: { code: guardError.code, message: guardError.message },
      };
    } finally {
      this.store.releaseLease(this.key, this.ownerId);
    }
  }

  async jobPreflight(jobClass: JobClass): Promise<JobPreflightResult> {
    return preflightJob(await this.quotaStatus(), jobClass);
  }

  createCheckpoint(payload: CheckpointPayload, resumeAtMs: number | null = null): StoredCheckpoint {
    return this.store.createCheckpoint(this.key, payload, resumeAtMs, this.now());
  }

  getCheckpoint(workspaceRoot: string, taskId?: string, checkpointId?: string): StoredCheckpoint | null {
    return this.store.getCheckpoint(this.key, workspaceRoot, taskId, checkpointId);
  }

  async deferUntilReset(payload: CheckpointPayload): Promise<{
    checkpoint: StoredCheckpoint;
    resumeAt: string | null;
    canSchedule: boolean;
    automationPrompt: string;
    quota: QuotaSnapshot;
  }> {
    const quota = await this.quotaStatus();
    const resetMs = quota.fiveHour?.resetsAt ? Date.parse(quota.fiveHour.resetsAt) : Number.NaN;
    const resumeAtMs = Number.isFinite(resetMs) ? resetMs + this.config.resetGraceMs : null;
    const checkpoint = this.createCheckpoint(payload, resumeAtMs);
    const automationPrompt = [
      `Resume the Codex task from quota-guard checkpoint ${checkpoint.id}.`,
      "Before doing any work, call quota_status.",
      "If quota is unavailable, exhausted, or still recommends checkpoint_and_defer, do not start work; call defer_until_reset again.",
      `Then call checkpoint_get for workspace ${JSON.stringify(checkpoint.workspaceRoot)} and checkpointId ${checkpoint.id}.`,
      "Continue from the recorded pending items, verify repository state first, and do not repeat completed work.",
    ].join(" ");
    return {
      checkpoint,
      resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString(),
      canSchedule: resumeAtMs !== null,
      automationPrompt,
      quota,
    };
  }

  private cachedStatus(
    snapshot: QuotaSnapshot,
    nextRefreshAtMs: number,
    stale: boolean,
    backoffUntilMs: number | null,
  ): QuotaSnapshot {
    return {
      ...snapshot,
      nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
      stale,
      refreshInProgress: this.store.hasActiveLease(this.key, this.now()),
      backoffUntil: iso(backoffUntilMs),
      source: "cache",
    };
  }
}

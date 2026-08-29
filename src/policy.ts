import type {
  JobClass,
  JobPreflightResult,
  QuotaRecommendation,
  QuotaSnapshot,
  QuotaWindow,
  RawRateLimitSnapshot,
  RawRateLimitWindow,
  RawRateLimitsResponse,
} from "./types.js";
import type { GuardConfig } from "./config.js";

const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeWindow(raw: RawRateLimitWindow | null | undefined): QuotaWindow | null {
  if (!raw) return null;
  const used = asFiniteNumber(raw.usedPercent);
  const duration = asFiniteNumber(raw.windowDurationMins);
  if (used === null || duration === null || duration <= 0) return null;

  const usedPercent = Math.min(100, Math.max(0, Math.round(used)));
  const resetSeconds = asFiniteNumber(raw.resetsAt);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: Math.round(duration),
    resetsAt: resetSeconds !== null && resetSeconds > 0
      ? new Date(resetSeconds * 1_000).toISOString()
      : null,
  };
}

function chooseSnapshot(raw: RawRateLimitsResponse): RawRateLimitSnapshot {
  if (raw.rateLimits) return raw.rateLimits;
  const buckets = raw.rateLimitsByLimitId ? Object.values(raw.rateLimitsByLimitId) : [];
  return buckets.find((bucket) => {
    const windows = [bucket.primary, bucket.secondary];
    return windows.some((window) => window?.windowDurationMins === FIVE_HOUR_MINUTES);
  }) ?? buckets[0] ?? {};
}

export interface NormalizedRateLimits {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export function normalizeRateLimits(raw: RawRateLimitsResponse): NormalizedRateLimits {
  const snapshot = chooseSnapshot(raw);
  const windows = [normalizeWindow(snapshot.primary), normalizeWindow(snapshot.secondary)].filter(
    (window): window is QuotaWindow => window !== null,
  );
  return {
    fiveHour: windows.find((window) => window.windowDurationMins === FIVE_HOUR_MINUTES) ?? null,
    weekly: windows.find((window) => window.windowDurationMins === WEEKLY_MINUTES) ?? null,
    planType: typeof snapshot.planType === "string" ? snapshot.planType : null,
    rateLimitReachedType: typeof snapshot.rateLimitReachedType === "string"
      ? snapshot.rateLimitReachedType
      : null,
  };
}

export function recommendationFor(
  fiveHour: QuotaWindow | null,
  rateLimitReachedType: string | null,
  config: GuardConfig,
): QuotaRecommendation {
  if (rateLimitReachedType || !fiveHour) return rateLimitReachedType ? "checkpoint_and_defer" : "caution";
  if (fiveHour.remainingPercent <= config.deferRemainingPercent) return "checkpoint_and_defer";
  if (fiveHour.remainingPercent <= config.warningRemainingPercent) return "caution";
  return "continue";
}

export function ttlForWindow(fiveHour: QuotaWindow | null, nowMs: number, config: GuardConfig): number {
  if (!fiveHour) return config.ttlMs.warning;
  const remaining = fiveHour.remainingPercent;
  if (remaining <= 0 && fiveHour.resetsAt) {
    const resetMs = Date.parse(fiveHour.resetsAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs) return Math.max(config.ttlMs.low, resetMs + config.resetGraceMs - nowMs);
  }
  if (remaining > 50) return config.ttlMs.high;
  if (remaining > 20) return config.ttlMs.medium;
  if (remaining > 10) return config.ttlMs.warning;
  return config.ttlMs.low;
}

export function preflightJob(snapshot: QuotaSnapshot, jobClass: JobClass): JobPreflightResult {
  const remaining = snapshot.fiveHour?.remainingPercent ?? null;
  const exhausted = snapshot.rateLimitReachedType !== null || remaining === 0;
  const unknown = snapshot.fiveHour === null;
  const lowStale = snapshot.stale && remaining !== null && remaining <= 20;

  if (exhausted) {
    return {
      decision: "defer",
      reason: "The five-hour Codex window is exhausted or the backend reports a reached limit.",
      requiredAction: "Create a checkpoint and defer until the reported reset time.",
      quota: snapshot,
    };
  }
  if ((unknown || lowStale) && jobClass === "long") {
    return {
      decision: "defer",
      reason: unknown
        ? "The current five-hour quota is unavailable."
        : "The last low-quota snapshot is stale.",
      requiredAction: "Do not start long work; checkpoint or wait for a fresh shared snapshot.",
      quota: snapshot,
    };
  }
  if (remaining !== null && remaining <= 10 && jobClass === "long") {
    return {
      decision: "defer",
      reason: `Only ${remaining}% of the five-hour quota remains.`,
      requiredAction: "Create a checkpoint before starting another long job.",
      quota: snapshot,
    };
  }
  if (snapshot.recommendation !== "continue" || jobClass === "long" && remaining !== null && remaining <= 20) {
    return {
      decision: "caution",
      reason: remaining === null
        ? "Quota could not be confirmed. Small work may continue conservatively."
        : `${remaining}% of the five-hour quota remains; keep the next step bounded and resumable.`,
      requiredAction: jobClass === "small" ? null : "Checkpoint before the next expensive boundary.",
      quota: snapshot,
    };
  }
  return { decision: "allow", reason: "Shared quota snapshot allows this job class.", requiredAction: null, quota: snapshot };
}

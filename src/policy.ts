import type { GuardConfig } from "./config.js";
import type {
  CreditsSnapshot,
  IndividualLimitSnapshot,
  JobClass,
  JobPreflightResult,
  PolicyProfile,
  QuotaBucket,
  QuotaPath,
  QuotaRecommendation,
  QuotaSnapshot,
  QuotaWindow,
  RawRateLimitSnapshot,
  RawRateLimitWindow,
  RawRateLimitsResponse,
  QuotaLaneId,
} from "./types.js";

const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;
const FLEXIBLE_PLANS = new Set([
  "self_serve_business_usage_based",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
]);
const PRO_PLANS = new Set(["pro", "prolite"]);
const FREE_GO_PLANS = new Set(["free", "go"]);
const STANDARD_PLANS = new Set([
  "plus", "team", "self_serve_business_prolite", "business", "ent26", "enterprise", "edu",
]);

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function laneMetadata(raw: RawRateLimitSnapshot, key: string | null): QuotaLaneId {
  // Observed app-server quota identifier, independent of display/model names.
  // Unknown non-default buckets remain informational, never interchangeable.
  const bucketId = asString(raw.limitId) ?? key;
  if (bucketId === "base_model_inference") return "secondary";
  return "unknown";
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
    resetsAt: resetSeconds !== null && resetSeconds > 0 ? new Date(resetSeconds * 1_000).toISOString() : null,
  };
}

function normalizeCredits(raw: RawRateLimitSnapshot["credits"]): CreditsSnapshot | null {
  if (!raw || typeof raw.hasCredits !== "boolean" || typeof raw.unlimited !== "boolean") return null;
  return {
    hasCredits: raw.hasCredits,
    unlimited: raw.unlimited,
    balance: typeof raw.balance === "string" ? raw.balance : null,
  };
}

function normalizeIndividualLimit(raw: RawRateLimitSnapshot["individualLimit"]): IndividualLimitSnapshot | null {
  if (!raw) return null;
  const remaining = asFiniteNumber(raw.remainingPercent);
  const resetSeconds = asFiniteNumber(raw.resetsAt);
  if (typeof raw.limit !== "string" || typeof raw.used !== "string" || remaining === null) {
    throw new Error("Cannot safely normalize the reported individual spend limit");
  }
  return {
    limit: raw.limit,
    used: raw.used,
    remainingPercent: Math.min(100, Math.max(0, Math.round(remaining))),
    resetsAt: resetSeconds !== null && resetSeconds > 0 ? new Date(resetSeconds * 1_000).toISOString() : null,
  };
}

export function normalizeBucket(raw: RawRateLimitSnapshot, key: string | null = null): QuotaBucket {
  // A malformed reported 5h window must not become apparent weekly-only capability.
  for (const window of [raw.primary, raw.secondary]) {
    if (window != null && normalizeWindow(window) === null) throw new Error("Invalid reported quota window");
  }
  const windows = [normalizeWindow(raw.primary), normalizeWindow(raw.secondary)].filter(
    (window): window is QuotaWindow => window !== null,
  );
  const laneId = laneMetadata(raw, key);
  return {
    limitId: asString(raw.limitId) ?? key,
    limitName: asString(raw.limitName),
    planType: asString(raw.planType),
    fiveHour: windows.find((window) => window.windowDurationMins === FIVE_HOUR_MINUTES) ?? null,
    weekly: windows.find((window) => window.windowDurationMins === WEEKLY_MINUTES) ?? null,
    longWindows: windows.filter((window) => window.windowDurationMins > FIVE_HOUR_MINUTES),
    credits: normalizeCredits(raw.credits),
    individualLimit: normalizeIndividualLimit(raw.individualLimit),
    spendControlReached: typeof raw.spendControlReached === "boolean" ? raw.spendControlReached : null,
    rateLimitReachedType: asString(raw.rateLimitReachedType),
    laneId,
  };
}

export interface NormalizedRateLimits {
  activeBucket: QuotaBucket;
  buckets: Record<string, QuotaBucket>;
  laneBuckets: Partial<Record<QuotaLaneId, QuotaBucket>>;
}

export function normalizeRateLimits(raw: RawRateLimitsResponse): NormalizedRateLimits {
  const activeBucket = normalizeBucket(raw.rateLimits ?? {});
  if (activeBucket.laneId === "unknown") activeBucket.laneId = "primary";
  const buckets: Record<string, QuotaBucket> = {};
  for (const [key, value] of Object.entries(raw.rateLimitsByLimitId ?? {})) {
    buckets[key] = normalizeBucket(value, key);
  }
  const activeKey = activeBucket.limitId ?? "active";
  buckets[activeKey] = activeBucket;
  const laneBuckets: Partial<Record<QuotaLaneId, QuotaBucket>> = {};
  // The active/default bucket is the primary lane unless the backend explicitly labels it secondary.
  laneBuckets[activeBucket.laneId] = activeBucket;
  for (const bucket of Object.values(buckets)) {
    if (bucket.laneId === "secondary" && bucket.limitId !== activeBucket.limitId) laneBuckets.secondary = bucket;
  }
  return { activeBucket, buckets, laneBuckets };
}

export function planGroupFor(planType: string | null): PolicyProfile["planGroup"] {
  const normalized = planType?.toLocaleLowerCase() ?? "unknown";
  if (FREE_GO_PLANS.has(normalized)) return "free_go";
  if (PRO_PLANS.has(normalized)) return "pro";
  if (FLEXIBLE_PLANS.has(normalized)) return "flexible";
  if (STANDARD_PLANS.has(normalized)) return "standard";
  return "unknown";
}

export function baselineForPlan(planType: string | null, config: GuardConfig): number {
  switch (planGroupFor(planType)) {
    case "free_go": return config.planDefaults.freeGo;
    case "pro": return config.planDefaults.pro;
    case "standard":
    case "flexible": return config.planDefaults.standard;
    case "unknown": return config.planDefaults.unknown;
  }
}

export function buildPolicyProfile(
  planType: string | null,
  learnedMeanPercent: number | null,
  sampleCount: number,
  userOverridePercent: number,
  jobClass: JobClass | null,
  config: GuardConfig,
  weeklyOnly = false,
): PolicyProfile {
  if (weeklyOnly) { learnedMeanPercent = null; sampleCount = 0; }
  const baseline = weeklyOnly ? config.weeklyOnlyRemainingPercent : baselineForPlan(planType, config);
  const ready = learnedMeanPercent !== null && sampleCount >= config.minSamples;
  const automatic = ready && learnedMeanPercent !== null
    ? Math.max(baseline, Math.ceil(learnedMeanPercent * config.safetyFactor))
    : baseline;
  return {
    policyMode: weeklyOnly ? "weekly_only" : "adaptive",
    planGroup: planGroupFor(planType),
    baselineRemainingPercent: baseline,
    learnedMeanPercent,
    sampleCount,
    confidence: ready ? "ready" : sampleCount > 0 ? "low" : "cold_start",
    userOverridePercent,
    automaticThresholdPercent: automatic,
    effectiveThresholdPercent: Math.min(config.maxThreshold, Math.max(1, automatic + userOverridePercent)),
    jobClass,
  };
}

export function creditsUsable(bucket: QuotaBucket | null): boolean {
  if (!bucket?.credits || (!bucket.credits.hasCredits && !bucket.credits.unlimited)) return false;
  if (bucket.spendControlReached === true) return false;
  if (bucket.individualLimit && bucket.individualLimit.remainingPercent <= 0) return false;
  return bucket.rateLimitReachedType === null || bucket.rateLimitReachedType === "rate_limit_reached";
}

export function allowanceWindow(bucket: QuotaBucket | null): QuotaWindow | null {
  return bucket?.fiveHour ?? bucket?.longWindows.slice().sort((a, b) => a.windowDurationMins - b.windowDurationMins)[0] ?? null;
}

/** Observed primary weekly-only allowance, not a missing/unknown quota response. */
export function isWeeklyOnly(bucket: QuotaBucket | null): boolean {
  return bucket?.laneId === "primary" && bucket.fiveHour === null && bucket.weekly !== null
    && bucket.longWindows.length === 1 && bucket.longWindows[0]?.windowDurationMins === WEEKLY_MINUTES;
}

function weeklyControlsClear(bucket: QuotaBucket): boolean {
  return bucket.spendControlReached !== true && bucket.individualLimit?.remainingPercent !== 0
    && (bucket.rateLimitReachedType === null || bucket.rateLimitReachedType === "rate_limit_reached");
}

export function weeklyResetSoon(bucket: QuotaBucket, config: GuardConfig, nowMs: number): boolean {
  const reset = Date.parse(bucket.weekly?.resetsAt ?? "");
  const wait = reset + config.resetGraceMs - nowMs;
  // The user requests strictly under24h; include grace so the actual wake fits.
  return Number.isFinite(reset) && reset > nowMs && wait > 0 && wait < config.maxAutomationWaitMs;
}

function includedUsable(bucket: QuotaBucket | null, threshold: number): boolean {
  if (!bucket || (!bucket.fiveHour && bucket.laneId !== "secondary" && !isWeeklyOnly(bucket))) return false;
  const allowance = allowanceWindow(bucket);
  if (!allowance || allowance.remainingPercent <= threshold) return false;
  if (bucket.longWindows.some((window) => window.remainingPercent <= 0)) return false;
  if (bucket.spendControlReached === true || bucket.individualLimit?.remainingPercent === 0) return false;
  return bucket.rateLimitReachedType === null;
}

export function quotaPathFor(bucket: QuotaBucket | null, threshold: number, config?: GuardConfig, nowMs = Date.now()): QuotaPath {
  if (includedUsable(bucket, threshold)) return "included";
  if (creditsUsable(bucket)) return "credits";
  if (bucket && isWeeklyOnly(bucket) && weeklyControlsClear(bucket)
    && config && !weeklyResetSoon(bucket, config, nowMs)) return "weekly_advisory";
  return "unavailable";
}

export function recommendationFor(bucket: QuotaBucket | null, profile: PolicyProfile, config: GuardConfig, nowMs = Date.now()): QuotaRecommendation {
  const path = quotaPathFor(bucket, profile.effectiveThresholdPercent, config, nowMs);
  if (path === "unavailable") return "checkpoint_and_defer";
  if (path === "credits" || path === "weekly_advisory") return "caution";
  const remaining = allowanceWindow(bucket)?.remainingPercent ?? 0;
  return remaining <= profile.effectiveThresholdPercent + config.cautionMarginPercent ? "caution" : "continue";
}

export function ttlForWindow(fiveHour: QuotaWindow | null, nowMs: number, config: GuardConfig): number {
  if (!fiveHour) return config.ttlMs.warning;
  const remaining = fiveHour.remainingPercent;
  if (remaining <= 0 && fiveHour.resetsAt) {
    const resetMs = Date.parse(fiveHour.resetsAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      return Math.max(config.ttlMs.low, resetMs + config.resetGraceMs - nowMs);
    }
  }
  if (remaining > 50) return config.ttlMs.high;
  if (remaining > 20) return config.ttlMs.medium;
  if (remaining > 10) return config.ttlMs.warning;
  return config.ttlMs.low;
}

export function preflightJob(snapshot: QuotaSnapshot, jobClass: JobClass, config: GuardConfig): JobPreflightResult {
  return preflightLane(snapshot, jobClass, config, "primary");
}

export function preflightLane(snapshot: QuotaSnapshot, jobClass: JobClass, config: GuardConfig, laneId: QuotaLaneId, nowMs = Date.now()): JobPreflightResult {
  const lane = snapshot.lanes[laneId];
  if (snapshot.stale || snapshot.refreshInProgress || (laneId === "secondary" && jobClass !== "small")) {
    return {
      decision: "defer", reason: snapshot.stale || snapshot.refreshInProgress
        ? "Quota is stale or being refreshed; no new admission is safe on either role."
        : "The secondary role is reserved for small, lightweight work. Keep the primary task deferred.",
      requiredAction: "Save a checkpoint and inspect the selected role again at its next permitted refresh.",
      admissionRecorded: false, quotaPath: "unavailable", mayConsumeCredits: false,
      thresholdPercent: lane?.profile.effectiveThresholdPercent ?? snapshot.profile.effectiveThresholdPercent,
      quota: snapshot, laneId,
    };
  }
  if (!lane || !lane.available || !lane.bucket) {
    return {
      decision: "defer", reason: `The requested ${laneId} quota lane is not explicitly available from app-server.`,
      requiredAction: "Keep the primary task deferred and retry only after quota_status detects this lane.",
      admissionRecorded: false, quotaPath: "unavailable", mayConsumeCredits: false,
      thresholdPercent: snapshot.profile.effectiveThresholdPercent, quota: snapshot,
      laneId,
    };
  }
  const bucket = lane.bucket;
  const profile = lane.profile;
  const path = quotaPathFor(bucket, profile.effectiveThresholdPercent, config, nowMs);
  const remaining = allowanceWindow(bucket)?.remainingPercent ?? null;
  if (path === "weekly_advisory") {
    return {
      decision: "caution", reason: `Weekly quota is near exhaustion (${remaining}% remaining); no confirmed reset under24h. Guard admission is warning-only, not proof of backend allowance.`,
      requiredAction: "May continue without a Guard-imposed stop or automation. Backend quota limits still apply; checkpointing is optional for this warning.",
      admissionRecorded: false, quotaPath: path, mayConsumeCredits: false,
      thresholdPercent: profile.effectiveThresholdPercent, quota: snapshot, laneId,
    };
  }
  if (path === "unavailable") {
    return {
      decision: "defer",
      reason: remaining === null
        ? "No usable fixed or credit-backed Codex allowance is currently available."
        : `Only ${remaining}% of the selected allowance remains and no runtime credit bypass is usable.`,
      requiredAction: "Create a checkpoint and defer according to the reported blocking reset.",
      admissionRecorded: false,
      quotaPath: path,
      mayConsumeCredits: false,
      thresholdPercent: profile.effectiveThresholdPercent,
      quota: snapshot,
      laneId,
    };
  }
  if (path === "credits") {
    return {
      decision: "caution",
      reason: "Included allowance is blocked or below the learned threshold; runtime credits can admit this job.",
      requiredAction: "Proceed only with awareness that this job may consume purchased or workspace credits.",
      admissionRecorded: false,
      quotaPath: path,
      mayConsumeCredits: true,
      thresholdPercent: profile.effectiveThresholdPercent,
      quota: snapshot,
      laneId,
    };
  }
  const caution = remaining !== null
    && remaining <= profile.effectiveThresholdPercent + config.cautionMarginPercent;
  return {
    decision: caution ? "caution" : "allow",
    reason: caution
      ? `${remaining}% remains, close to the ${profile.effectiveThresholdPercent}% learned admission threshold.`
      : `The selected included allowance admits this ${jobClass} job.`,
    requiredAction: caution ? isWeeklyOnly(bucket)
      ? "Weekly quota warning only; may continue. No checkpoint or automation is required for this warning."
      : "Keep the job bounded and resumable." : null,
    admissionRecorded: false,
    quotaPath: path,
    mayConsumeCredits: false,
    thresholdPercent: profile.effectiveThresholdPercent,
    quota: snapshot,
    laneId,
  };
}

import type { JobPreflightResult, QuotaLaneStatus, QuotaSnapshot, QuotaWindow } from "./types.js";

type CompactLane = Pick<QuotaLaneStatus, "available" | "reason"> & Partial<QuotaLaneStatus> & { quotaRef?: "root" };

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const shortWindow = (window: QuotaWindow | null) => window
  ? { remainingPercent: window.remainingPercent, resetsAt: window.resetsAt } : null;
const floorMinutes = (value: number | undefined) => value === undefined ? undefined : Math.floor(value * 1_000) / 1_000;

/** Action-oriented view. Diagnostics and learning samples remain available through detail=full. */
export function summaryQuota(snapshot: QuotaSnapshot, preflight = false) {
  const reset = snapshot.resetCredit;
  return {
    ...(!preflight ? { format: "summary-v1" } : {}),
    planType: snapshot.planType,
    fiveHour: shortWindow(snapshot.fiveHour), weekly: shortWindow(snapshot.weekly),
    ...(snapshot.longWindows.some(w => !same(w, snapshot.weekly)) ? {
      longWindows: snapshot.longWindows.filter(w => !same(w, snapshot.weekly)).map(w => ({
        ...shortWindow(w), windowDurationMins: w.windowDurationMins,
      })),
    } : {}),
    stale: snapshot.stale, refreshInProgress: snapshot.refreshInProgress,
    ...(!preflight ? {
      recommendation: snapshot.recommendation, quotaPath: snapshot.quotaPath, mayConsumeCredits: snapshot.mayConsumeCredits,
      checkAgainBy: snapshot.checkAgainBy, nextRefreshAt: snapshot.nextRefreshAt,
      policyMode: snapshot.profile.policyMode, thresholdPercent: snapshot.profile.effectiveThresholdPercent,
      pacing: snapshot.pacing?.primary ? {
        confidence: snapshot.pacing.primary.confidence,
        maxSegmentMinutes: floorMinutes(snapshot.pacing.primary.maxSegmentMinutes),
      } : null,
    } : {}),
    lanes: Object.fromEntries(Object.entries(snapshot.lanes).map(([id, lane]) => [id,
      !lane.available ? { available: false } : same(lane.bucket, snapshot.activeBucket) ? { available: true }
        : { available: true, fiveHour: shortWindow(lane.bucket?.fiveHour ?? null),
          weekly: shortWindow(lane.bucket?.weekly ?? null), recommendation: lane.recommendation,
          quotaPath: lane.quotaPath, mayConsumeCredits: lane.mayConsumeCredits,
          thresholdPercent: lane.profile.effectiveThresholdPercent,
          // Preserve every distinct secondary/individual constraint, even when it exceeds the size target.
          longWindows: lane.bucket?.longWindows.filter(w => !same(w, lane.bucket?.weekly)),
          individualLimit: lane.bucket?.individualLimit,
          checkAgainBy: snapshot.pacing?.[id as keyof typeof snapshot.lanes]?.checkAgainBy,
        },
    ])),
    ...(snapshot.activeBucket?.individualLimit ? { individualLimit: snapshot.activeBucket.individualLimit } : {}),
    ...(snapshot.activeBucket?.spendControlReached ? { spendControlReached: true } : {}),
    ...(snapshot.rateLimitReachedType ? { rateLimitReachedType: snapshot.rateLimitReachedType } : {}),
    ...(snapshot.mayConsumeCredits ? { credits: snapshot.activeBucket?.credits } : {}),
    resetCredit: {
      enabled: reset.enabled, availableCount: reset.availableCount,
      ...(reset.recommendation ? { recommendation: reset.recommendation } : {}),
      ...(reset.verification !== "not_requested" ? { verification: reset.verification, reason: reset.reason } : {}),
    },
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.backoffUntil ? { backoffUntil: snapshot.backoffUntil } : {}),
    ...(preflight ? { nextRefreshAt: snapshot.nextRefreshAt } : {}),
  };
}

export function summaryPreflight(value: JobPreflightResult) {
  const { quota, reason, requiredAction, maxSegmentMinutes, ...actions } = value;
  return {
    format: "summary-v1", ...actions,
    ...(value.decision !== "allow" || value.canStartSegment === false ? { reason } : {}),
    ...(requiredAction ? { requiredAction } : {}),
    maxSegmentMinutes: floorMinutes(maxSegmentMinutes),
    quota: summaryQuota(quota, true),
  };
}

/** Presentation only: never mutate the snapshot used by policy, cache or reset reconciliation. */
export function compactQuota(snapshot: QuotaSnapshot) {
  const { activeBucket, buckets, lanes, pacing, longWindows, ...shared } = snapshot;
  const otherBuckets = Object.fromEntries(Object.entries(buckets).filter(([, bucket]) =>
    !same(bucket, activeBucket) && !Object.values(lanes).some(lane => same(lane.bucket, bucket))));
  return {
    format: "compact-v1",
    ...shared,
    // The active windows/profile already exist at the top level.
    longWindows: longWindows.filter(window => !same(window, snapshot.weekly)),
    limits: activeBucket ? {
      limitId: activeBucket.limitId, limitName: activeBucket.limitName,
      credits: activeBucket.credits, individualLimit: activeBucket.individualLimit,
      spendControlReached: activeBucket.spendControlReached,
    } : null,
    lanes: Object.fromEntries(Object.entries(lanes).map(([id, lane]): [string, CompactLane] => {
      if (!lane.available) return [id, { available: false, reason: lane.reason }];
      const { bucket, window, profile, ...state } = lane;
      return [id, {
        ...state,
        ...(same(profile, snapshot.profile) ? {} : { profile }),
        ...(same(bucket, activeBucket) ? { quotaRef: "root" } : { bucket }),
        // Preserve a distinct allowance if a future normalizer provides one.
        ...(!same(window, bucket?.fiveHour) && !same(window, bucket?.weekly) && window !== null ? { window } : {}),
      }];
    })),
    ...(pacing ? { pacing: Object.fromEntries(Object.entries(pacing).filter(([id]) =>
      lanes[id as keyof typeof lanes]?.available)) } : {}),
    ...(Object.keys(otherBuckets).length ? { otherBuckets } : {}),
  };
}

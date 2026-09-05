import type { QuotaLaneStatus, QuotaSnapshot } from "./types.js";

type CompactLane = Pick<QuotaLaneStatus, "available" | "reason"> & Partial<QuotaLaneStatus> & { quotaRef?: "root" };

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

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

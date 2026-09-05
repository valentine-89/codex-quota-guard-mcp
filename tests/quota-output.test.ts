import assert from "node:assert/strict";
import test from "node:test";
import { compactQuota } from "../src/quota-output.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

test("compact quota keeps decisions, reset proofs, distinct limits and secondary quota", async () => {
  const store = new StateStore(":memory:");
  const config = testConfig("/tmp/unused-quota-output.sqlite");
  config.automaticWeeklyReset.enabled = true;
  const now = 1_700_000_000_000;
  const service = new QuotaGuardService(config, store, { readQuota: async () => rawQuota(50,
    (now + 4 * 86_400_000) / 1_000, {
      weeklyUsed: 98, secondaryReserveUsed: 30,
      credits: { hasCredits: true, unlimited: false, balance: "5" },
      individualLimit: { remainingPercent: 10, resetsAt: (now + 86_400_000) / 1_000 },
      resetCredits: [{ id: "fixture", expiresAt: (now + 10 * 86_400_000) / 1_000 }],
    }) }, { now: () => now });
  try {
    const full = await service.quotaStatusForRequest();
    // Include an additional mandatory window and a diagnostic-only bucket.
    const extra = { usedPercent: 80, remainingPercent: 20, windowDurationMins: 43_200,
      resetsAt: new Date(now + 30 * 86_400_000).toISOString() };
    full.longWindows.push(extra);
    full.buckets.extra = { ...full.activeBucket!, limitId: "extra", limitName: "Other allowance" };
    const before = structuredClone(full);
    const compact = compactQuota(full);
    assert.deepEqual(full, before, "presentation must not mutate the cached snapshot");
    for (const field of ["fiveHour", "weekly", "profile", "recommendation", "quotaPath", "mayConsumeCredits",
      "rateLimitReachedType", "stale", "refreshInProgress", "error", "backoffUntil", "fetchedAt", "nextRefreshAt",
      "checkAgainBy", "resetCredit"] as const) assert.deepEqual(compact[field], full[field], field);
    assert.ok(compact.resetCredit.recommendation);
    assert.equal(compact.resetCredit.recommendation.idempotencyKey, full.resetCredit.recommendation!.idempotencyKey);
    assert.deepEqual(compact.longWindows, [extra]);
    assert.deepEqual(compact.limits?.credits, full.activeBucket!.credits);
    assert.deepEqual(compact.limits?.individualLimit, full.activeBucket!.individualLimit);
    assert.deepEqual(compact.otherBuckets?.extra, full.buckets.extra);
    assert.deepEqual(compact.lanes.secondary?.bucket, full.lanes.secondary!.bucket);
    assert.deepEqual(compact.pacing?.secondary, full.pacing!.secondary);
    const unavailable = compactQuota({ ...full, stale: true, error: { code: "SERVER_FAILED", message: "Unavailable" },
      backoffUntil: new Date(now + 60_000).toISOString() });
    assert.equal(unavailable.stale, true);
    assert.equal(unavailable.error?.code, "SERVER_FAILED");
    assert.ok(unavailable.backoffUntil);
  } finally { store.close(); }
});

test("typical compact quota removes at least 35 percent of serialized snapshot characters", async () => {
  const store = new StateStore(":memory:");
  const service = new QuotaGuardService(testConfig("/tmp/unused-quota-output.sqlite"), store,
    { readQuota: async () => rawQuota(25) }, { now: () => 1_000 });
  try {
    const full = await service.quotaStatusForRequest();
    const compact = compactQuota(full);
    assert.equal(compact.lanes.secondary?.available, false);
    assert.equal(compact.pacing?.secondary, undefined);
    const oldSize = JSON.stringify(full).length, newSize = JSON.stringify(compact).length;
    assert.ok(newSize < oldSize * 0.65, `${oldSize} -> ${newSize}`);
  } finally { store.close(); }
});

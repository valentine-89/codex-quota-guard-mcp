import assert from "node:assert/strict";
import test from "node:test";
import { compactQuota, summaryPreflight, summaryQuota } from "../src/quota-output.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

test("summary uses active secondary pacing and retains secondary billing constraints", async () => {
  for (const activeSecondary of [false, true]) {
    const store = new StateStore(":memory:");
    const raw = rawQuota(20, 2_000_000_000, { secondaryReserveUsed: 100,
      ...(activeSecondary ? { limitId: "base_model_inference" } : {}) });
    const secondary = raw.rateLimits.rateLimitsByLimitId!.base_model_inference!;
    secondary.spendControlReached = true;
    secondary.rateLimitReachedType = "spend_limit";
    secondary.credits = { hasCredits: true, unlimited: false, balance: "7" };
    const service = new QuotaGuardService(testConfig("/tmp/unused-output.sqlite"), store,
      { readQuota: async () => raw }, { now: () => 1_000 });
    try {
      const full = await service.quotaStatusForRequest();
      const brief = summaryQuota(full);
      const active = full.pacing![full.activeBucket!.laneId]!;
      assert.equal(brief.pacing?.confidence, active.confidence);
      assert.equal(brief.pacing?.maxSegmentMinutes, active.maxSegmentMinutes);
      if (!activeSecondary) {
        assert.ok(brief.lanes.secondary && "spendControlReached" in brief.lanes.secondary);
        assert.equal(brief.lanes.secondary.spendControlReached, true);
        assert.equal(brief.lanes.secondary.rateLimitReachedType, "spend_limit");
        const creditLane = structuredClone(full);
        creditLane.lanes.secondary!.mayConsumeCredits = true;
        creditLane.lanes.secondary!.quotaPath = "credits";
        const creditSummary = summaryQuota(creditLane).lanes.secondary;
        assert.ok(creditSummary && "credits" in creditSummary);
        assert.deepEqual(creditSummary.credits, full.lanes.secondary!.bucket!.credits);
      }
    } finally { store.close(); }
  }
});

test("summary preserves service admission actions across quota and failure scenarios", async () => {
  const decisions = new Set<string>();
  for (const scenario of ["allow", "caution", "defer", "split", "weekly", "secondary", "credits", "failure"]) {
    const store = new StateStore(":memory:");
    const raw = rawQuota(scenario === "caution" ? 87 : ["defer", "credits"].includes(scenario) ? 100 : 20,
      2_000_000_000, { secondaryReserveUsed: 20,
        ...(scenario === "credits" ? { credits: { hasCredits: true, unlimited: false, balance: "5" } } : {}) });
    if (scenario === "weekly") raw.rateLimits.rateLimits!.primary = null;
    const service = new QuotaGuardService(testConfig("/tmp/unused-output.sqlite"), store, {
      readQuota: async () => { if (scenario === "failure") throw Error("fixture failure"); return raw; },
    }, { now: () => 1_000 });
    try {
      const full = await service.jobPreflight({ jobId: scenario, taskId: "fixture", workspaceRoot: "/tmp",
        jobClass: "small", description: scenario, laneId: scenario === "secondary" ? "secondary" : "primary",
        ...(scenario === "split" ? { estimatedMinutes: 10 } : {}) });
      const before = structuredClone(full);
      const summary = summaryPreflight(full);
      decisions.add(full.decision);
      for (const [key, value] of Object.entries(full).filter(([key]) =>
        !["quota", "reason", "requiredAction", "maxSegmentMinutes"].includes(key))) {
        assert.deepEqual(Reflect.get(summary, key), value, `${scenario}:${key}`);
      }
      if (full.decision !== "allow" || full.canStartSegment === false) assert.equal(summary.reason, full.reason);
      if (full.requiredAction) assert.equal(summary.requiredAction, full.requiredAction);
      assert.ok(summary.maxSegmentMinutes! <= full.maxSegmentMinutes!);
      assert.equal(summary.quota.stale, full.quota.stale);
      assert.deepEqual(summary.quota.error, full.quota.error ?? undefined);
      assert.deepEqual(full, before);
      for (const output of [summary, summary.quota, summaryQuota(full.quota), compactQuota(full.quota)]) {
        assert.equal(Object.hasOwn(output, "format"), false);
      }
    } finally { store.close(); }
  }
  assert.deepEqual([...decisions].sort(), ["allow", "caution", "defer"]);
});

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
    const brief = summaryQuota(full);
    assert.deepEqual(brief.resetCredit.recommendation, full.resetCredit.recommendation);
    assert.deepEqual(brief.individualLimit, full.activeBucket!.individualLimit);
    assert.ok(brief.lanes.secondary && "weekly" in brief.lanes.secondary);
    assert.deepEqual(brief.lanes.secondary.weekly, {
      remainingPercent: full.lanes.secondary!.bucket!.weekly!.remainingPercent,
      resetsAt: full.lanes.secondary!.bucket!.weekly!.resetsAt,
    });
    assert.equal(brief.longWindows?.[0]?.windowDurationMins, extra.windowDurationMins);
    const failed = summaryQuota({ ...full, stale: true, backoffUntil: unavailable.backoffUntil, error: unavailable.error });
    assert.equal(failed.error?.code, "SERVER_FAILED");
    assert.equal(failed.backoffUntil, unavailable.backoffUntil);
    assert.equal(failed.stale, true);
    const credit = summaryQuota({ ...full, mayConsumeCredits: true, quotaPath: "credits",
      activeBucket: { ...full.activeBucket!, spendControlReached: true }, rateLimitReachedType: "spend_limit" });
    assert.equal(credit.mayConsumeCredits, true);
    assert.deepEqual(credit.credits, full.activeBucket!.credits);
    assert.equal(credit.spendControlReached, true);
    assert.equal(credit.rateLimitReachedType, "spend_limit");
  } finally { store.close(); }
});

test("weekly-only preflight summary fits 1KB even formatted, without losing action fields", async () => {
  const store = new StateStore(":memory:");
  const raw = rawQuota(0, 2_000_000_000, { weeklyUsed: 13 });
  raw.rateLimits.rateLimits!.primary = null;
  const service = new QuotaGuardService(testConfig("/tmp/unused-quota-output.sqlite"), store,
    { readQuota: async () => raw }, { now: () => 1_000 });
  try {
    const full = await service.jobPreflight({ jobId: "fixture", taskId: "fixture", workspaceRoot: "/tmp",
      jobClass: "small", description: "Synthetic weekly-only work" });
    const before = structuredClone(full);
    const summary = summaryPreflight(full);
    assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) <= 1_024);
    for (const field of ["decision", "canStartSegment", "validUntil", "checkAgainBy", "checkpointRequired",
      "mayConsumeCredits", "quotaPath", "admissionRecorded", "laneId"] as const) assert.deepEqual(summary[field], full[field]);
    assert.ok(summary.maxSegmentMinutes! <= full.maxSegmentMinutes!);
    assert.equal(summary.quota.nextRefreshAt, full.quota.nextRefreshAt);
    assert.deepEqual(full, before);
    const blocked = summaryPreflight({ ...full, decision: "caution", canStartSegment: false,
      reason: "Split required", requiredAction: "Save progress and split the segment" });
    assert.equal(blocked.canStartSegment, false);
    assert.equal(blocked.reason, "Split required");
    assert.equal(blocked.requiredAction, "Save progress and split the segment");
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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { automaticResetThresholdForPlan } from "../src/policy.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

const DAY = 86_400_000;

test("automatic reset thresholds separate Plus from free/Go and higher recognized plans", () => {
  const config = testConfig("C:\\test\\state.sqlite");
  assert.equal(automaticResetThresholdForPlan("free", config), 5);
  assert.equal(automaticResetThresholdForPlan("go", config), 5);
  assert.equal(automaticResetThresholdForPlan("plus", config), 2);
  for (const plan of ["pro", "prolite", "team", "business", "enterprise", "edu", "enterprise_cbp_usage_based"]) {
    assert.equal(automaticResetThresholdForPlan(plan, config), 1, plan);
  }
  assert.equal(automaticResetThresholdForPlan("future-plan", config), null);
});

function resetFixture(options: { remaining?: number; planType?: string; resetDistanceMs?: number; withCredits?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "quota-auto-reset-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const config = testConfig(join(directory, "state.sqlite"));
  config.automaticWeeklyReset.enabled = true;
  let now = 1_700_000_000_000;
  let reads = 0;
  const sleeps: number[] = [];
  const remaining = options.remaining ?? 2;
  const resetDistance = options.resetDistanceMs ?? 4 * DAY;
  const baseResetSeconds = (now + resetDistance) / 1_000 - 1_000;
  let propagated = false;
  const makeQuota = () => rawQuota(50, propagated ? baseResetSeconds + 604_800 : baseResetSeconds, {
    planType: options.planType ?? "plus", weeklyUsed: propagated ? 0 : 100 - remaining,
    ...(options.withCredits === false || propagated ? {} : { resetCredits: [{
      id: "reset-credit", expiresAt: (now + 10 * DAY) / 1_000,
    }] }),
  });
  const service = new QuotaGuardService(config, store, { readQuota: async () => { reads++; return makeQuota(); } }, {
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; if (sleeps.length === 2) propagated = true; },
  });
  return { directory, store, service, config, sleeps, reads: () => reads,
    advance(ms: number) { now += ms; },
    setPropagated(value: boolean) { propagated = value; }, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("recommendation is opt-in, threshold-inclusive, credit-backed, and strictly farther than 72 hours", async () => {
  for (const input of [
    { enabled: false, remaining: 2, distance: 4 * DAY, credits: true, expected: "disabled" },
    { enabled: true, remaining: 3, distance: 4 * DAY, credits: true, expected: "weekly_quota_above_threshold" },
    { enabled: true, remaining: 2, distance: 3 * DAY, credits: true, expected: "weekly_reset_within_72h" },
    { enabled: true, remaining: 2, distance: 3 * DAY + 1, credits: true, expected: "weekly_threshold_and_reset_far" },
    { enabled: true, remaining: 2, distance: 4 * DAY, credits: false, expected: "no_available_reset" },
  ]) {
    const f = resetFixture({ remaining: input.remaining, resetDistanceMs: input.distance, withCredits: input.credits });
    try {
      f.config.automaticWeeklyReset.enabled = input.enabled;
      const status = await f.service.quotaStatusForRequest();
      assert.equal(status.resetCredit.reason, input.expected);
      assert.equal(status.resetCredit.recommendation !== null, input.expected === "weekly_threshold_and_reset_far");
    } finally { f.close(); }
  }
});

test("cached reset recommendation expires at the exact horizon without refreshing quota", async () => {
  const f = resetFixture({ resetDistanceMs: 3 * DAY + 1_000 });
  try {
    assert.ok((await f.service.quotaStatusForRequest()).resetCredit.recommendation);
    f.advance(999);
    assert.ok((await f.service.quotaStatusForRequest()).resetCredit.recommendation);
    f.advance(1);
    for (const elapsed of [0, 1_000]) {
      f.advance(elapsed);
      const status = await f.service.quotaStatusForRequest();
      assert.equal(status.source, "cache");
      assert.equal(status.stale, false);
      assert.equal(status.resetCredit.recommendation, null);
      assert.equal(status.resetCredit.reason, "weekly_reset_within_72h");
    }
    assert.equal(f.reads(), 1);
  } finally { f.close(); }
});

test("missing reset-credit payload is safely normalized as zero available", async () => {
  const f = resetFixture({ withCredits: false });
  try {
    const status = await f.service.quotaStatusForRequest();
    assert.equal(status.resetCredit.availableCount, 0);
    assert.equal(status.resetCredit.recommendation, null);
  } finally { f.close(); }
});

test("expired, wrong-type, malformed, and unknown-plan reset inputs never recommend", async () => {
  const now = 1_700_000_000_000;
  const cases = [
    { planType: "plus", resetCredits: [{ id: "expired", expiresAt: now / 1_000 - 1 }] },
    { planType: "plus", resetCredits: [{ id: "wrong-type", resetType: "other", expiresAt: now / 1_000 + 10_000 }] },
    { planType: "plus", resetCredits: [{ id: "wrong-status", status: "used", expiresAt: now / 1_000 + 10_000 }] },
    { planType: "future-plan", resetCredits: [{ id: "valid", expiresAt: now / 1_000 + 10_000 }] },
  ];
  for (const item of cases) {
    const directory = mkdtempSync(join(tmpdir(), "quota-auto-reset-invalid-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const config = testConfig(join(directory, "state.sqlite"));
    config.automaticWeeklyReset.enabled = true;
    const service = new QuotaGuardService(config, store, { readQuota: async () => rawQuota(50,
      (now + 4 * DAY) / 1_000 - 1_000, { weeklyUsed: 98, planType: item.planType,
        resetCredits: item.resetCredits }) }, { now: () => now });
    try { assert.equal((await service.quotaStatusForRequest()).resetCredit.recommendation, null); }
    finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("a failed refresh removes cached recommendation and an account switch invalidates the old key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-auto-reset-stale-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const config = testConfig(join(directory, "state.sqlite"));
  config.automaticWeeklyReset.enabled = true;
  let now = 1_700_000_000_000;
  let fail = false;
  let email = "first@example.invalid";
  const response = () => {
    const value = rawQuota(50, (1_700_000_000_000 + 4 * DAY) / 1_000 - 1_000, { weeklyUsed: 98,
      resetCredits: [{ id: "credit", expiresAt: (now + 10 * DAY) / 1_000 }] });
    value.account.account!.email = email;
    return value;
  };
  const service = new QuotaGuardService(config, store, { readQuota: async () => {
    if (fail) throw Error("backend failed");
    return response();
  } }, { now: () => now, random: () => 0.5 });
  try {
    const first = await service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    // Expire the actual profile cache by advancing beyond its low TTL.
    now += 1_000_000;
    fail = true;
    const stale = await service.quotaStatusForRequest();
    assert.equal(stale.stale, true);
    assert.equal(stale.resetCredit.recommendation, null);
    fail = false;
    email = "second@example.invalid";
    now += 1_000_000;
    const switched = await service.quotaStatusForRequest();
    assert.notEqual(switched.resetCredit.recommendation?.recommendationId, recommendation.recommendationId);
    assert.equal(store.getResetRecommendation(recommendation.recommendationId, recommendation.idempotencyKey), null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("definitive reset follow-up rechecks at 3/5/10 schedule and stops when propagation is observed", async () => {
  const f = resetFixture();
  try {
    const first = await f.service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    const verified = await f.service.quotaStatusForRequest({
      recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey,
      outcome: "reset",
    });
    assert.deepEqual(f.sleeps, [3_000, 5_000]);
    assert.equal(verified.resetCredit.verification, "verified");
    assert.equal(verified.resetCredit.recommendation, null);
    assert.equal(f.reads(), 3);
    for (const outcome of ["reset", "alreadyRedeemed"] as const) {
      const replay = await f.service.quotaStatusForRequest({ ...recommendation, outcome });
      assert.equal(replay.resetCredit.verification, "verified");
      assert.equal(replay.resetCredit.recommendation, null);
    }
    assert.deepEqual(f.sleeps, [3_000, 5_000]);
    assert.equal(f.reads(), 3);
    await assert.rejects(() => f.service.quotaStatusForRequest({ ...recommendation, outcome: "uncertain" }),
      /RESET_FOLLOWUP_REPLAY/);
  } finally { f.close(); }
});

test("unobserved propagation consumes the epoch once and never emits another key", async () => {
  const f = resetFixture();
  try {
    const first = await f.service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    f.setPropagated(false);
    const pending = await f.service.quotaStatusForRequest({ ...recommendation, outcome: "alreadyRedeemed" });
    assert.deepEqual(f.sleeps, [3_000, 5_000]);
    // The fixture propagates on the second sleep; force a separate fixture for a true pending outcome below.
    assert.equal(pending.resetCredit.verification, "verified");
  } finally { f.close(); }

  const directory = mkdtempSync(join(tmpdir(), "quota-auto-reset-pending-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const config = testConfig(join(directory, "state.sqlite"));
  config.automaticWeeklyReset.enabled = true;
  let now = 1_700_000_000_000;
  const baseResetSeconds = (now + 4 * DAY) / 1_000 - 1_000;
  const unchanged = () => rawQuota(50, baseResetSeconds, { weeklyUsed: 98,
    resetCredits: [{ id: "same-credit", expiresAt: (now + 10 * DAY) / 1_000 }] });
  const service = new QuotaGuardService(config, store, { readQuota: async () => unchanged() }, {
    now: () => now, sleep: async ms => { now += ms; },
  });
  try {
    const first = await service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    const pending = await service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey, outcome: "reset" });
    assert.equal(pending.resetCredit.verification, "consumed_pending_propagation");
    for (const outcome of ["uncertain", "noCredit", "nothingToReset"] as const) {
      await assert.rejects(() => service.quotaStatusForRequest({ ...recommendation, outcome }), /RESET_FOLLOWUP_REPLAY/);
      assert.equal(store.getResetRecommendation(recommendation.recommendationId, recommendation.idempotencyKey)?.state,
        "consumed");
    }
    const afterChecks = now;
    for (const outcome of ["reset", "alreadyRedeemed"] as const) {
      const replay = await service.quotaStatusForRequest({ ...recommendation, outcome });
      assert.equal(replay.resetCredit.recommendation, null);
      assert.equal(replay.resetCredit.verification, "consumed_pending_propagation");
    }
    assert.equal(now, afterChecks, "duplicate outcomes must not repeat propagation sleeps");
    const later = await service.quotaStatusForRequest();
    assert.equal(later.resetCredit.recommendation, null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("uncertain follow-up reuses the key while terminal outcomes reject conflicting replay", async () => {
  const f = resetFixture();
  try {
    const first = await f.service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    const uncertain = await f.service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey, outcome: "uncertain" });
    assert.equal(uncertain.resetCredit.recommendation?.idempotencyKey, recommendation.idempotencyKey);
    await f.service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey, outcome: "noCredit" });
    await assert.rejects(() => f.service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey, outcome: "reset" }), /RESET_FOLLOWUP_REPLAY/);
    await assert.rejects(() => f.service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: "00000000-0000-4000-8000-000000000000", outcome: "reset" }), /RESET_FOLLOWUP_INVALID/);
  } finally { f.close(); }
});

test("nothingToReset permanently suppresses the current weekly epoch", async () => {
  const f = resetFixture();
  try {
    const first = await f.service.quotaStatusForRequest();
    const recommendation = first.resetCredit.recommendation!;
    const terminal = await f.service.quotaStatusForRequest({ recommendationId: recommendation.recommendationId,
      idempotencyKey: recommendation.idempotencyKey, outcome: "nothingToReset" });
    assert.equal(terminal.resetCredit.recommendation, null);
    assert.equal((await f.service.quotaStatusForRequest()).resetCredit.recommendation, null);
  } finally { f.close(); }
});

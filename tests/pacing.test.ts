import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { PACING_MAX_GAP_MS } from "../src/pacing.js";
import { rawQuota, testConfig } from "./helpers.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "guard-pacing-")), path = join(dir, "state.sqlite");
  const store = new StateStore(path);
  let now = 1_700_000_000_000, reads = 0, used = 33, email = "one@example.invalid", plan = "plus";
  let reset = (now + 7 * 86_400_000) / 1_000, fail = false, limit = "codex", weeklyUsed = 10;
  const reader = { readQuota: async () => {
    reads++;
    if (fail) throw Error("backend failed");
    const raw = rawQuota(used, reset, { planType: plan, limitId: limit, weeklyUsed });
    raw.account.account!.email = email;
    return raw;
  } };
  const service = new QuotaGuardService(testConfig(path), store, reader, { now: () => now });
  return { service, store, path, reader, now: () => now, reads: () => reads,
    step(ms: number, nextUsed = used) { now += ms; used = nextUsed; },
    account(value: string) { email = value; }, plan(value: string) { plan = value; },
    weekly(value: number) { weeklyUsed = value; },
    bucket(value: string) { limit = value; }, reset() { reset += 604_800; }, fail() { fail = true; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const job = { jobId: "gpu", taskId: "test", workspaceRoot: "C:\\test", jobClass: "long" as const,
  description: "Active model work before detached GPU launch", estimatedMinutes: 60 };

test("5h jobs span check intervals at cold start, cached deadline and account/plan changes", async () => {
  for (const plan of ["free", "plus", "pro"]) {
    const f = fixture();
    try {
      f.plan(plan); f.step(0, 0);
      const first = await f.service.jobPreflight(job);
      assert.equal(first.decision, "allow");
      assert.equal(first.canStartSegment, true);
      assert.equal(first.checkpointRequired, false);
      f.step(29_000);
      const cached = await f.service.jobPreflight(job);
      assert.equal(cached.canStartSegment, true);
      assert.equal(cached.validUntil, first.validUntil);
      f.step(1_000);
      const renewed = await f.service.jobPreflight(job);
      assert.equal(renewed.canStartSegment, true);
      assert.notEqual(renewed.validUntil, first.validUntil);
      f.account("new@example.invalid"); f.step(60_000);
      const switched = await f.service.jobPreflight(job);
      assert.equal(switched.quota.pacing?.primary?.confidence, "cold_start");
      assert.equal(switched.canStartSegment, true);
    } finally { f.close(); }
  }
});

test("mixed 5h/weekly quota forecasts use independent reserves", async () => {
  const f = fixture();
  try {
    f.weekly(91);
    await f.service.quotaStatusForRequest();
    f.step(30_000); f.weekly(92);
    const result = await f.service.jobPreflight({ ...job, jobClass: "small", estimatedMinutes: 0.1 });
    assert.equal(result.quota.weekly?.remainingPercent, 8);
    assert.equal(result.canStartSegment, true);
    assert.ok(Math.abs(result.quota.pacing!.primary!.minutesToReserve! - 5 / 3) < 0.001);
    f.step(30_000); f.weekly(97);
    const reserve = await f.service.jobPreflight({ ...job, estimatedMinutes: 0.1 });
    assert.equal(reserve.canStartSegment, false);
    assert.equal(reserve.quota.pacing?.primary?.minutesToReserve, 0);
    f.step(30_000); f.weekly(100);
    assert.equal((await f.service.jobPreflight(job)).decision, "defer");
  } finally { f.close(); }
});

test("long estimates never bypass real quota, billing, identity or availability blockers", async () => {
  const cases = [
    { name: "full", raw: rawQuota(0), admitted: true },
    { name: "weekly-low", raw: rawQuota(0, 2_000_000_000, { weeklyUsed: 92 }), admitted: true },
    { name: "5h-threshold", raw: rawQuota(90), admitted: false },
    { name: "weekly-empty", raw: rawQuota(0, 2_000_000_000, { weeklyUsed: 100 }), admitted: false },
    { name: "spend-control", raw: rawQuota(0, 2_000_000_000, { spendControlReached: true }), admitted: false },
    { name: "individual-empty", raw: rawQuota(0, 2_000_000_000, { individualLimit: { remainingPercent: 0, resetsAt: 2_000_000_000 } }), admitted: false },
    { name: "backend-block", raw: rawQuota(0, 2_000_000_000, { rateLimitReachedType: "spend_limit" }), admitted: false },
    { name: "credits", raw: rawQuota(100, 2_000_000_000, { credits: { hasCredits: true, unlimited: false } }), admitted: true },
  ];
  for (const c of cases) {
    const store = new StateStore(":memory:");
    try {
      const service = new QuotaGuardService(testConfig("/tmp/admission-matrix.sqlite"), store,
        { readQuota: async () => c.raw }, { now: () => 1_000 });
      const result = await service.jobPreflight(job);
      assert.equal(result.canStartSegment, c.admitted, c.name);
      const resume = await service.resumePrepare({ workspaceRoot: job.workspaceRoot, taskId: job.taskId, trigger: "automation" });
      assert.equal(resume.action, c.admitted ? "continue" : "wait", c.name);
      if (c.name === "credits") assert.equal(result.mayConsumeCredits, true);
      if (!c.admitted) assert.equal(result.decision, "defer", c.name);
    } finally { store.close(); }
  }
});

test("mixed weekly forecast honors configured reserve independently of Plus/Pro", async () => {
  for (const plan of ["plus", "pro"]) {
    const f = fixture(), store = new StateStore(f.path);
    try {
      f.plan(plan); f.weekly(91);
      const config = { ...testConfig(f.path), weeklyOnlyRemainingPercent: 2 };
      const service = new QuotaGuardService(config, store, f.reader, { now: f.now });
      await service.quotaStatusForRequest();
      f.step(30_000); f.weekly(92);
      const result = await service.jobPreflight({ ...job, jobClass: "small", estimatedMinutes: 0.1 });
      assert.equal(result.canStartSegment, true);
      assert.equal(result.quota.pacing?.primary?.minutesToReserve, 2);
    } finally { store.close(); f.close(); }
  }
});

test("67 to 36 to 23 percent never admits an unchecked 60-minute segment", async () => {
  const f = fixture();
  try {
    await f.service.quotaStatusForRequest();
    f.step(13 * 60_000, 64);
    await f.service.quotaStatusForRequest();
    f.step(5 * 60_000, 77);
    const result = await f.service.jobPreflight(job);
    assert.equal(result.canStartSegment, false);
    assert.equal(result.admissionRecorded, false);
    assert.equal(result.checkpointRequired, true);
    assert.equal(result.maxSegmentMinutes, 0.5);
    const pacing = result.quota.pacing!.primary!;
    assert.equal(pacing.confidence, "ready");
    assert.ok(pacing.burnRatePercentPerMinute! >= 2.6);
    assert.ok(pacing.minutesToReserve! < 6);
    assert.equal(Date.parse(result.checkAgainBy!) - f.now(), 30_000);
    const smaller = await f.service.jobPreflight({ ...job, estimatedMinutes: 0.25 });
    assert.equal(smaller.canStartSegment, true);
    assert.equal(smaller.admissionRecorded, true);
    assert.equal(f.reads(), 3);
  } finally { f.close(); }
});

for (const change of ["account", "plan", "bucket", "reset", "increase", "idle", "clock"] as const) {
  test(`pacing starts cold after ${change}`, async () => {
    const f = fixture();
    try {
      await f.service.quotaStatusForRequest();
      f.step(30_000, 40); await f.service.quotaStatusForRequest();
      f.step(30_000, 45); await f.service.quotaStatusForRequest();
      if (change === "account") f.account("two@example.invalid");
      if (change === "plan") f.plan("pro");
      if (change === "bucket") f.bucket("other");
      if (change === "reset") f.reset();
      f.step(change === "idle" ? PACING_MAX_GAP_MS + 1 : change === "clock" ? -60_000 : 30_000,
        change === "increase" ? 1 : 45);
      if (change === "clock") {
        // A clock rollback cannot make a cached forecast usable.
        assert.equal((await f.service.quotaStatusForRequest()).pacing?.primary?.confidence, "cold_start");
      } else {
        const status = await f.service.quotaStatusForRequest();
        assert.equal(status.pacing?.primary?.confidence, "cold_start");
        assert.equal(status.pacing?.primary?.burnRatePercentPerMinute, null);
      }
    } finally { f.close(); }
  });
}

test("cache hits and another service share samples without duplicating or extending deadlines", async () => {
  const f = fixture(), secondStore = new StateStore(f.path);
  try {
    const second = new QuotaGuardService(testConfig(f.path), secondStore, f.reader, { now: f.now });
    const first = await f.service.quotaStatusForRequest();
    for (let i = 0; i < 3; i++) {
      f.step(1_000);
      const next = await second.quotaStatusForRequest();
      assert.equal(next.pacing?.primary?.sampleCount, 1);
      assert.equal(next.checkAgainBy, first.checkAgainBy);
    }
    f.step(27_000, 40);
    const fresh = await second.jobPreflight({ ...job, estimatedMinutes: 0.1 });
    assert.equal(fresh.quota.pacing?.primary?.sampleCount, 2);
    assert.equal(f.reads(), 2);
  } finally { secondStore.close(); f.close(); }
});

test("failed refresh suppresses the rate, does not admit work and honors shared backoff", async () => {
  const f = fixture();
  try {
    await f.service.quotaStatusForRequest();
    f.step(30_000, 50); await f.service.quotaStatusForRequest();
    f.fail(); f.step(30_000);
    const result = await f.service.jobPreflight(job);
    assert.equal(result.decision, "defer");
    assert.equal(result.canStartSegment, false);
    assert.equal(result.quota.pacing?.primary?.burnRatePercentPerMinute, null);
    const reads = f.reads();
    await f.service.quotaStatusForRequest();
    assert.equal(f.reads(), reads);
  } finally { f.close(); }
});

test("resume after an overnight break reads fresh quota and starts cold", async () => {
  const f = fixture();
  try {
    await f.service.quotaStatusForRequest();
    f.step(30_000, 40); await f.service.quotaStatusForRequest();
    f.step(86_400_000, 10);
    const resume = await f.service.resumePrepare({ workspaceRoot: job.workspaceRoot, taskId: job.taskId, trigger: "manual" });
    assert.equal(resume.action, "continue");
    assert.equal(resume.quota?.source, "codex-app-server");
    assert.equal(resume.quota?.pacing?.primary?.confidence, "cold_start");
    assert.equal(resume.quota?.fiveHour?.remainingPercent, 90);
  } finally { f.close(); }
});

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
  let reset = (now + 7 * 86_400_000) / 1_000, fail = false, limit = "codex";
  const reader = { readQuota: async () => {
    reads++;
    if (fail) throw Error("backend failed");
    const raw = rawQuota(used, reset, { planType: plan, limitId: limit, weeklyUsed: 10 });
    raw.account.account!.email = email;
    return raw;
  } };
  const service = new QuotaGuardService(testConfig(path), store, reader, { now: () => now });
  return { service, store, path, reader, now: () => now, reads: () => reads,
    step(ms: number, nextUsed = used) { now += ms; used = nextUsed; },
    account(value: string) { email = value; }, plan(value: string) { plan = value; },
    bucket(value: string) { limit = value; }, reset() { reset += 604_800; }, fail() { fail = true; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const job = { jobId: "gpu", taskId: "test", workspaceRoot: "C:\\test", jobClass: "long" as const,
  description: "Active model work before detached GPU launch", estimatedMinutes: 60 };

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
    assert.equal(resume.canResume, true);
    assert.equal(resume.quota?.source, "codex-app-server");
    assert.equal(resume.quota?.pacing?.primary?.confidence, "cold_start");
    assert.equal(resume.quota?.fiveHour?.remainingPercent, 90);
  } finally { f.close(); }
});

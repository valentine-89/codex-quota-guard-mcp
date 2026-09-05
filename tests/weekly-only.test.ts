import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaGuardService } from "../src/service.js";
import { StateStore, profileKey } from "../src/store.js";
import { normalizeRateLimits, buildPolicyProfile } from "../src/policy.js";
import { rawQuota, testConfig } from "./helpers.js";

const DAY = 86_400_000;
function fixture(remaining = 100, wait: number | null = 7 * DAY) {
  const dir = mkdtempSync(join(tmpdir(), "quota-weekly-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  const config = testConfig(join(dir, "state.sqlite"));
  let now = 1_700_000_000_000, reads = 0, failed = false;
  const raw = rawQuota(0);
  const bucket = raw.rateLimits.rateLimits!;
  bucket.primary = null;
  bucket.secondary = { usedPercent: 100 - remaining, windowDurationMins: 10_080,
    resetsAt: wait === null ? null : (now + wait) / 1000 };
  const service = new QuotaGuardService(config, store, { readQuota: async () => {
    reads++; if (failed) throw Error("test failure"); return raw;
  } }, { now: () => now, random: () => 0.5 });
  const job = (id = "job") => ({ jobId: id, taskId: "task", workspaceRoot: dir, jobClass: "medium" as const, description: "weekly test" });
  const checkpoint = { workspaceRoot: dir, taskId: "task", jobClass: "medium" as const, objective: "weekly", completed: [], pending: ["work"] };
  return { dir, store, config, raw, bucket, service, job, checkpoint, now: () => now, reads: () => reads,
    advance: (ms: number) => { now += ms; }, fail: () => { failed = true; },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("weekly-only runtime100% uses3% baseline and idempotent admissions without 5h learning", async () => {
  const f = fixture();
  try {
    const first = await f.service.jobPreflight(f.job());
    assert.equal(first.decision, "allow"); assert.equal(first.quotaPath, "included");
    assert.equal(first.thresholdPercent, 3); assert.equal(first.quota.profile.policyMode, "weekly_only");
    assert.equal(first.admissionRecorded, true);
    assert.equal((await f.service.jobPreflight(f.job())).admissionRecorded, false);
    for (let i = 1; i <= 4; i++) {
      f.advance(300_001); f.bucket.secondary!.usedPercent = i * 10;
      await f.service.jobPreflight(f.job(`job-${i}`));
    }
    assert.equal((await f.service.quotaStatus()).profile.sampleCount, 0);
    assert.equal(buildPolicyProfile("free", 20, 20, 0, null, f.config, true).effectiveThresholdPercent, 3);
  } finally { f.close(); }
});

test("weekly-only low quota defers and schedules only strictly below24h including reset grace", async () => {
  for (const wait of [3_600_000, DAY - 31_000, DAY - 30_000, DAY, DAY + 1_000, null]) {
    const f = fixture(3, wait);
    try {
      const soon = wait !== null && wait + f.config.resetGraceMs < DAY;
      const result = await f.service.jobPreflight(f.job());
      assert.equal(result.decision, soon ? "defer" : "caution");
      assert.equal(result.quotaPath, soon ? "unavailable" : "weekly_advisory");
      const deferred = await f.service.deferUntilReset(f.checkpoint);
      assert.ok(deferred.checkpoint.id); assert.equal(deferred.canSchedule, soon);
      if (!soon) { assert.equal(deferred.reason, "advisory_only"); assert.equal(deferred.resumeAt, null); }
      else assert.equal(deferred.resumeAt, new Date(f.now() + wait! + f.config.resetGraceMs).toISOString());
    } finally { f.close(); }
  }
});

test("weekly-only exhausted far-reset quota is warning-only, not a claim of spendable allowance", async () => {
  const f = fixture(0);
  try {
    f.bucket.rateLimitReachedType = "rate_limit_reached";
    const result = await f.service.jobPreflight(f.job());
    assert.equal(result.decision, "caution"); assert.equal(result.quotaPath, "weekly_advisory");
    assert.match(result.requiredAction!, /Backend quota limits still apply/);
    assert.equal(result.admissionRecorded, true); assert.equal(result.mayConsumeCredits, false);
    assert.ok(Date.parse(result.quota.nextRefreshAt) - f.now() <= 300_000);
  } finally { f.close(); }
});

test("weekly-only override persists, resets, and cannot leak across an account change", async () => {
  const f = fixture(4, 3_600_000);
  try {
    assert.equal((await f.service.quotaProfile("adjust", 2)).effectiveThresholdPercent, 5);
    assert.equal((await f.service.jobPreflight(f.job())).decision, "defer");
    assert.equal((await f.service.quotaProfile("get")).userOverridePercent, 2);
    assert.equal((await f.service.quotaProfile("reset")).effectiveThresholdPercent, 3);
    assert.equal((await f.service.jobPreflight(f.job("after-reset"))).decision, "caution");
    await f.service.quotaProfile("adjust", 2);
    f.advance(300_001); f.raw.account.account!.email = "new@example.invalid";
    assert.equal((await f.service.quotaProfile("get")).effectiveThresholdPercent, 3);
  } finally { f.close(); }
});

test("weekly-only advisory does not bypass stale quota, spend control, individual limits or unknown errors", async () => {
  for (const kind of ["stale", "spend", "individual", "unknown"]) {
    const f = fixture(1);
    try {
      if (kind === "spend") f.bucket.spendControlReached = true;
      if (kind === "individual") f.bucket.individualLimit = { limit: "10", used: "10", remainingPercent: 0 };
      if (kind === "unknown") f.bucket.rateLimitReachedType = "future_limit";
      if (kind === "stale") { await f.service.quotaStatus(); f.advance(300_001); f.fail(); }
      assert.equal((await f.service.jobPreflight(f.job())).decision, "defer", kind);
    } finally { f.close(); }
  }
});

test("cached weekly policy recomputes reset horizon; reset snapshots revalidate", async () => {
  const f = fixture(1, DAY);
  try {
    assert.equal((await f.service.jobPreflight(f.job())).quotaPath, "weekly_advisory");
    f.advance(31_000);
    assert.equal((await f.service.jobPreflight(f.job("near"))).decision, "defer");
    assert.equal(f.reads(), 2); // Active preflight revalidates at the 30-second deadline.
    f.advance(DAY); f.bucket.secondary!.usedPercent = 0;
    f.bucket.secondary!.resetsAt = (f.now() + 7 * DAY) / 1000;
    assert.equal((await f.service.jobPreflight(f.job("reset"))).decision, "allow");
  } finally { f.close(); }
});

test("old5h defer resumes on new weekly-only account; primary never borrows reserve", async () => {
  const f = fixture();
  try {
    f.bucket.primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: (f.now() + 3_600_000) / 1000 };
    const old = await f.service.deferUntilReset(f.checkpoint);
    f.bucket.primary = null; f.raw.account.account!.email = "changed@example.invalid"; f.advance(60_001);
    const resume = await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: "task", trigger: "manual" });
    assert.equal(resume.canResume, true);
    assert.equal(f.store.getDefer(profileKey(f.config.codexHome), old.deferId)?.state, "superseded");
    assert.equal((await f.service.jobPreflight({ ...f.job(), laneId: "secondary", jobClass: "small" })).decision, "defer");
  } finally { f.close(); }
});

test("malformed reported5h cannot be silently reclassified as weekly-only", () => {
  assert.throws(() => normalizeRateLimits({ rateLimits: {
    primary: { usedPercent: "invalid", windowDurationMins: 300 },
    secondary: { usedPercent: 0, windowDurationMins: 10_080 },
  } }), /Invalid reported quota window/);
});

test("warning-only weekly exhaustion cannot advance an existing automation", async () => {
  const f = fixture(1);
  try {
    const deferred = await f.service.deferUntilReset(f.checkpoint);
    f.service.attachAutomation(deferred.deferId, "owned-weekly-test");
    assert.equal(f.service.monitorCanResume(deferred.defer, await f.service.quotaStatus()), false);
    f.advance(300_001); f.bucket.secondary!.usedPercent = 0;
    assert.equal(f.service.monitorCanResume(deferred.defer, await f.service.quotaStatus()), true);
  } finally { f.close(); }
});

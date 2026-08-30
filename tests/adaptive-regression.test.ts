import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GuardError } from "../src/errors.js";
import { baselineForPlan, buildPolicyProfile, normalizeRateLimits } from "../src/policy.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore, profileKey, accountFingerprint } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-adaptive-"));
  const path = join(directory, "state.sqlite");
  const config = testConfig(path);
  const store = new StateStore(path);
  let now = 1_000;
  let raw = rawQuota(20, 2_000_000);
  let failure = false;
  let reads = 0;
  const service = new QuotaGuardService(config, store, { readQuota: async () => {
    reads += 1;
    if (failure) throw new GuardError("APP_SERVER_TIMEOUT", "test timeout");
    return raw;
  } }, { now: () => now, random: () => 0.5 });
  const job = (jobId: string, laneId: "primary" | "secondary" = "primary") => ({
    jobId, taskId: "task", workspaceRoot: directory, jobClass: "small" as const, description: "bounded job", laneId,
  });
  return { directory, path, config, store, service, job,
    raw: () => raw, setRaw: (value: typeof raw) => { raw = value; },
    setFailure: (value: boolean) => { failure = value; },
    advance: (ms = 900_001) => { now += ms; }, reads: () => reads,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("all runtime plan groups have cold-start defaults and final override clamp", () => {
  const config = testConfig("unused.sqlite");
  const groups: Array<[number, string[]]> = [
    [20, ["free", "go"]], [5, ["pro", "prolite"]],
    [10, ["plus", "team", "business", "self_serve_business_prolite", "ent26", "enterprise", "edu",
      "self_serve_business_usage_based", "enterprise_cbp_automation", "enterprise_cbp_usage_based"]],
    [15, ["unknown", "future-plan"]],
  ];
  for (const [expected, plans] of groups) for (const plan of plans) assert.equal(baselineForPlan(plan, config), expected);
  assert.equal(buildPolicyProfile("plus", 40, 3, -49, null, config).effectiveThresholdPercent, 11);
  assert.equal(buildPolicyProfile("plus", 40, 3, 49, null, config).effectiveThresholdPercent, 50);
  assert.equal(buildPolicyProfile("plus", null, 0, -49, null, config).effectiveThresholdPercent, 1);
});

test("secondary recognition uses bucket identity, survives display renames and ignores unrelated buckets", () => {
  const normalized = normalizeRateLimits({ rateLimits: { limitId: "codex" }, rateLimitsByLimitId: {
    base_model_inference: { limitName: "Renamed product", primary: { usedPercent: 5, windowDurationMins: 10_080 } },
    unrelated: { limitName: "reserve", primary: { usedPercent: 1, windowDurationMins: 300 } },
  } });
  assert.equal(normalized.laneBuckets.secondary?.limitId, "base_model_inference");
  assert.equal(normalized.buckets.unrelated?.laneId, "unknown");
  assert.equal(normalized.laneBuckets.primary?.limitId, "codex");
  const reserveActive = normalizeRateLimits({ rateLimits: { limitId: "base_model_inference" } });
  assert.equal(reserveActive.laneBuckets.primary, undefined);
  assert.equal(reserveActive.laneBuckets.secondary?.limitId, "base_model_inference");
});

test("a primary long window alone is not permission to bypass missing five-hour capability", async () => {
  const f = fixture();
  try {
    f.raw().rateLimits.rateLimits!.primary = null;
    assert.equal((await f.service.jobPreflight(f.job("unknown-capability"))).decision, "defer");
  } finally { f.close(); }
});

test("three learned intervals raise admission thresholds and credits still count as part-jobs", async () => {
  const f = fixture();
  try {
    await f.service.jobPreflight(f.job("start"));
    for (let i = 1; i <= 3; i += 1) {
      f.advance(); f.setRaw(rawQuota(20 + i * 8, 2_000_000));
      const next = await f.service.jobPreflight(f.job(`learn-${i}`));
      assert.equal(next.thresholdPercent, i < 3 ? 10 : 12);
      assert.equal(next.quota.profile.confidence, i < 3 ? "low" : "ready");
    }
    // A guard credit path can still see the last included percent rise at runtime.
    f.advance(); f.setRaw(rawQuota(94, 2_000_000, { credits: { hasCredits: true, unlimited: false } }));
    assert.equal((await f.service.jobPreflight(f.job("credit-threshold"))).quotaPath, "credits");
    f.advance(); f.setRaw(rawQuota(96, 2_000_000, { credits: { hasCredits: true, unlimited: false } }));
    assert.equal((await f.service.quotaStatus()).profile.sampleCount, 5);
  } finally { f.close(); }
});

test("reset, negative delta, missing epoch and mixed classes do not contaminate class samples", () => {
  const f = fixture();
  const identity = { key: "p", fingerprint: "a", planType: "plus", limitId: "codex" };
  try {
    f.store.observeFreshQuota(identity, 0, "epoch", 0, 20);
    f.store.recordAdmission(identity, f.job("small"), 0, "epoch", 1);
    f.store.recordAdmission(identity, { ...f.job("long"), jobClass: "long" }, 0, "epoch", 2);
    f.store.observeFreshQuota(identity, 10, "epoch", 3, 20);
    assert.deepEqual(f.store.getLearning(identity, null, 20, 0), { mean: 5, count: 1 });
    assert.deepEqual(f.store.getLearning(identity, "small", 20, 0), { mean: null, count: 0 });
    assert.deepEqual(f.store.getLearning(identity, "long", 20, 0), { mean: null, count: 0 });
    f.store.recordAdmission(identity, f.job("negative"), 10, "epoch", 4);
    f.store.observeFreshQuota(identity, 5, "epoch", 5, 20);
    f.store.recordAdmission(identity, f.job("reset"), 5, "epoch", 6);
    f.store.observeFreshQuota(identity, 20, "new-epoch", 7, 20);
    f.store.recordAdmission(identity, f.job("missing"), 20, "new-epoch", 8);
    f.store.observeFreshQuota(identity, 25, null, 9, 20);
    assert.equal(f.store.getLearning(identity, null, 20, 3).count, 1);
  } finally { f.close(); }
});

test("resume uses the latest mandatory monthly/individual reset and the exact 24h ceiling", async () => {
  const f = fixture();
  try {
    const raw = rawQuota(100, 2_000, { weeklyUsed: 100, weeklyDurationMins: 43_200,
      individualLimit: { remainingPercent: 0, resetsAt: 86_371 }, spendControlReached: true,
      rateLimitReachedType: "workspace_member_usage_limit_reached" });
    f.setRaw(raw);
    const payload = { workspaceRoot: f.directory, taskId: "task", objective: "wait", completed: [], pending: [] };
    const atLimit = await f.service.deferUntilReset(payload);
    assert.equal(atLimit.canSchedule, true);
    assert.equal(atLimit.resumeAt, new Date(86_401_000).toISOString());
    // Latest reset, not the short window, controls resume. One second later is too far.
    const later = rawQuota(100, 2_000, { weeklyUsed: 100, weeklyDurationMins: 43_200 });
    later.rateLimits.rateLimits!.secondary!.resetsAt = 86_372;
    f.setRaw(later); f.store.expireCache(profileKey(f.config.codexHome));
    assert.equal((await f.service.deferUntilReset(payload)).canSchedule, false);
  } finally { f.close(); }
});

test("manual secondary resume leaves primary and unrelated tasks deferred", async () => {
  const f = fixture();
  try {
    f.setRaw(rawQuota(100, 20_000, { secondaryReserveUsed: 5 }));
    const payload = { workspaceRoot: f.directory, taskId: "task", objective: "wait", completed: [], pending: [] };
    const main = await f.service.deferUntilReset(payload);
    const secondary = await f.service.deferUntilReset({ ...payload, laneId: "secondary" });
    const other = await f.service.deferUntilReset({ ...payload, taskId: "unrelated" });
    f.service.attachAutomation(main.deferId, "main-heartbeat");
    f.service.attachAutomation(secondary.deferId, "secondary-heartbeat");
    f.service.attachAutomation(other.deferId, "unrelated-heartbeat");
    const result = await f.service.resumePrepare({ workspaceRoot: f.directory, taskId: "task", trigger: "manual", laneId: "secondary" });
    assert.equal(result.canResume, true);
    assert.deepEqual(result.automationIdsToCancel, ["secondary-heartbeat"]);
    assert.equal(f.store.getDefer(profileKey(f.config.codexHome), main.deferId)?.state, "active");
    assert.equal(f.store.getDefer(profileKey(f.config.codexHome), other.deferId)?.state, "active");
  } finally { f.close(); }
});

test("primary exhaustion does not freeze secondary observations until the primary reset", async () => {
  const f = fixture();
  try {
    f.setRaw(rawQuota(100, 20_000, { secondaryReserveUsed: 5 }));
    const status = await f.service.quotaStatus();
    assert.equal(Date.parse(status.nextRefreshAt) - Date.parse(status.fetchedAt!), f.config.ttlMs.high);
    assert.equal((await f.service.jobPreflight(f.job("light", "secondary"))).decision, "allow");
    assert.equal((await f.service.jobPreflight({ ...f.job("long", "secondary"), jobClass: "long" })).decision, "defer");
    f.advance();
    f.setRaw(rawQuota(100, 20_000, { secondaryReserveUsed: 100 }));
    assert.equal((await f.service.jobPreflight(f.job("empty", "secondary"))).decision, "defer");
    assert.equal(f.reads(), 2);
  } finally { f.close(); }
});

test("stale secondary and stale credit capability never admit new work", async () => {
  const f = fixture();
  try {
    f.setRaw(rawQuota(100, 20_000, { secondaryReserveUsed: 5, credits: { hasCredits: true, unlimited: false } }));
    await f.service.quotaStatus();
    f.advance(); f.setFailure(true);
    const secondary = await f.service.jobPreflight(f.job("stale-secondary", "secondary"));
    const primary = await f.service.jobPreflight(f.job("stale-credit"));
    assert.equal(secondary.decision, "defer"); assert.equal(primary.decision, "defer");
    assert.equal(primary.quotaPath, "unavailable"); assert.equal(primary.admissionRecorded, false);
  } finally { f.close(); }
});

test("credit-only usage-based allowance records an idempotent admission without fake five-hour samples", async () => {
  const f = fixture();
  try {
    const raw = rawQuota(100, 20_000, { planType: "enterprise_cbp_usage_based", credits: { hasCredits: false, unlimited: true } });
    raw.rateLimits.rateLimits!.primary = null;
    raw.rateLimits.rateLimits!.secondary = null;
    f.setRaw(raw);
    const first = await f.service.jobPreflight(f.job("credit"));
    assert.equal(first.decision, "caution"); assert.equal(first.mayConsumeCredits, true);
    assert.equal(first.admissionRecorded, true);
    assert.equal((await f.service.jobPreflight(f.job("credit"))).admissionRecorded, false);
    assert.equal(first.quota.profile.sampleCount, 0);
  } finally { f.close(); }
});

test("learning discards interrupted intervals and returning account/plan identities", async () => {
  const f = fixture();
  try {
    await f.service.jobPreflight(f.job("before-error"));
    f.advance(); f.setFailure(true); await f.service.quotaStatus();
    f.advance(); f.setFailure(false); f.setRaw(rawQuota(30, 2_000_000));
    assert.equal((await f.service.quotaStatus()).profile.sampleCount, 0);
    await f.service.jobPreflight(f.job("before-switch"));
    const alternate = rawQuota(5, 2_000_000, { planType: "pro" });
    alternate.account.account!.email = "other@example.invalid";
    f.advance(); f.setRaw(alternate); await f.service.quotaStatus();
    f.advance(); f.setRaw(rawQuota(40, 2_000_000));
    assert.equal((await f.service.quotaStatus()).profile.sampleCount, 0);
  } finally { f.close(); }
});

test("a disappearing and returning five-hour window cannot reuse pending admissions", async () => {
  const f = fixture();
  try {
    await f.service.jobPreflight(f.job("before-window-change"));
    const longOnly = rawQuota(25, 2_000_000);
    longOnly.rateLimits.rateLimits!.primary = null;
    f.advance(); f.setRaw(longOnly); await f.service.quotaStatus();
    f.advance(); f.setRaw(rawQuota(35, 2_000_000));
    assert.equal((await f.service.quotaStatus()).profile.sampleCount, 0);
  } finally { f.close(); }
});

test("passive arithmetic mean retains 20 intervals and accumulates zero-delta admissions", () => {
  const f = fixture();
  const identity = { key: "profile", fingerprint: "account", planType: "plus", limitId: "codex" };
  try {
    f.store.observeFreshQuota(identity, 0, "cycle", 0, 20);
    f.store.recordAdmission(identity, f.job("one"), 0, "cycle", 1);
    f.store.observeFreshQuota(identity, 0, "cycle", 2, 20);
    f.store.recordAdmission(identity, f.job("two"), 0, "cycle", 3);
    f.store.observeFreshQuota(identity, 4, "cycle", 4, 20);
    assert.equal(f.store.getLearning(identity, null, 20, 3).mean, 2);
    for (let i = 0; i < 21; i += 1) {
      f.store.recordAdmission(identity, f.job(`j-${i}`), 4 + i * 3, "cycle", i * 2 + 5);
      f.store.observeFreshQuota(identity, 7 + i * 3, "cycle", i * 2 + 6, 20);
    }
    assert.deepEqual(f.store.getLearning(identity, null, 20, 3), { mean: 3, count: 20 });
    assert.equal(f.store.getLearning({ ...identity, fingerprint: "other" }, null, 20, 3).count, 0);
    assert.equal(f.store.getLearning({ ...identity, planType: "pro" }, null, 20, 3).count, 0);
    assert.equal(f.store.getLearning({ ...identity, limitId: "reserve" }, null, 20, 3).count, 0);
  } finally { f.close(); }
});

test("unknown reset on any mandatory long window prevents scheduling", async () => {
  const f = fixture();
  try {
    const raw = rawQuota(100, 20_000, { weeklyUsed: 100, weeklyDurationMins: 43_200 });
    raw.rateLimits.rateLimits!.secondary!.resetsAt = null;
    f.setRaw(raw);
    const result = await f.service.deferUntilReset({ workspaceRoot: f.directory, taskId: "task", objective: "blocked", completed: [], pending: ["test"] });
    assert.equal(result.canSchedule, false); assert.equal(result.resumeAt, null);
    assert.equal(result.deferId, result.defer.id);
    assert.ok(result.checkpoint.id);
  } finally { f.close(); }
});

test("an exhausted individual limit with unknown reset blocks credits and scheduling", async () => {
  const f = fixture();
  try {
    const raw = rawQuota(100, 20_000, { credits: { hasCredits: true, unlimited: true },
      individualLimit: { remainingPercent: 0, resetsAt: 0 } });
    raw.rateLimits.rateLimits!.individualLimit!.resetsAt = null;
    f.setRaw(raw);
    assert.equal((await f.service.jobPreflight(f.job("individual"))).decision, "defer");
    const result = await f.service.deferUntilReset({ workspaceRoot: f.directory, taskId: "task", objective: "blocked", completed: [], pending: [] });
    assert.equal(result.resumeAt, null); assert.equal(result.canSchedule, false);
    assert.equal(result.quota.activeBucket?.individualLimit?.remainingPercent, 0);
  } finally { f.close(); }
});

test("manual resume supersedes before quota IO and obeys shared backoff", async () => {
  const f = fixture();
  try {
    f.setRaw(rawQuota(100, 20_000));
    const deferred = await f.service.deferUntilReset({ workspaceRoot: f.directory, taskId: "task", objective: "blocked", completed: [], pending: ["test"] });
    f.service.attachAutomation(deferred.deferId, "owned");
    f.store.recordFailure(profileKey(f.config.codexHome), "server", "APP_SERVER_TIMEOUT", 1_000, 600_000, () => 0.5);
    f.advance(61_000);
    const result = await f.service.resumePrepare({ workspaceRoot: f.directory, taskId: "task", trigger: "manual" });
    assert.equal(f.store.getDefer(profileKey(f.config.codexHome), deferred.deferId)?.state, "superseded");
    assert.deepEqual(result.automationIdsToCancel, ["owned"]); assert.equal(f.reads(), 1);
    assert.equal(result.canResume, false);
  } finally { f.close(); }
});

test("automation ownership is immutable, role-scoped and claims a due defer only once", () => {
  const f = fixture();
  try {
    const checkpoint = f.store.createCheckpoint("p", { workspaceRoot: f.directory, taskId: "task", objective: "test", completed: [], pending: [] }, 2_000, 1_000);
    const one = f.store.createDefer("p", checkpoint, "task", 2_000, 1_000);
    const two = f.store.createDefer("p", checkpoint, "task", 2_000, 1_000, "secondary");
    assert.ok(f.store.attachAutomation("p", one.id, "owned", 1_000));
    assert.equal(f.store.attachAutomation("p", one.id, "overwrite", 1_000), null);
    assert.equal(f.store.attachAutomation("p", two.id, "owned", 1_000), null);
    assert.equal(f.store.prepareResume("p", f.directory, "task", one.id, "automation", 1_500).shouldExit, true);
    assert.equal(f.store.prepareResume("p", f.directory, "task", one.id, "automation", 2_000, "secondary").shouldExit, true);
    assert.equal(f.store.prepareResume("p", f.directory, "task", one.id, "automation", 2_000).shouldExit, false);
    assert.equal(f.store.prepareResume("p", f.directory, "task", one.id, "automation", 2_001).shouldExit, true);
  } finally { f.close(); }
});

test("migration preserves v0.1 checkpoint/cache and refuses future schemas", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-migrate-"));
  const path = join(directory, "state.sqlite");
  const old = new StateStore(path);
  const checkpoint = old.createCheckpoint("profile", { workspaceRoot: directory, taskId: "old", objective: "keep", completed: [], pending: [] }, null, 1_000);
  old.close();
  let db = new DatabaseSync(path);
  db.exec("DROP TABLE defer_records; DROP TABLE quota_samples; DROP TABLE quota_observations; DROP TABLE job_admissions; DROP TABLE policy_overrides; PRAGMA user_version=1;");
  db.prepare("INSERT INTO quota_cache VALUES (?, ?, ?, ?, ?, ?)").run("profile", '{"v1":true}', 1, 2, "account", 1);
  db.close();
  const migrated = new StateStore(path);
  assert.equal(migrated.getCheckpoint("profile", directory, "old")?.id, checkpoint.id);
  assert.equal(migrated.getCache("profile")?.accountFingerprint, "account");
  migrated.close();
  db = new DatabaseSync(path); db.exec("PRAGMA user_version=99;"); db.close();
  assert.throws(() => new StateStore(path), /newer than supported/);
  rmSync(directory, { recursive: true, force: true });
  assert.equal(accountFingerprint("chatgpt", null), null);
});

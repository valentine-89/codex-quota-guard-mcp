import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { oneShotRrule, RESUME_AUTOMATION_PROMPT, resumeAutomationName } from "../src/automation.js";
import { GuardError } from "../src/errors.js";
import { QuotaGuardService, type QuotaReader } from "../src/service.js";
import { profileKey, StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

test("many service instances use one shared cached refresh", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-service-"));
  const path = join(directory, "state.sqlite");
  const config = testConfig(path);
  let reads = 0;
  const reader: QuotaReader = { readQuota: async () => { reads += 1; return rawQuota(30); } };
  const firstStore = new StateStore(path);
  const secondStore = new StateStore(path);
  try {
    const first = new QuotaGuardService(config, firstStore, reader, { now: () => 1_000, ownerId: "a" });
    const second = new QuotaGuardService(config, secondStore, reader, { now: () => 2_000, ownerId: "b" });
    const fresh = await first.quotaStatus();
    const cached = await second.quotaStatus();
    assert.equal(reads, 1);
    assert.equal(fresh.source, "codex-app-server");
    assert.equal(cached.source, "cache");
    assert.equal(cached.fiveHour?.remainingPercent, 70);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent refresh uses a lease instead of a request herd", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-herd-"));
  const path = join(directory, "state.sqlite");
  const config = testConfig(path);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstReads = 0;
  let secondReads = 0;
  const firstStore = new StateStore(path);
  const secondStore = new StateStore(path);
  try {
    const first = new QuotaGuardService(config, firstStore, {
      readQuota: async () => { firstReads += 1; await gate; return rawQuota(10); },
    }, { now: () => 1_000, ownerId: "a" });
    const second = new QuotaGuardService(config, secondStore, {
      readQuota: async () => { secondReads += 1; return rawQuota(10); },
    }, { now: () => 1_001, ownerId: "b" });
    const pending = first.quotaStatus();
    await new Promise((resolve) => setImmediate(resolve));
    const shared = await second.quotaStatus();
    assert.equal(shared.refreshInProgress, true);
    assert.equal(secondReads, 0);
    release?.();
    await pending;
    assert.equal(firstReads, 1);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed refresh enters shared backoff and preserves a safe unavailable state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-failure-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const config = testConfig(path);
    const service = new QuotaGuardService(config, store, {
      readQuota: async () => { throw new GuardError("APP_SERVER_TIMEOUT", "timed out"); },
    }, { now: () => 1_000, random: () => 0.5 });
    const result = await service.quotaStatus();
    assert.equal(result.source, "unavailable");
    assert.equal(result.error?.code, "APP_SERVER_TIMEOUT");
    assert.equal(result.nextRefreshAt, new Date(61_000).toISOString());
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("login rejection clears an older quota snapshot and forces every preflight to defer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-auth-switch-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  let now = 1_000, reject = false;
  try {
    const config = testConfig(path);
    const service = new QuotaGuardService(config, store, {
      readQuota: async () => {
        if (reject) throw new GuardError("CHATGPT_LOGIN_REQUIRED", "ChatGPT required");
        return rawQuota(10);
      },
    }, { now: () => now });
    assert.equal((await service.quotaStatus()).fiveHour?.remainingPercent, 90);
    reject = true; now += 1_000_000;
    const status = await service.quotaStatus();
    assert.equal(status.error?.code, "CHATGPT_LOGIN_REQUIRED");
    assert.equal(status.activeBucket, null);
    assert.equal(status.fiveHour, null);
    assert.equal(store.getCache(profileKey(config.codexHome)), null);
    const preflight = await service.jobPreflight({ workspaceRoot: directory, taskId: "task", jobId: "auth",
      jobClass: "small", description: "must defer" });
    assert.equal(preflight.decision, "defer");
    assert.equal(preflight.quotaPath, "unavailable");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent calls within one MCP service do not reacquire their own refresh lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-same-owner-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => { reads += 1; await gate; return rawQuota(20); },
    }, { now: () => 1_000 });
    const first = service.quotaStatus();
    const second = await service.quotaStatus();
    assert.equal(second.refreshInProgress, true);
    assert.equal(reads, 1);
    release?.(); await first;
  } finally { release?.(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("defer creates a resumable checkpoint after reset grace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-defer-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => rawQuota(100, 2_000),
    }, { now: () => 1_000 });
    const result = await service.deferUntilReset({
      workspaceRoot: directory,
      taskId: "task-1",
      objective: "resume me",
      completed: ["one"],
      pending: ["two"],
    });
    assert.equal(result.resumeAt, new Date(2_030_000).toISOString());
    assert.equal(result.canSchedule, true);
    assert.match(result.defer.id, /^[0-9a-f-]{36}$/);
    assert.equal(result.automationPrompt, RESUME_AUTOMATION_PROMPT);
    assert.deepEqual(result.automationRequest, {
      mode: "create",
      kind: "heartbeat",
      name: resumeAutomationName(result.defer.id),
      prompt: RESUME_AUTOMATION_PROMPT,
      rrule: oneShotRrule(2_030_000),
      status: "ACTIVE",
      destination: "thread",
      targetThreadId: "task-1",
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("job preflight records one idempotent admission and exposes persistent profile adjustment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-preflight-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, { readQuota: async () => rawQuota(30) }, { now: () => 1_000 });
    const input = { jobId: "job-1", taskId: "task-1", workspaceRoot: directory,
      jobClass: "long" as const, description: "build" };
    const first = await service.jobPreflight(input);
    const duplicate = await service.jobPreflight(input);
    assert.equal(first.decision, "allow");
    assert.equal(first.admissionRecorded, true);
    assert.equal(duplicate.admissionRecorded, false);
    assert.equal((await service.quotaProfile("adjust", 4)).effectiveThresholdPercent, 14);
    assert.equal((await service.quotaProfile("get")).effectiveThresholdPercent, 14);
    assert.equal((await service.quotaProfile("reset")).effectiveThresholdPercent, 10);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime credits admit a job below the fixed threshold unless spend control blocks it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-credits-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => rawQuota(100, 2_000, { credits: { hasCredits: true, unlimited: false, balance: "5" } }),
    }, { now: () => 1_000 });
    const result = await service.jobPreflight({ jobId: "credit-job", taskId: "task", workspaceRoot: directory,
      jobClass: "long", description: "credit backed build" });
    assert.equal(result.decision, "caution");
    assert.equal(result.quotaPath, "credits");
    assert.equal(result.mayConsumeCredits, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secondary reserve lane admits lightweight work while primary remains exhausted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-secondary-lane-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => rawQuota(100, 2_000, { secondaryReserveUsed: 5 }),
    }, { now: () => 1_000 });
    const status = await service.quotaStatus();
    assert.equal(status.lanes.secondary?.window?.remainingPercent, 95);
    assert.equal(status.lanes.primary?.recommendation, "checkpoint_and_defer");
    const light = await service.jobPreflight({ jobId: "light-1", taskId: "task-light", workspaceRoot: directory,
      jobClass: "small", description: "inspect files", sessionRole: "lightweight" });
    assert.equal(light.laneId, "secondary");
    assert.equal(light.decision, "allow");
    const main = await service.jobPreflight({ jobId: "main-1", taskId: "task-main", workspaceRoot: directory,
      jobClass: "long", description: "main build" });
    assert.equal(main.laneId, "primary");
    assert.equal(main.decision, "defer");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("defer keeps a checkpoint but refuses to schedule resets beyond 24 hours", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-long-defer-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => rawQuota(100, 200_000, { weeklyUsed: 100 }),
    }, { now: () => 1_000 });
    const result = await service.deferUntilReset({ workspaceRoot: directory, taskId: "task",
      objective: "long wait", completed: [], pending: ["later"] });
    assert.equal(result.canSchedule, false);
    assert.equal(result.reason, "reset_too_far");
    assert.notEqual(result.checkpoint.resumeAt, null);
    assert.equal(result.automationRequest, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("defer does not invent a reset for depleted workspace credits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-credit-defer-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => rawQuota(100, 2_000, { rateLimitReachedType: "workspace_member_credits_depleted",
        credits: { hasCredits: false, unlimited: false } }),
    }, { now: () => 1_000 });
    const result = await service.deferUntilReset({ workspaceRoot: directory, taskId: "task",
      objective: "credit wait", completed: [], pending: ["later"] });
    assert.equal(result.reason, "reset_unknown");
    assert.equal(result.resumeAt, null);
    assert.equal(result.canSchedule, false);
    assert.equal(result.automationRequest, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual resume supersedes owned automation before controlled unexpected-reset revalidation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-manual-resume-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  let now = 1_000;
  let used = 100;
  let reads = 0;
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => { reads += 1; return rawQuota(used, 2_000); },
    }, { now: () => now });
    await service.quotaStatus();
    const deferred = await service.deferUntilReset({ workspaceRoot: directory, taskId: "task",
      objective: "resume", completed: [], pending: ["work"] });
    service.attachAutomation(deferred.defer.id, "quota-owned-automation");
    used = 20;
    now = 62_000;
    const resumed = await service.resumePrepare({ workspaceRoot: directory, taskId: "task", trigger: "manual" });
    assert.deepEqual(resumed.automationIdsToCancel, ["quota-owned-automation"]);
    assert.equal(resumed.quota?.fiveHour?.remainingPercent, 80);
    assert.equal(reads, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a superseded heartbeat exits without reading quota", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-heartbeat-exit-"));
  const path = join(directory, "state.sqlite");
  const store = new StateStore(path);
  let reads = 0;
  try {
    const service = new QuotaGuardService(testConfig(path), store, {
      readQuota: async () => { reads += 1; return rawQuota(100, 2_000); },
    }, { now: () => 1_000 });
    const deferred = await service.deferUntilReset({ workspaceRoot: directory, taskId: "task",
      objective: "resume", completed: [], pending: ["work"] });
    await service.resumePrepare({ workspaceRoot: directory, taskId: "task", trigger: "manual" });
    const heartbeat = await service.resumePrepare({ workspaceRoot: directory, taskId: "task",
      deferId: deferred.defer.id, trigger: "automation" });
    assert.equal(heartbeat.shouldExit, true);
    assert.equal(heartbeat.quota, null);
    assert.equal(reads, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

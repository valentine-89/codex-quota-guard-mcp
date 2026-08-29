import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GuardError } from "../src/errors.js";
import { QuotaGuardService, type QuotaReader } from "../src/service.js";
import { StateStore } from "../src/store.js";
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
    const service = new QuotaGuardService(testConfig(path), store, {
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
      objective: "resume me",
      completed: ["one"],
      pending: ["two"],
    });
    assert.equal(result.resumeAt, new Date(2_030_000).toISOString());
    assert.equal(result.canSchedule, true);
    assert.match(result.automationPrompt, new RegExp(result.checkpoint.id));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

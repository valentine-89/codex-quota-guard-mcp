import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QuotaMonitor, type SchedulerBridge } from "../src/monitor.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore, profileKey } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quota-monitor-"));
  const config = testConfig(join(dir, "state.sqlite"));
  const first = new StateStore(config.stateFile), second = new StateStore(config.stateFile);
  let now = 1_000, reads = 0, writes = 0, cancels = 0, enabled = true;
  let raw = rawQuota(100, 20_000);
  let beforeSend = async (): Promise<void> => {};
  let fail = false;
  const reader = { readQuota: async () => { reads++; return raw; } };
  const service = new QuotaGuardService(config, first, reader, { now: () => now });
  service.setAutomationCapture(() => "original");
  const peer = new QuotaGuardService(config, second, reader, { now: () => now });
  const bridge: SchedulerBridge = {
    available: () => enabled, read: async () => ({ serialized: "original" }), expected: () => "expected",
    advance: async (_defer, _definition, authorize) => {
      await beforeSend();
      if (!authorize()) return false;
      writes++;
      if (fail) throw new Error("lost ACK");
      return true;
    },
    cancel: async (_defer, _expected, authorize) => { if (!authorize()) return false; cancels++; return true; },
    close: async () => {},
  };
  const monitor = new QuotaMonitor(config.codexHome, first, service, bridge, () => now);
  const competing = new QuotaMonitor(config.codexHome, second, peer, bridge, () => now);
  const deferred = await service.deferUntilReset({ workspaceRoot: dir, taskId: "task", objective: "wait", completed: [], pending: [] });
  service.attachAutomation(deferred.deferId, "owned");
  return { dir, config, first, second, service, monitor, competing, deferred, key: profileKey(config.codexHome),
    reads: () => reads, writes: () => writes, cancels: () => cancels,
    advance: (ms = 300_000) => { now += ms; }, now: () => now,
    setRaw: (value: typeof raw) => { raw = value; }, setEnabled: (value: boolean) => { enabled = value; },
    beforeSend: (callback: () => Promise<void>) => { beforeSend = callback; }, fail: () => { fail = true; },
    close: async () => { await monitor.stop(); await competing.stop(); first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("two monitors share a durable five-minute deadline and recover once after account switch", async () => {
  const f = await fixture();
  try {
    await Promise.all([f.monitor.tick(), f.competing.tick(), f.monitor.tick()]);
    assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
    const next = rawQuota(0, 20_000); next.account.account!.email = "new@example.invalid";
    f.setRaw(next); f.advance(299_999);
    await f.competing.tick(); assert.equal(f.reads(), 1);
    f.advance(1);
    await Promise.all([f.monitor.tick(), f.competing.tick()]);
    assert.equal(f.reads(), 2); assert.equal(f.writes(), 1);
    assert.equal(f.first.monitor.list(f.key)[0]?.stage, "scheduled");
    const resume = await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: "task", deferId: f.deferred.deferId, trigger: "automation" });
    assert.equal(resume.canResume, true); assert.equal(resume.shouldExit, false);
    // Cleanup runs before next five-minute quota deadline, with no extra read.
    await Promise.all([f.monitor.tick(), f.competing.tick()]);
    assert.equal(f.cancels(), 1); assert.equal(f.reads(), 2);
    assert.equal(f.first.monitor.list(f.key).length, 0);
  } finally { await f.close(); }
});

test("no scheduler capability performs no reads or mutations", async () => {
  const f = await fixture();
  try {
    f.setEnabled(false); f.advance(); await f.monitor.tick();
    assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("manual supersession during scheduler preparation prevents the external update", async () => {
  const f = await fixture();
  try {
    f.setRaw(rawQuota(0, 20_000)); f.advance();
    f.beforeSend(async () => { await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: "task", trigger: "manual" }); });
    await f.monitor.tick();
    assert.equal(f.writes(), 0);
    assert.equal(f.first.getDefer(f.key, f.deferred.deferId)?.state, "superseded");
  } finally { await f.close(); }
});

test("uncertain scheduler ACK is not replayed and its superseded heartbeat can be cleaned", async () => {
  const f = await fixture();
  try {
    f.setRaw(rawQuota(0, 20_000)); f.advance(); f.fail();
    await f.monitor.tick(); assert.equal(f.writes(), 1);
    assert.equal(f.first.monitor.list(f.key)[0]?.stage, "uncertain");
    f.advance(); await f.competing.tick(); assert.equal(f.writes(), 1);
    await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: "task", trigger: "manual" });
    await f.monitor.tick(); assert.equal(f.cancels(), 1);
  } finally { await f.close(); }
});

test("crashed monitor lease preserves cadence and fences expired owners", async () => {
  const f = await fixture();
  try {
    const ticket = f.first.monitor.claim(f.key, "crashed", f.now())!;
    f.advance(60_001);
    assert.equal(f.second.monitor.claim(f.key, "takeover", f.now()), null);
    assert.equal(f.first.monitor.renew(f.key, ticket, f.now()), false);
    f.advance(239_999);
    assert.ok(f.second.monitor.claim(f.key, "takeover", f.now()));
    assert.equal(f.first.monitor.dispatch(f.key, ticket, f.deferred.deferId, "x", f.now()), false);
  } finally { await f.close(); }
});

test("shared backoff blocks monitor quota IO and schedules no wake", async () => {
  const f = await fixture();
  try {
    f.first.recordFailure(f.key, "server", "APP_SERVER_TIMEOUT", f.now(), 600_000, () => 0.5);
    f.setRaw(rawQuota(0, 20_000)); f.advance(); await f.monitor.tick();
    assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
    assert.ok(f.first.monitor.status(f.key)!.nextPollAt >= 601_000);
  } finally { await f.close(); }
});

test("shutdown drains pending IO and prevents dispatch after stop", async () => {
  const f = await fixture();
  try {
    f.setRaw(rawQuota(0, 20_000)); f.advance();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.beforeSend(() => gate);
    const tick = f.monitor.tick();
    await new Promise(resolve => setImmediate(resolve));
    const stopped = f.monitor.stop();
    release!(); await Promise.all([tick, stopped]);
    assert.equal(f.writes(), 0);
    await f.monitor.tick(); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test("manual resume leaves no monitor candidates or extra quota IO", async () => {
  const f = await fixture();
  try {
    await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: "task", trigger: "manual" });
    const before = f.reads(); f.advance(); await f.monitor.tick();
    assert.equal(f.reads(), before); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

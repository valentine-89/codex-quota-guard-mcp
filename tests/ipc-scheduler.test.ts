import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { IpcClient, type IpcSnapshot } from "../src/ipc-client.js";
import { IpcScheduler } from "../src/ipc-scheduler.js";
import { StateStore, profileKey } from "../src/store.js";
import { QuotaGuardService } from "../src/service.js";
import { taskContext } from "../src/task-context.js";
import { rawQuota, testConfig } from "./helpers.js";

async function fixture(namespaced = false) {
  const dir = mkdtempSync(join(tmpdir(), "guard-ipc-")), config = testConfig(join(dir, "state.sqlite"));
  const store = new StateStore(config.stateFile), key = profileKey(config.codexHome);
  let now = 1_000, raw = rawQuota(100, 20_000), live = true, idle = true, fail = false, reads = 0, writes = 0;
  let beforeClaim = () => {};
  const context = { taskId: "01a07567-0611-7fb0-b7e7-9c15cbfcff81", clientId: "lease", desktop: false };
  const service = new QuotaGuardService(config, store, { readQuota: async () => { reads++; return raw; } }, { now: () => now });
  class FakeClient extends IpcClient {
    override async connect() {}
    override async inspect(taskId: string): Promise<IpcSnapshot> {
      const path = (value: string) => namespaced ? toNamespacedPath(value) : value;
      return { taskId, cwd: path(dir), rolloutPath: path(join(config.codexHome, "sessions", "test.jsonl")), owner: "owner", idle };
    }
    override async send(snapshot: IpcSnapshot, cwd: string, prompt: string, authorize: () => boolean): Promise<string> {
      assert.equal(cwd, dir); assert.match(prompt, /resume_prepare/); assert.match(prompt, /automation/);
      assert.equal(snapshot.idle, true); beforeClaim(); if (!authorize()) throw Error("cancelled");
      writes++; if (fail) throw Error("lost ACK"); return "turn-id";
    }
    override close() {}
  }
  const scheduler = new IpcScheduler(config, store, service, () => new FakeClient(), () => now, "win32");
  scheduler.setLiveClients(() => live); service.setIpcScheduler(scheduler);
  await scheduler.bind(context);
  const payload = { workspaceRoot: dir, taskId: context.taskId, objective: "wait", completed: [], pending: [] };
  const deferred = await taskContext.run(context, () => service.deferUntilReset(payload));
  return { dir, config, key, store, service, scheduler, context, payload, deferred,
    reads: () => reads, writes: () => writes, setIdle: (value: boolean) => { idle = value; },
    setLive: (value: boolean) => { live = value; }, recover: () => { raw = rawQuota(0, 20_000); },
    advance: (ms = 300_000) => { now += ms; }, fail: () => { fail = true; },
    beforeClaim: (fn: () => void) => { beforeClaim = fn; },
    close: async () => { await scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("extended Windows paths bind the same profile and workspace", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture(true); try {
    assert.equal(f.deferred.scheduling.mechanism, "ipc");
    f.recover(); f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test("IPC defer schedules without Desktop automation and early resume is proof-bound", async () => {
  const f = await fixture(); try {
    assert.equal(f.deferred.scheduling.mechanism, "ipc"); assert.equal(f.deferred.scheduling.state, "scheduled");
    assert.equal(f.deferred.automationRequest, null); assert.equal(f.deferred.defer.automationId, null);
    assert.throws(() => f.service.attachAutomation(f.deferred.deferId, "desktop"));
    f.recover(); await f.scheduler.tick(); assert.equal(f.writes(), 0);
    f.advance(); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]); assert.equal(f.writes(), 1);
    const wake = f.store.ipc.list(f.key)[0]!; assert.equal(wake.turnId, "turn-id");
    const resume = await f.service.resumePrepare({ workspaceRoot: f.dir, taskId: f.context.taskId, deferId: wake.deferId, trigger: "automation" });
    assert.equal(resume.shouldExit, false); assert.equal(resume.canResume, true);
    assert.equal(f.store.ipc.list(f.key)[0]?.state, "completed");
    f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test("busy task and disconnected lease perform no quota reads or dispatch; reconnect revalidates", async () => {
  const f = await fixture(); try {
    f.recover(); f.advance(); f.setIdle(false); await f.scheduler.tick(); assert.equal(f.reads(), 1);
    f.setLive(false); f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 0);
    f.setLive(true); f.setIdle(true); await f.scheduler.tick(); assert.equal(f.writes(), 0);
    await f.scheduler.bind(f.context); await f.scheduler.tick(); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test("unconfirmed dispatch survives reopening SQLite and is never replayed", async () => {
  const f = await fixture(); try {
    f.recover(); f.fail(); f.advance(); await f.scheduler.tick();
    assert.equal(f.writes(), 1); assert.equal(f.store.ipc.list(f.key)[0]?.state, "uncertain");
    const second = new StateStore(f.config.stateFile);
    try { assert.equal(second.ipc.claim(f.key, f.deferred.deferId, "again", Date.now()), false); }
    finally { second.close(); }
    f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test("manual resume and loss of lease immediately before claim prevent dispatch", async () => {
  const f = await fixture(); try {
    f.recover(); f.advance(); f.beforeClaim(() => { f.setLive(false); }); await f.scheduler.tick();
    assert.equal(f.writes(), 0);
    f.store.prepareResume(f.key, f.dir, f.context.taskId, f.deferred.deferId, "manual", Date.now());
    assert.equal(f.store.ipc.list(f.key)[0]?.state, "cancelled");
    f.setLive(true); await f.scheduler.bind(f.context); f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});
test("disabled early monitor retains due-time IPC wake", async () => {
  const f = await fixture(); try {
    f.config.monitorEnabled = false; f.recover(); f.advance(); await f.scheduler.tick(); assert.equal(f.writes(), 0);
    f.advance(20_000_000); await f.scheduler.tick(); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test("Desktop context retains heartbeat contract; mismatched task is rejected", async () => {
  const f = await fixture(); try {
    const desktop = await taskContext.run({ ...f.context, desktop: true }, () => f.service.deferUntilReset(f.payload));
    assert.equal(desktop.scheduling.mechanism, "desktop"); assert.ok(desktop.automationRequest);
    assert.equal(f.store.ipc.has(f.key, desktop.deferId), false);
    await assert.rejects(taskContext.run(f.context, () => f.service.deferUntilReset({ ...f.payload, taskId: "other" })), /MISMATCH/);
  } finally { await f.close(); }
});
test("new IPC defer supersedes only the same task/workspace/lane and preserves Desktop records", async () => {
  const f = await fixture(); try {
    const desktop = await taskContext.run({ ...f.context, desktop: true }, () => f.service.deferUntilReset(f.payload));
    const secondary = f.store.createCheckpoint(f.key, { ...f.payload, laneId: "secondary" }, 20_030_000, 1000);
    const secondaryDefer = f.store.createDefer(f.key, secondary, f.context.taskId, 20_030_000, 1000, "secondary");
    f.store.ipc.create(f.key, secondaryDefer.id, 20_030_000, 1000);
    const next = await taskContext.run(f.context, () => f.service.deferUntilReset(f.payload));
    assert.equal(f.store.getDefer(f.key, f.deferred.deferId)?.state, "superseded");
    assert.equal(f.store.getDefer(f.key, desktop.deferId)?.state, "active");
    assert.equal(f.store.getDefer(f.key, secondaryDefer.id)?.state, "active");
    assert.equal(f.store.getDefer(f.key, next.deferId)?.state, "active");
    f.store.prepareResume(f.key, f.dir, f.context.taskId, secondaryDefer.id, "manual", 1500, "secondary");
    assert.equal(f.store.ipc.list(f.key).find(w => w.deferId === secondaryDefer.id)?.state, "cancelled");
    assert.equal(f.store.getDefer(f.key, next.deferId)?.state, "active");
  } finally { await f.close(); }
});
test("same-profile SQLite contenders cannot claim one wake twice; another profile cannot claim it", async () => {
  const f = await fixture(); const peer = new StateStore(f.config.stateFile); try {
    assert.equal(peer.ipc.claim("different-profile", f.deferred.deferId, "wrong", 5000), false);
    assert.equal(f.store.ipc.claim(f.key, f.deferred.deferId, "one", 5000), true);
    assert.equal(peer.ipc.claim(f.key, f.deferred.deferId, "two", 5000), false);
  } finally { peer.close(); await f.close(); }
});

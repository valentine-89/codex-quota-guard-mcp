import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ensureManagedCore, managedHealth, readManagedSettings, type ManagedSettings } from "../src/managed.js";
import { RenewableSchedulerRpc } from "../src/scheduler.js";
import { startHttpServer } from "../src/http-server.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-managed-"));
  chmodSync(directory, 0o700);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings: ManagedSettings = { revision: 1, installationId: randomUUID(), port,
    token: randomBytes(32).toString("base64url"), nodeExecutable: process.execPath,
    coreEntrypoint: resolve("tests/fixtures/managed-core.mjs"), guardConfig: join(directory, "guard.json") };
  const path = join(directory, "runtime.json");
  writeFileSync(settings.guardConfig, JSON.stringify({ stateDir: directory, codexHome: directory, monitorEnabled: false }), { mode: 0o600 });
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  return { directory, path, settings, close: () => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test("managed settings validate private files, token and endpoints", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(readManagedSettings(f.path), f.settings);
    for (const change of [{ port: 80 }, { token: "weak" }, { coreEntrypoint: "relative.js" }, { revision: 2 }]) {
      writeFileSync(f.path, JSON.stringify({ ...f.settings, ...change }));
      assert.throws(() => readManagedSettings(f.path), /MANAGED_SETTINGS_INVALID/);
    }
    if (process.platform !== "win32") {
      chmodSync(f.path, 0o644);
      assert.throws(() => readManagedSettings(f.path), /NOT_PRIVATE/);
    }
  } finally { await f.close(); }
});

test("six bootstrap contenders elect one shared core, survive disconnect and recover after crash", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let pid: number | undefined;
  try {
    await Promise.all(Array.from({ length: 6 }, () => ensureManagedCore(f.path)));
    const first = await managedHealth(f.settings);
    pid = first!.pid as number;
    assert.equal(first!.mode, "shared-http");
    await ensureManagedCore(f.path);
    assert.equal((await managedHealth(f.settings))!.pid, pid);
    // This PID came from the authenticated, isolated fixture, not process enumeration.
    process.kill(pid);
    for (let i = 0; i < 100; i++) {
      // A just-killed keep-alive socket can reset before the listener disappears.
      try { if (await managedHealth(f.settings) === null) break; } catch { /* Wait for confirmed absence. */ }
      await delay(20);
    }
    await Promise.all(Array.from({ length: 6 }, () => ensureManagedCore(f.path)));
    const second = await managedHealth(f.settings);
    assert.notEqual(second!.pid, pid);
    pid = second!.pid as number;
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* Already exited. */ } }
    await f.close();
  }
});

test("managed bootstrap refuses a wrong listener; binding is authenticated and bounded", async () => {
  const f = await fixture();
  let calls = 0;
  const server = await startHttpServer(() => { throw Error("unused"); }, { token: f.settings.token, port: f.settings.port,
    diagnostics: () => ({ installationId: "wrong" }), bindDesktop: async () => { calls++; return true; } });
  try {
    await assert.rejects(ensureManagedCore(f.path), /IDENTITY_MISMATCH/);
    await assert.rejects(managedHealth({ ...f.settings, token: randomBytes(32).toString("base64url") }), /AUTH_FAILED/);
    const url = server.url.replace("/mcp", "/desktop-session");
    const body = JSON.stringify({ pipePath: "test", taskId: "test" });
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    const headers = { Authorization: `Bearer ${f.settings.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ pipePath: "test", taskId: "test", serverPath: "injected" }) })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(4097) })).status, 413);
    assert.equal(calls, 1);
  } finally { await server.close(); await f.close(); }
});

test("capability renewal serializes dispatch, verifies candidates and retains a good binding on failure", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rpc = new RenewableSchedulerRpc(resolve("src/scheduler.ts"), env => {
    const name = env.CODEX_APP_TOOLS_PIPE_PATH?.split("\\").at(-1) ?? "initial";
    return { ready: async () => {}, close: async () => { events.push(`close:${name}`); },
      call: async () => { events.push(`call:${name}`); await gate; return true; },
      verifyContext: async () => { events.push(`verify:${name}`); if (name === "bad") throw Error("rejected"); } };
  });
  const task = randomUUID();
  try {
    assert.equal(await rpc.bind("https://invalid", task), false);
    assert.equal(await rpc.bind("\\\\.\\pipe\\good", "invalid"), false);
    assert.equal(await rpc.bind("\\\\.\\pipe\\good", task), true);
    const pending = rpc.call({}, task);
    const replacement = rpc.bind("\\\\.\\pipe\\new", task);
    await delay(10);
    assert.ok(!events.includes("verify:new"));
    release(); await pending;
    assert.equal(await replacement, true);
    assert.equal(await rpc.bind("\\\\.\\pipe\\bad", task), false);
    assert.equal(await rpc.bind("\\\\.\\pipe\\new", task), true);
    assert.equal(events.filter(e => e === "verify:new").length, 1);
    assert.ok(!events.includes("close:new"));
    await rpc.call({}, task);
    assert.equal(events.at(-1), "call:new");
  } finally { release(); await rpc.close(); }
});

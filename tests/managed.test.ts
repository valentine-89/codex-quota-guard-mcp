import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { bindManagedPort, ensureManagedCore, managedCoreCanStop, managedHealth, readManagedSettings, type ManagedSettings } from "../src/managed.js";
import { RenewableSchedulerRpc } from "../src/scheduler.js";
import { startHttpServer } from "../src/http-server.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { ClientLeaseRegistry } from "../src/client-leases.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "quota-managed-"));
  chmodSync(directory, 0o700);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings: ManagedSettings = { revision: 2, installationId: randomUUID(), port,
    token: randomBytes(32).toString("base64url"), nodeExecutable: process.execPath,
    coreEntrypoint: resolve("tests/fixtures/managed-core.mjs"), guardConfig: join(directory, "guard.json") };
  const path = join(directory, "runtime.json");
  writeFileSync(settings.guardConfig, JSON.stringify({ stateDir: directory, codexHome: directory, monitorEnabled: false }), { mode: 0o600 });
  writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
  return { directory, path, settings, close: () => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

test("denied managed port relocates without rotating identity; other failures stay closed", async () => {
  const f = await fixture();
  const calls: number[] = [];
  try {
    await bindManagedPort(f.path, f.settings, f.settings.port, async port => {
      calls.push(port);
      if (port) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return { url: "http://127.0.0.1:52000/mcp", close: async () => {} };
    });
    assert.deepEqual(calls, [f.settings.port, 0]);
    assert.deepEqual(readManagedSettings(f.path), { ...f.settings, port: 52000 });
    for (const code of ["EADDRINUSE", "UNKNOWN"]) {
      let attempts = 0;
      await assert.rejects(bindManagedPort(f.path, f.settings, f.settings.port, async () => {
        attempts++; throw Object.assign(new Error(code), { code });
      }), new RegExp(code));
      assert.equal(attempts, 1);
    }
    await assert.rejects(bindManagedPort(undefined, undefined, 52000, async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }), /denied/);
  } finally { await f.close(); }
});

test("idle connector retries failed scheduler binding without a tool call", { timeout: 120_000 }, async () => {
  const f = await fixture();
  let attempts = 0, recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  const leases = new ClientLeaseRegistry(60_000);
  const server = await startHttpServer(() => new McpServer({ name: "idle-test", version: "1" }), {
    port: f.settings.port, token: f.settings.token, clientLeases: leases,
    diagnostics: () => ({ installationId: f.settings.installationId }),
    bindDesktop: async () => {
      assert.equal(leases.snapshot().liveClients, 1, "lease must precede scheduler negotiation");
      if (++attempts === 1) return false; recovered(); return true;
    },
  });
  const client = new Client({ name: "idle-test-client", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/connector.js")],
      env: { ...process.env, CODEX_QUOTA_GUARD_MANAGED_SETTINGS: f.path,
        CODEX_THREAD_ID: randomUUID(), CODEX_APP_TOOLS_PIPE_PATH: "test-inherited-pipe" }, stderr: "pipe" }));
    assert.equal(attempts, 1);
    assert.equal(leases.snapshot().liveClients, 1);
    await Promise.race([recovery, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("idle scheduler did not recover")), 90_000);
    })]);
    assert.ok(attempts >= 2);
  } finally { clearTimeout(timer); await client.close(); await server.close(); await f.close(); }
});

test("managed settings validate private files, token and endpoints", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(readManagedSettings(f.path), f.settings);
    for (const change of [{ port: 80 }, { token: "weak" }, { coreEntrypoint: "relative.js" }, { revision: 1 }]) {
      writeFileSync(f.path, JSON.stringify({ ...f.settings, ...change }));
      assert.throws(() => readManagedSettings(f.path), /MANAGED_SETTINGS_INVALID/);
    }
    if (process.platform !== "win32") {
      chmodSync(f.path, 0o644);
      assert.throws(() => readManagedSettings(f.path), /NOT_PRIVATE/);
    }
  } finally { await f.close(); }
});

test("core shutdown policy depends on connectors, requests and scheduler dispatch only", () => {
  assert.equal(managedCoreCanStop(300_000, 300_000, 0, false), true);
  assert.equal(managedCoreCanStop(299_999, 300_000, 0, false), false);
  assert.equal(managedCoreCanStop(300_000, 300_000, 1, false), false);
  assert.equal(managedCoreCanStop(300_000, 300_000, 0, true), false);
});

test("six bootstrap contenders elect one shared core, survive disconnect and recover after crash", { timeout: 120_000 }, async () => {
  const f = await fixture();
  let pid: number | undefined;
  const startContenders = async () => {
    const pending = Array.from({ length: 6 }, () => ensureManagedCore(f.path));
    // A real connector leases the first ready core. Do not let it idle-exit while
    // slower contenders are still starting on a shared runner.
    const settled = Promise.allSettled(pending);
    try {
      const settings = await Promise.any(pending);
      const health = await managedHealth(settings);
      pid = health!.pid as number;
      const response = await fetch(`http://127.0.0.1:${settings.port}/client-lease`, {
        method: "POST", headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register" }), signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
    } finally { await settled; }
    for (const result of await settled) if (result.status === "rejected") throw result.reason;
  };
  try {
    await startContenders();
    const first = await managedHealth(f.settings);
    pid = first!.pid as number;
    assert.equal(first!.mode, "shared-http");
    await ensureManagedCore(f.path);
    assert.equal((await managedHealth(f.settings))!.pid, pid);
    // This PID came from the authenticated, isolated fixture, not process enumeration.
    const previousPid = pid;
    process.kill(pid);
    for (let i = 0; i < 100; i++) {
      // A just-killed keep-alive socket can reset before the listener disappears.
      try { if (await managedHealth(f.settings) === null) break; } catch { /* Wait for confirmed absence. */ }
      await delay(20);
    }
    await startContenders();
    const second = await managedHealth(f.settings);
    assert.notEqual(second!.pid, previousPid);
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

test("capability renewal serializes dispatch, verifies candidates and retains a good Windows binding on failure", async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rpc = new RenewableSchedulerRpc(resolve("src/scheduler.ts"), env => {
    const name = env.CODEX_APP_TOOLS_PIPE_PATH?.split("\\").at(-1) ?? "initial";
    return { ready: async () => {}, close: async () => { events.push(`close:${name}`); },
      call: async () => { events.push(`call:${name}`); await gate; return true; },
      verifyContext: async () => { events.push(`verify:${name}`); if (name === "bad") throw Error("rejected"); } };
  }, "win32");
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
    assert.equal(events.filter(e => e === "verify:new").length, 2);
    assert.ok(!events.includes("close:new"));
    await rpc.call({}, task);
    assert.equal(events.at(-1), "call:new");
  } finally { release(); await rpc.close(); }
});

test("Linux scheduler binding accepts only a verified absolute Unix socket path", async () => {
  const events: string[] = [];
  const rpc = new RenewableSchedulerRpc(resolve("src/scheduler.ts"), env => ({
    ready: async () => {}, close: async () => {}, call: async () => true,
    verifyContext: async () => { events.push(env.CODEX_APP_TOOLS_PIPE_PATH ?? "missing"); },
  }), "linux");
  const task = randomUUID();
  try {
    assert.equal(rpc.available(), false);
    assert.equal(await rpc.bind("relative.sock", task), false);
    assert.equal(await rpc.bind("https://invalid", task), false);
    assert.equal(await rpc.bind("/run/user/1000/codex-app-tools.sock", "invalid"), false);
    assert.equal(await rpc.bind("/run/user/1000/codex-app-tools.sock", task), true);
    assert.equal(rpc.available(), true);
    assert.deepEqual(events, ["/run/user/1000/codex-app-tools.sock"]);
  } finally { await rpc.close(); }
});

test("rejected task rebind preserves other verified tasks on the same scheduler", async () => {
  const good = randomUUID(), bad = randomUUID();
  const rpc = new RenewableSchedulerRpc(resolve("src/scheduler.ts"), () => ({
    ready: async () => {}, close: async () => {}, call: async () => true,
    verifyContext: async task => { if (task === bad) throw new Error("SCHEDULER_CONTEXT_REJECTED"); },
  }), "win32");
  try {
    assert.equal(await rpc.bind("\\\\.\\pipe\\shared", good), true);
    assert.equal(await rpc.bind("\\\\.\\pipe\\shared", bad), false);
    assert.equal(rpc.availableForTask(good), true);
    assert.equal(rpc.availableForTask(bad), false);
    assert.equal(await rpc.bind("\\\\.\\pipe\\shared", "invalid"), false);
    assert.equal(rpc.availableForTask(good), true);
  } finally { await rpc.close(); }
});

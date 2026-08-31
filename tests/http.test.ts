import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startHttpServer } from "../src/http-server.js";
import { acquireCoreLock } from "../src/core-lock.js";
import { createMcpServer, SERVER_INSTRUCTIONS } from "../src/mcp-server.js";
import { StateStore } from "../src/store.js";
import { QuotaGuardService } from "../src/service.js";
import { rawQuota, testConfig } from "./helpers.js";
import { ClientLeaseRegistry } from "../src/client-leases.js";

async function fixture(extra: { maxConcurrentRequests?: number; maxBodyBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quota-http-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  let reads = 0;
  const service = new QuotaGuardService(testConfig(join(dir, "state.sqlite")), store, { readQuota: async () => { reads++; return rawQuota(10); } });
  const token = randomBytes(32).toString("base64url");
  const clientLeases = new ClientLeaseRegistry();
  service.setLiveClientCount(() => clientLeases.snapshot().liveClients);
  const http = await startHttpServer(() => createMcpServer(service), { token, clientLeases, ...extra });
  const clients: Client[] = [];
  return { dir, service, reads: () => reads, http, token,
    async connect() {
      const client = new Client({ name: "http-test", version: "1" }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as Transport);
      return client;
    },
    async close() { await Promise.all(clients.map(c => c.close())); await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("many HTTP clients share quota cache/admissions; disconnect does not close the backend", async () => {
  const f = await fixture();
  try {
    const clients = await Promise.all(Array.from({ length: 6 }, () => f.connect()));
    for (const c of clients) assert.equal((await c.listTools()).tools.length, 8);
    // First quota read settles; subsequent concurrent requests must all use this cache.
    await clients[0]!.callTool({ name: "quota_status", arguments: {} });
    const snapshots = await Promise.all(clients.map(c => c.callTool({ name: "quota_status", arguments: {} })));
    assert.equal(f.reads(), 1);
    assert.ok(snapshots.every(s => !s.isError));
    const job = { workspaceRoot: f.dir, taskId: "task", jobId: "idempotent", jobClass: "small", description: "shared HTTP" };
    const jobs = await Promise.all(clients.map(c => c.callTool({ name: "job_preflight", arguments: job })));
    assert.equal(jobs.filter(j => (j.structuredContent as Record<string, unknown>)?.admissionRecorded).length, 1);
    const monitor = (snapshots[0]!.structuredContent as Record<string, unknown>)?.monitor as Record<string, unknown>;
    assert.equal(monitor.requiresLiveClientConnection, true);
    assert.equal(monitor.lifecycleMode, "codex-bound");
    await Promise.all(clients.map(c => c.close()));
    const next = await f.connect();
    assert.equal((await next.callTool({ name: "quota_status", arguments: {} })).isError, undefined);
    assert.equal(f.reads(), 1);
  } finally { await f.close(); }
});

test("connector leases register, renew, unregister and expire only in memory", async () => {
  let now = 1_000;
  const token = randomBytes(32).toString("base64url");
  const leases = new ClientLeaseRegistry(60_000, () => now);
  const http = await startHttpServer(() => { throw Error("unused"); }, { token, clientLeases: leases });
  const url = http.url.replace("/mcp", "/client-lease");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const registered = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "register" }) });
    const clientId = (await registered.json() as { clientId: string }).clientId;
    assert.equal(leases.snapshot().liveClients, 1);
    now += 20_000;
    assert.equal((await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ action: "renew", clientId }) })).status, 200);
    now += 59_999; assert.equal(leases.snapshot().liveClients, 1);
    now += 1; assert.equal(leases.snapshot().liveClients, 0);
    assert.equal((await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ action: "renew", clientId }) })).status, 410);
    const next = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "register" }) });
    const nextId = (await next.json() as { clientId: string }).clientId;
    assert.equal((await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ action: "unregister", clientId: nextId }) })).status, 200);
    assert.equal(leases.snapshot().liveClients, 0);
  } finally { await http.close(); }
});

test("HTTP rejects missing/bad authentication, hostile Origin/Host, query paths and oversize bodies", async () => {
  const f = await fixture({ maxBodyBytes: 256 });
  try {
    assert.equal((await fetch(f.http.url)).status, 401);
    assert.equal((await fetch(f.http.url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const headers = { Authorization: `Bearer ${f.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(f.http.url, { headers: { ...headers, Origin: "https://attacker.invalid" } })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(f.http.url, { headers: { ...headers, Host: "attacker.invalid" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(`${f.http.url}?secret=x`, { headers })).status, 404);
    assert.equal((await fetch(f.http.url, { headers })).status, 405);
    assert.equal((await fetch(f.http.url, { method: "POST", headers, body: "x".repeat(257) })).status, 413);
    assert.equal((await fetch(f.http.url, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal(f.reads(), 0);
  } finally { await f.close(); }
});

test("core ownership is exclusive and released without deleting lock state", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-core-lock-"));
  const path = join(dir, "lock.sqlite");
  const release = acquireCoreLock(path);
  try { assert.throws(() => acquireCoreLock(path), /SHARED_CORE_ALREADY_RUNNING/); }
  finally { release(); }
  acquireCoreLock(path)();
  rmSync(dir, { recursive: true, force: true });
});

test("HTTP refuses an empty or weak token before binding", async () => {
  await assert.rejects(startHttpServer(() => { throw Error("unused"); }, { token: "weak" }), /HTTP_TOKEN_REQUIRED/);
});

test("authenticated health checks do not extend core activity", async () => {
  let now = 1_000;
  const token = randomBytes(32).toString("base64url");
  const http = await startHttpServer(() => { throw Error("unused"); }, { token, now: () => now });
  const headers = { Authorization: `Bearer ${token}` };
  try {
    assert.equal(http.diagnostics().lastActivityAtMs, 1_000);
    now = 9_000;
    assert.equal((await fetch(http.url.replace("/mcp", "/health"), { headers })).status, 200);
    assert.equal(http.diagnostics().lastActivityAtMs, 1_000);
  } finally { await http.close(); }
});

test("disconnected in-flight work retains its concurrency slot; overload does not start another job", { timeout: 10_000 }, async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const token = randomBytes(32).toString("base64url");
  let calls = 0;
  const http = await startHttpServer(() => {
    const server = new McpServer({ name: "slow-test", version: "1" });
    server.registerTool("slow", { inputSchema: {} }, async () => {
      calls++; entered(); await gate;
      return { content: [{ type: "text", text: "done" }] };
    });
    return server;
  }, { token, maxConcurrentRequests: 1 });
  const controller = new AbortController();
  const init = { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }) };
  try {
    const first = fetch(http.url, { ...init, signal: controller.signal }).catch(() => null);
    await started;
    controller.abort(); await first;
    assert.equal((await fetch(http.url, init)).status, 503);
    assert.equal(calls, 1);
    release();
    for (let i = 0; i < 100 && http.diagnostics().activeRequests; i++) await delay(10);
    assert.equal(http.diagnostics().activeRequests, 0);
  } finally { release(); await http.close(); }
});

test("wire-only stdio connector uses existing HTTP service and exits on EOF", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const env = { ...process.env, CODEX_QUOTA_GUARD_HTTP_URL: f.http.url, CODEX_QUOTA_GUARD_HTTP_TOKEN: f.token };
  const client = new Client({ name: "connector-test", version: "1" });
  try {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", resolve("src/http-connector.ts")], env, stderr: "pipe" });
    await client.connect(transport);
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.equal((await client.listTools()).tools.length, 8);
    await client.callTool({ name: "quota_status", arguments: {} });
    await client.close();
    assert.equal(f.reads(), 1);
    const child = spawn(process.execPath, ["--import", "tsx", resolve("src/http-connector.ts")], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    child.stdout.resume(); child.stderr.resume();
    child.stdin.end();
    assert.equal(await exit, 0);
    assert.equal((await f.connect()).getServerVersion()?.name, "codex-quota-guard-mcp");
  } finally { await client.close(); await f.close(); }
});

test("OS releases singleton lock after the owning process crashes", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-lock-crash-"));
  const path = join(dir, "lock.sqlite");
  // Native type stripping avoids creating a compiler worker in the deliberately killed child.
  const source = `import { acquireCoreLock } from './src/core-lock.ts'; globalThis.lockRelease=acquireCoreLock(process.env.QUOTA_LOCK_TEST_PATH); process.send('locked'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, QUOTA_LOCK_TEST_PATH: path }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // Wait for IPC/process handles too, not only exit notification (Windows cleanup).
  const exit = new Promise(resolve => child.once("close", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("lock owner did not become ready")), 5_000);
      child.on("message", message => { if (message === "locked") { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(Error("lock owner exited before readiness")); });
    });
    assert.throws(() => acquireCoreLock(path), /ALREADY_RUNNING/);
    child.kill(); await exit;
    acquireCoreLock(path)();
  } finally { child.kill(); await exit; await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

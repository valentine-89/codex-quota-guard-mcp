// Bounded no-inference acceptance. Guard state is isolated; login state is never read/copied.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.argv.includes("--child")) {
  await import("../dist/http-main.js");
  process.on("message", async message => {
    if (message === "stop") { process.emit("SIGTERM"); return; }
    if (message !== "scheduler-probe") return;
    const client = new Client({ name: "shared-core-read-only-probe", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER], env: process.env, stderr: "pipe" });
    transport.stderr?.resume();
    try {
      await client.connect(transport, { timeout: 10_000 });
      const inventory = await client.listTools({}, { timeout: 10_000 });
      const readTool = inventory.tools.find(t => t.name === "list_threads");
      assert.ok(readTool, "shipped read-only task inventory unavailable");
      const result = await client.callTool({ name: readTool.name, arguments: { limit: 1 },
        _meta: { threadId: process.env.QUOTA_PROBE_TASK_ID } }, undefined, { timeout: 10_000 });
      assert.ok(!result.isError, "desktop rejected read-only dispatch");
      process.send?.({ schedulerReadAfterDisconnect: true, mutationAttempted: false });
    } catch { process.send?.({ schedulerReadAfterDisconnect: false, mutationAttempted: false }); }
    finally { await client.close(); }
  });
} else {
  assert.equal(process.platform, "win32", "This live acceptance targets a Windows-hosted registration");
  const taskId = process.env.QUOTA_PROBE_TASK_ID;
  assert.ok(taskId, "QUOTA_PROBE_TASK_ID must be this real Codex task ID");
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome, "CODEX_HOME must identify the actual Windows Codex home");
  const registration = parse(readFileSync(join(codexHome, "config.toml"), "utf8")).mcp_servers.codex_quota_guard;
  const env = { ...process.env, ...registration.env };
  // Only inherit an existing capability; never print or persist its value.
  for (const key of registration.env_vars ?? []) if (typeof key === "string" && process.env[key]) env[key] = process.env[key];
  assert.ok(env.CODEX_APP_TOOLS_PIPE_PATH && env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER, "desktop capability missing");
  const dir = mkdtempSync(join(tmpdir(), "quota-shared-live-"));
  const config = env.CODEX_QUOTA_GUARD_CONFIG ? JSON.parse(readFileSync(env.CODEX_QUOTA_GUARD_CONFIG, "utf8")) : {};
  config.stateDir = dir;
  config.codexHome = codexHome;
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  env.CODEX_QUOTA_GUARD_CONFIG = join(dir, "config.json");
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  env.CODEX_QUOTA_GUARD_HTTP_PORT = String(port);
  env.CODEX_QUOTA_GUARD_HTTP_TOKEN = randomBytes(32).toString("base64url");
  env.CODEX_QUOTA_GUARD_HTTP_URL = `http://127.0.0.1:${port}/mcp`;
  const child = spawn(process.execPath, [resolve("scripts/shared-core-acceptance.mjs"), "--child"], {
    env, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr.resume();
  const exited = new Promise(resolve => child.once("exit", resolve));
  const clients = [];
  const headers = { Authorization: `Bearer ${env.CODEX_QUOTA_GUARD_HTTP_TOKEN}` };
  const health = () => fetch(`http://127.0.0.1:${port}/health`, { headers, signal: AbortSignal.timeout(1_000) }).then(r => r.json());
  try {
    let ready;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { try { ready = await health(); break; } catch { await delay(50); } }
    assert.equal(ready?.pid, child.pid);
    for (let index = 0; index < 6; index++) {
      const client = new Client({ name: `shared-live-${index}`, version: "1" }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(env.CODEX_QUOTA_GUARD_HTTP_URL), { requestInit: { headers } }));
      assert.equal((await client.listTools()).tools.length, 8);
    }
    const first = (await clients[0].callTool({ name: "quota_status", arguments: {} })).structuredContent;
    assert.equal(first.stale, false);
    for (const client of clients) {
      const q = (await client.callTool({ name: "quota_status", arguments: {} })).structuredContent;
      assert.equal(q.fetchedAt, first.fetchedAt);
    }
    await Promise.all(clients.map(c => c.close()));
    const noClients = await health();
    assert.equal(noClients.pid, child.pid);
    assert.equal(noClients.activeRequests, 0);
    const schedulerResult = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("scheduler probe timeout")), 30_000);
      child.once("message", result => { clearTimeout(timer); resolve(result); });
    });
    child.send("scheduler-probe");
    const scheduler = await schedulerResult;
    assert.equal(scheduler.schedulerReadAfterDisconnect, true);
    const interop = process.argv.includes("--wsl");
    const connector = new Client({ name: "shared-connector-live", version: "1" }); clients.push(connector);
    let command = process.execPath, args = [resolve("dist/http-connector.js")];
    if (interop) {
      // Execute Windows Node from WSL: no LAN listener and no Linux/Windows SQLite mixing.
      command = "wsl.exe";
      const windowsNode = registration.env?.CODEX_QUOTA_GUARD_NODE ?? process.execPath;
      const wslNode = execFileSync("wsl.exe", ["--exec", "wslpath", "-u", windowsNode], { encoding: "utf8" }).trim();
      args = ["--exec", wslNode, resolve("dist/http-connector.js")];
      const forwarded = ["CODEX_QUOTA_GUARD_HTTP_TOKEN", "CODEX_QUOTA_GUARD_HTTP_URL"];
      env.WSLENV = [...new Set([...(env.WSLENV ?? "").split(":").filter(Boolean).map(s => s.replace(/\/w$/, "")), ...forwarded])].join(":");
    }
    await connector.connect(new StdioClientTransport({ command, args, env, stderr: "pipe" }));
    const q = (await connector.callTool({ name: "quota_status", arguments: {} })).structuredContent;
    assert.equal(q.fetchedAt, first.fetchedAt);
    await connector.close();
    console.log(JSON.stringify({ accepted: true, clients: 6, sameQuotaSnapshot: true,
      coreSurvivedClientDisconnect: true, monitorNeedsClient: q.monitor.requiresLiveClientConnection,
      connector: interop ? "WSL-to-Windows" : "Windows", ...scheduler,
      quotaStale: q.stale, server: clients[0].getServerVersion(),
      desktopRestartVerified: false, automaticBootstrapVerified: false }));
  } finally {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    if (child.connected) child.send("stop");
    const timer = setTimeout(() => child.kill(), 6_000);
    await exited; clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

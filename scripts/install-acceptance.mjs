// Disposable cross-platform install and concurrent-connector lifecycle acceptance.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { managedHealth, readManagedSettings } from "../dist/managed.js";

const directory = mkdtempSync(join(tmpdir(), "quota-install-"));
const home = join(directory, "home"); mkdirSync(home, { mode: 0o700 });
const configPath = join(home, "config.toml");
writeFileSync(configPath, `# preserved\nmodel = "fixture-only"\n[mcp_servers.unrelated]\ncommand = "never-run"\n`);
const env = { ...process.env, CODEX_HOME: home, CODEX_QUOTA_GUARD_CONFIG: "",
  CODEX_QUOTA_GUARD_STATE_DIR: "", CODEX_QUOTA_GUARD_MANAGED_SETTINGS: "",
  CODEX_APP_TOOLS_PIPE_PATH: "", CODEX_THREAD_ID: "" };
let settings;
const clients = [];
try {
  const first = JSON.parse(execFileSync(process.execPath, [resolve("scripts/install.mjs")],
    { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const second = JSON.parse(execFileSync(process.execPath, [resolve("scripts/install.mjs")],
    { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(first.settingsPath, second.settingsPath);
  const text = readFileSync(configPath, "utf8"), config = parse(text);
  assert.ok(text.includes("# preserved"));
  assert.equal(config.mcp_servers.unrelated.command, "never-run");
  assert.ok(config.mcp_servers.codex_quota_guard.args.at(-1).endsWith(`${join("dist", "connector.js")}`));
  settings = readManagedSettings(first.settingsPath);
  assert.ok(!text.includes(settings.token));
  const registration = config.mcp_servers.codex_quota_guard;
  const connect = async () => {
    const client = new Client({ name: "install-acceptance", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: registration.command, args: registration.args,
      env: { ...getDefaultEnvironment(), ...registration.env }, stderr: "pipe" }));
    assert.equal((await client.listTools()).tools.length, 8);
  };
  await Promise.all(Array.from({ length: 6 }, connect));
  const health = await managedHealth(settings);
  assert.equal(health?.liveClients, 6); assert.equal(health?.mode, "shared-http");
  const pid = health.pid;
  await Promise.all(clients.map(client => client.close())); clients.length = 0;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && await managedHealth(settings).catch(() => null)) {
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(await managedHealth(settings).catch(() => null), null);
  const uninstall = JSON.parse(execFileSync(process.execPath, [resolve("scripts/uninstall.mjs"), "--purge"],
    { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(uninstall.removed, true); assert.equal(uninstall.purged, true);
  const after = parse(readFileSync(configPath, "utf8"));
  assert.equal(after.mcp_servers.unrelated.command, "never-run");
  assert.equal(after.mcp_servers.codex_quota_guard, undefined);
  assert.equal(existsSync(first.settingsPath), false);
  console.log(JSON.stringify({ installedTwice: true, unrelatedConfigPreserved: true, connectors: 6,
    singletonPid: pid, coreStoppedAfterDisconnect: true, uninstallPurgedOwnedState: true,
    platform: process.platform, arch: process.arch }));
} finally {
  await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  if (settings) {
    const health = await managedHealth(settings).catch(() => null);
    if (typeof health?.pid === "number") { try { process.kill(health.pid); } catch { /* already stopped */ } }
  }
  if (existsSync(directory)) await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

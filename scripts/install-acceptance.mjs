// Disposable cross-platform install and concurrent-connector lifecycle acceptance.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, cpSync, symlinkSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "smol-toml";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { managedHealth, readManagedSettings } from "../dist/managed.js";

const directory = mkdtempSync(join(tmpdir(), "quota-install-"));
const fixtureRoot = join(directory, "tool"); mkdirSync(fixtureRoot);
for (const path of ["scripts", "dist", "package.json"]) cpSync(resolve(path), join(fixtureRoot, path), { recursive: true });
symlinkSync(resolve("node_modules"), join(fixtureRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const home = join(directory, "home"); mkdirSync(home, { mode: 0o700 });
const configPath = join(home, "config.toml");
writeFileSync(configPath, `# preserved\nmodel = "fixture-only"\n[mcp_servers.unrelated]\ncommand = "never-run"\n`);
const env = { ...process.env, CODEX_HOME: home, CODEX_QUOTA_GUARD_CONFIG: "",
  CODEX_QUOTA_GUARD_STATE_DIR: "", CODEX_QUOTA_GUARD_MANAGED_SETTINGS: "",
  CODEX_APP_TOOLS_PIPE_PATH: "", CODEX_THREAD_ID: "" };
let settings;
const clients = [];
const runJson = (script, args = []) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(fixtureRoot, script), ...args],
      { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    if (error?.stdout) process.stderr.write(`installer stdout:\n${error.stdout}`);
    if (error?.stderr) process.stderr.write(`installer stderr:\n${error.stderr}`);
    throw error;
  }
};
try {
  const first = runJson("scripts/install.mjs");
  assert.equal(dirname(dirname(first.settingsPath)), join(fixtureRoot, "data"));
  assert.equal(existsSync(join(home, "quota-guard")), false);
  assert.equal(first.backupPath, undefined);
  assert.ok(!readdirSync(dirname(first.settingsPath)).some(name => name.startsWith("codex-config-before-")));
  const firstSettings = readManagedSettings(first.settingsPath);
  writeFileSync(first.settingsPath, JSON.stringify({ ...firstSettings, releaseVersion: "0.7.5",
    coreEntrypoint: join(directory, "retired", "core.js") }));
  const second = runJson("scripts/install.mjs");
  assert.equal(first.settingsPath, second.settingsPath);
  const upgradedSettings = readManagedSettings(second.settingsPath);
  assert.notEqual(upgradedSettings.installationId, firstSettings.installationId);
  assert.equal(upgradedSettings.guardConfig, firstSettings.guardConfig);
  assert.equal(upgradedSettings.releaseVersion, "2.1.0");
  const third = runJson("scripts/install.mjs");
  assert.equal(readManagedSettings(third.settingsPath).installationId, upgradedSettings.installationId);
  const optedIn = runJson("scripts/install.mjs", ["--enable-auto-reset"]);
  assert.equal(optedIn.automaticWeeklyResetEnabled, true);
  assert.equal(JSON.parse(readFileSync(upgradedSettings.guardConfig, "utf8")).automaticWeeklyReset.enabled, true);
  const text = readFileSync(configPath, "utf8"), config = parse(text);
  assert.ok(text.includes("# preserved"));
  assert.equal(config.mcp_servers.unrelated.command, "never-run");
  assert.ok(config.mcp_servers.codex_quota_guard.args.at(-1).endsWith(`${join("dist", "connector.js")}`));
  assert.equal(config.mcp_servers.codex_quota_guard.default_tools_approval_mode, "approve");
  settings = upgradedSettings;
  assert.ok(!text.includes(settings.token));
  const registration = config.mcp_servers.codex_quota_guard;
  assert.ok(registration.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH"));
  assert.ok(registration.env_vars.includes("CODEX_QUOTA_GUARD_SCHEDULER_SERVER"));
  if (process.platform === "win32") {
    assert.ok(registration.env.WSLENV.split(":").includes("CODEX_APP_TOOLS_PIPE_PATH/w"));
    assert.ok(registration.env.WSLENV.split(":").includes("CODEX_QUOTA_GUARD_SCHEDULER_SERVER/w"));
  }
  const connect = async () => {
    const client = new Client({ name: "install-acceptance", version: "1" }, {
      versionNegotiation: { mode: "legacy" },
    }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: registration.command, args: registration.args,
      env: { ...getDefaultEnvironment(), ...registration.env }, stderr: "pipe" }));
    assert.equal((await client.listTools()).tools.length, 8);
  };
  await Promise.all(Array.from({ length: 6 }, connect));
  // The lease-free discovery core is allowed to stop before the model chooses a
  // tool. Every capability call must therefore revalidate and restart it.
  await new Promise(done => setTimeout(done, 6_000));
  await Promise.all(clients.map(async client => {
    assert.equal((await client.callTool({ name: "quota_status", arguments: { agentProtocol: "auto-reset-v1" } })).isError, undefined);
  }));
  const health = await managedHealth(settings);
  assert.equal(health?.liveClients, 6); assert.equal(health?.mode, "shared-http");
  const pid = health.pid;
  await Promise.all(clients.map(client => client.close())); clients.length = 0;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && await managedHealth(settings).catch(() => null)) {
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(await managedHealth(settings).catch(() => null), null);
  const uninstall = runJson("scripts/uninstall.mjs");
  assert.equal(uninstall.removed, true); assert.equal(uninstall.purged, false);
  assert.equal(existsSync(first.settingsPath), true);
  const after = parse(readFileSync(configPath, "utf8"));
  assert.equal(after.mcp_servers.unrelated.command, "never-run");
  assert.equal(after.mcp_servers.codex_quota_guard, undefined);
  const removedConfig = readFileSync(configPath, "utf8");
  const cleanup = runJson("scripts/uninstall.mjs", ["--purge"]);
  assert.equal(cleanup.removed, false); assert.equal(cleanup.purged, true);
  assert.equal(existsSync(first.settingsPath), false);
  assert.equal(readFileSync(configPath, "utf8"), removedConfig);
  const repeated = runJson("scripts/uninstall.mjs", ["--purge"]);
  assert.equal(repeated.removed, false); assert.equal(repeated.purged, false);
  assert.ok(!readdirSync(home).some(name => name.startsWith("codex-config-before-uninstall-")
    || name.startsWith("config.toml.quota-guard-")));
  // A missing config must not prevent recovery of this profile's managed state.
  runJson("scripts/install.mjs");
  unlinkSync(configPath);
  assert.equal(runJson("scripts/uninstall.mjs", ["--purge"]).purged, true);
  assert.equal(existsSync(configPath), false);
  const outside = join(directory, "unrelated"); mkdirSync(outside);
  const sentinel = join(outside, "keep.txt"); writeFileSync(sentinel, "keep");
  const unsafe = stringify({ mcp_servers: { codex_quota_guard: {
    env: { CODEX_QUOTA_GUARD_MANAGED_SETTINGS: join(outside, "runtime.json") },
  } } });
  writeFileSync(configPath, unsafe);
  assert.throws(() => execFileSync(process.execPath, [join(fixtureRoot, "scripts/uninstall.mjs"), "--purge"],
    { env, windowsHide: true, stdio: "pipe" }));
  assert.equal(readFileSync(configPath, "utf8"), unsafe);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  // A legacy registration is rejected before config, legacy data, or new state changes.
  assert.throws(() => execFileSync(process.execPath, [join(fixtureRoot, "scripts/install.mjs")],
    { env, windowsHide: true, stdio: "pipe" }));
  assert.equal(readFileSync(configPath, "utf8"), unsafe);
  assert.equal(existsSync(first.settingsPath), false);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  // Another profile's valid-looking directory must never be purged.
  const sibling = join(fixtureRoot, "data", `core-${"a".repeat(64)}`); mkdirSync(sibling);
  const siblingSentinel = join(sibling, "keep.txt"); writeFileSync(siblingSentinel, "keep");
  writeFileSync(configPath, stringify({ mcp_servers: { codex_quota_guard: {
    env: { CODEX_QUOTA_GUARD_MANAGED_SETTINGS: join(sibling, "runtime.json") },
  } } }));
  assert.throws(() => execFileSync(process.execPath, [join(fixtureRoot, "scripts/uninstall.mjs"), "--purge"],
    { env, windowsHide: true, stdio: "pipe" }));
  assert.equal(readFileSync(siblingSentinel, "utf8"), "keep");
  // Reject a redirected data root on both install and purge, without elevation.
  writeFileSync(configPath, "");
  const dataPath = join(fixtureRoot, "data");
  rmSync(dataPath, { recursive: true });
  symlinkSync(outside, dataPath, process.platform === "win32" ? "junction" : "dir");
  try {
    for (const script of ["install.mjs", "uninstall.mjs"]) {
      assert.throws(() => execFileSync(process.execPath, [join(fixtureRoot, "scripts", script),
        ...(script === "uninstall.mjs" ? ["--purge"] : [])], { env, windowsHide: true, stdio: "pipe" }));
    }
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
    assert.equal(readFileSync(configPath, "utf8"), "");
  } finally { rmSync(dataPath, { recursive: true }); }
  // Fresh installs also work with no Codex config file.
  unlinkSync(configPath);
  runJson("scripts/install.mjs");
  assert.equal(runJson("scripts/uninstall.mjs", ["--purge"]).purged, true);
  // Reject an unsupported TOML layout rather than silently retaining the registration.
  const inline = 'mcp_servers = { codex_quota_guard = { command = "fixture" }, unrelated = { command = "keep" } }\n';
  writeFileSync(configPath, inline);
  assert.throws(() => execFileSync(process.execPath, [join(fixtureRoot, "scripts/uninstall.mjs")],
    { env, windowsHide: true, stdio: "pipe" }));
  assert.equal(readFileSync(configPath, "utf8"), inline);
  console.log(JSON.stringify({ upgradeRotatedEndpoint: true, sameVersionReinstallStable: true,
    unrelatedConfigPreserved: true, connectors: 6,
    singletonPid: pid, coreStoppedAfterDisconnect: true, uninstallPurgedOwnedState: true,
    purgeAfterUnregister: true, repeatedPurgeSafe: true, missingConfigCleanup: true, uninstallNoBackup: true,
    installationLocalData: true, legacyRejected: true, otherProfileProtected: true, redirectedDataRejected: true,
    installNoBackup: true, platform: process.platform, arch: process.arch }));
} finally {
  await Promise.all(clients.map(client => client.close().catch(() => undefined)));
  if (settings) {
    const health = await managedHealth(settings).catch(() => null);
    if (typeof health?.pid === "number") { try { process.kill(health.pid); } catch { /* already stopped */ } }
  }
  if (existsSync(directory)) await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

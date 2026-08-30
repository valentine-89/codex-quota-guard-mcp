// Disposable Windows installation: no account/quotas, automation mutation or model call.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { parse } from "smol-toml";
import { profileKey, StateStore } from "../dist/store.js";
import { managedFile, readManagedSettings, managedHealth } from "../dist/managed.js";

if (process.platform !== "win32") throw Error("Windows-only installer acceptance");
const directory = mkdtempSync(join(tmpdir(), "quota-managed-install-"));
const home = join(directory, "home"), state = join(directory, "state");
mkdirSync(home); mkdirSync(state);
const configPath = join(home, "config.toml");
const legacyDirectory = join(state, "managed-legacy"); mkdirSync(legacyDirectory);
const legacyGuard = join(legacyDirectory, "guard.json"), legacySettings = join(legacyDirectory, "runtime.json");
const reservation = createServer();
await new Promise(resolveReady => reservation.listen(0, "127.0.0.1", resolveReady));
const legacyPort = reservation.address().port;
await new Promise(resolveClose => reservation.close(resolveClose));
writeFileSync(legacyGuard, JSON.stringify({ stateDir: state, codexHome: home, monitorEnabled: false,
  weeklyOnlyRemainingPercent: 4 }));
writeFileSync(legacySettings, JSON.stringify({ revision: 1, installationId: randomUUID(), port: legacyPort,
  token: randomBytes(32).toString("base64url"), nodeExecutable: process.execPath,
  coreEntrypoint: resolve("dist/http-main.js"), guardConfig: legacyGuard }));
const legacyStore = new StateStore(join(state, "state.sqlite"));
legacyStore.createCheckpoint(profileKey(home), { workspaceRoot: directory, taskId: "migration-task",
  objective: "preserve", completed: ["legacy"], pending: [] }, null, Date.now());
legacyStore.close();
writeFileSync(configPath, `# Keep this comment\nmodel = "fixture-only"\n[mcp_servers.unrelated]\ncommand = "never-run"\n[mcp_servers.codex_quota_guard]\ncommand = "old-fixture"\nargs = []\n[mcp_servers.codex_quota_guard.env]\nCODEX_QUOTA_GUARD_MANAGED_SETTINGS = '${legacySettings}'\n`);
const settingsPath = managedFile(join(home, "quota-guard"), profileKey(home));
const env = { ...process.env, CODEX_HOME: home, CODEX_QUOTA_GUARD_STATE_DIR: state,
  CODEX_QUOTA_GUARD_CONFIG: "", CODEX_QUOTA_GUARD_MANAGED_SETTINGS: "", CODEX_APP_TOOLS_PIPE_PATH: "",
  CODEX_QUOTA_GUARD_SCHEDULER_SERVER: "", CODEX_THREAD_ID: "" };
try {
  let first;
  for (let i = 0; i < 2; i++) {
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/install-managed.mjs")],
      { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(result.installed, true);
    const text = readFileSync(configPath, "utf8"), config = parse(text);
    assert.ok(text.includes("# Keep this comment"));
    assert.equal(config.model, "fixture-only");
    assert.equal(config.mcp_servers.unrelated.command, "never-run");
    assert.equal(config.mcp_servers.codex_quota_guard.command, "node.exe");
    assert.ok(config.mcp_servers.codex_quota_guard.args.at(-1).endsWith("dist\\http-connector.js"));
    const settings = readManagedSettings(settingsPath);
    assert.ok(!text.includes(settings.token));
    const migratedConfig = JSON.parse(readFileSync(settings.guardConfig, "utf8"));
    assert.equal(migratedConfig.weeklyOnlyRemainingPercent, 4);
    const migratedStore = new StateStore(join(migratedConfig.stateDir, "state.sqlite"));
    assert.equal(migratedStore.getCheckpoint(profileKey(home), directory, "migration-task")?.objective, "preserve");
    migratedStore.close();
    if (first) assert.equal(result.pid, first.pid);
    first = result;
  }
  console.log(JSON.stringify({ installedTwice: true, sameCore: true, unrelatedConfigPreserved: true,
    tokenNotInCodexConfig: true, shellWrapperAbsent: true, legacyStateMigrated: true }));
} finally {
  if (existsSync(settingsPath)) {
    // Only the installation generated inside this disposable directory is in scope.
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", resolve("scripts/managed-supervisor.ps1"), "-Remove", "-SettingsPath", settingsPath], { windowsHide: true, stdio: "pipe" });
    const health = await managedHealth(readManagedSettings(settingsPath)).catch(() => null);
    if (health?.pid) { try { process.kill(health.pid); } catch { /* Already stopped. */ } }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

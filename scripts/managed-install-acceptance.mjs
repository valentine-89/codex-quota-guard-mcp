// Disposable Windows installation: no account/quotas, automation mutation or model call.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { profileKey } from "../dist/store.js";
import { managedFile, readManagedSettings, managedHealth } from "../dist/managed.js";

if (process.platform !== "win32") throw Error("Windows-only installer acceptance");
const directory = mkdtempSync(join(tmpdir(), "quota-managed-install-"));
const home = join(directory, "home"), state = join(directory, "state");
mkdirSync(home); mkdirSync(state);
const configPath = join(home, "config.toml");
writeFileSync(configPath, '# Keep this comment\nmodel = "fixture-only"\n[mcp_servers.unrelated]\ncommand = "never-run"\n[mcp_servers.codex_quota_guard]\ncommand = "old-fixture"\nargs = []\n');
const settingsPath = managedFile(state, profileKey(home));
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
    assert.ok(config.mcp_servers.codex_quota_guard.args.at(-1).endsWith("connect-shared-windows.cmd"));
    const settings = readManagedSettings(settingsPath);
    assert.ok(!text.includes(settings.token));
    if (first) assert.equal(result.pid, first.pid);
    first = result;
  }
  console.log(JSON.stringify({ installedTwice: true, sameCore: true, unrelatedConfigPreserved: true, tokenNotInCodexConfig: true }));
} finally {
  if (existsSync(settingsPath)) {
    // Only the installation generated inside this disposable directory is in scope.
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", resolve("scripts/managed-supervisor.ps1"), "-Remove", "-SettingsPath", settingsPath], { windowsHide: true, stdio: "pipe" });
    const health = await managedHealth(readManagedSettings(settingsPath)).catch(() => null);
    if (health?.pid) { try { process.kill(health.pid); } catch { /* Already stopped. */ } }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

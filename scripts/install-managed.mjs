// Explicit Windows deployment: provision -> healthy core -> user supervisor -> registration.
// Does not terminate existing Codex sessions or alter any unrelated MCP registration.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { ensureManagedCore, managedFile, managedHealth, bindManagedDesktop, readManagedSettings } from "../dist/managed.js";
import { profileKey } from "../dist/store.js";

if (process.platform !== "win32") throw Error("Run this installer using Windows Node, including from WSL");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const configPath = join(home, "config.toml");
const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const config = parse(original);
const registration = config.mcp_servers?.codex_quota_guard ?? {};
const env = { ...process.env, ...registration.env, CODEX_HOME: home };
const desiredSettingsPath = managedFile(join(home, "quota-guard"), profileKey(home));
const previousSettingsPath = registration.env?.CODEX_QUOTA_GUARD_MANAGED_SETTINGS;
let retiredSettingsPath, previousSettings, previousWasHealthy = false;
if (typeof previousSettingsPath === "string" && existsSync(previousSettingsPath)
  && resolve(previousSettingsPath) !== resolve(desiredSettingsPath)) {
  previousSettings = readManagedSettings(previousSettingsPath);
  const health = await managedHealth(previousSettings).catch(() => null);
  previousWasHealthy = !!health;
  execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "managed-supervisor.ps1"),
    "-Remove", "-SettingsPath", previousSettingsPath], { windowsHide: true, stdio: "pipe" });
  retiredSettingsPath = `${previousSettingsPath}.retired-${randomUUID()}`;
  renameSync(previousSettingsPath, retiredSettingsPath);
  if (typeof health?.pid === "number") {
    process.kill(health.pid);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { process.kill(health.pid, 0); }
      catch { break; }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
  }
  env.CODEX_QUOTA_GUARD_MIGRATE_FROM_SETTINGS = retiredSettingsPath;
}
// Only the explicitly configured guard options feed provisioning. No login file access.
let provision;
try {
  provision = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "provision-managed.mjs")],
    { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
} catch (error) {
  if (retiredSettingsPath && previousSettingsPath && existsSync(retiredSettingsPath)) {
    renameSync(retiredSettingsPath, previousSettingsPath);
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "managed-supervisor.ps1"),
      "-SettingsPath", previousSettingsPath], { windowsHide: true, stdio: "pipe" });
    if (previousWasHealthy) await ensureManagedCore(previousSettingsPath).catch(() => undefined);
  }
  throw error;
}
const settings = await ensureManagedCore(provision.settingsPath);
const binding = await bindManagedDesktop(settings, process.env.CODEX_THREAD_ID).catch(() => false);
const supervisor = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File",
  join(root, "scripts", "managed-supervisor.ps1"), "-SettingsPath", provision.settingsPath],
{ windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const forwarded = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_THREAD_ID"];
const newEnvironment = { ...registration.env, CODEX_HOME: home,
  CODEX_QUOTA_GUARD_NODE: settings.nodeExecutable, CODEX_QUOTA_GUARD_MANAGED_SETTINGS: provision.settingsPath };
newEnvironment.WSLENV = [...new Set([...(newEnvironment.WSLENV ?? "").split(":").filter(Boolean),
  ...forwarded.map(key => `${key}/w`), "CODEX_QUOTA_GUARD_MANAGED_SETTINGS/w", "CODEX_QUOTA_GUARD_NODE/w", "CODEX_HOME/w"])].join(":");
// node.exe resolves natively on Windows and through normal WSL interop, without a console-shell wrapper.
const next = { ...registration, command: "node.exe",
  args: [join(root, "dist", "http-connector.js")],
  startup_timeout_sec: 60, env_vars: [...new Set([...(registration.env_vars ?? []), ...forwarded])], env: newEnvironment };
// Transport fields from an existing HTTP entry cannot coexist with stdio configuration.
for (const key of ["url", "bearer_token_env_var", "http_headers", "env_http_headers"]) delete next[key];
const replacement = stringify({ mcp_servers: { codex_quota_guard: next } });
const lines = original.split(/(?<=\n)/);
let inGuard = false, inserted = false;
const result = [];
for (const line of lines) {
  if (/^\s*\[/.test(line)) {
    inGuard = /^\s*\[mcp_servers\.codex_quota_guard(?:\]|\.)/.test(line);
    if (inGuard && !inserted) { result.push(`${replacement}\n`); inserted = true; }
  }
  if (!inGuard) result.push(line);
}
if (!inserted) result.push(`\n${replacement}`);
const updated = result.join("");
const check = parse(updated);
// Refuse unusual TOML representations rather than corrupting other configuration.
delete check.mcp_servers.codex_quota_guard;
const expected = structuredClone(config);
if (expected.mcp_servers) delete expected.mcp_servers.codex_quota_guard;
else expected.mcp_servers = {};
if (JSON.stringify(check) !== JSON.stringify(expected)) throw Error("Unusual TOML layout; registration unchanged, merge manually");
if ((existsSync(configPath) ? readFileSync(configPath, "utf8") : "") !== original) throw Error("Codex config changed during setup; registration unchanged");
const backupPath = join(dirname(provision.settingsPath), `codex-config-before-${randomUUID()}.toml`);
writeFileSync(backupPath, original, { flag: "wx", mode: 0o600 });
const temporary = `${configPath}.quota-guard-${randomUUID()}.tmp`;
writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
renameSync(temporary, configPath);
const health = await managedHealth(settings);
console.log(JSON.stringify({ installed: true, settingsPath: provision.settingsPath, backupPath,
  taskName: supervisor.taskName, pid: health?.pid, schedulerBound: binding,
  existingSessionsUnchanged: !retiredSettingsPath, retiredPreviousSettings: !!retiredSettingsPath,
  migratedState: provision.migratedState === true, fallback: false }));

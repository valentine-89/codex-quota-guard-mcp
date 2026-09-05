// Removes the registration; --purge also removes the current profile's managed state.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { managedFile, managedHealth, readManagedSettings } from "../dist/managed.js";
import { profileKey } from "../dist/store.js";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--purge")) throw Error("Unknown uninstaller option");
const purge = args.includes("--purge");
const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const configPath = join(home, "config.toml");
const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const config = parse(original);
const registration = config.mcp_servers?.codex_quota_guard;
const stateRoot = join(home, "quota-guard");
// Recover only this profile's deterministic managed path, never scan for old installations.
const settingsPath = registration?.env?.CODEX_QUOTA_GUARD_MANAGED_SETTINGS
  ?? managedFile(stateRoot, profileKey(home));
if (typeof settingsPath !== "string" || !isAbsolute(settingsPath)) throw Error("Invalid managed settings path");
const directory = resolve(dirname(settingsPath));
if (purge) {
  const scope = relative(stateRoot, directory);
  if (!/^core-[a-f0-9]{64}$/.test(scope) || resolve(stateRoot, scope) !== directory) {
    throw Error("Refusing to purge an unrecognized state directory");
  }
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink()
    || lstatSync(stateRoot).isSymbolicLink()
    || relative(realpathSync(stateRoot), realpathSync(directory)) !== scope)) {
    throw Error("Refusing to purge redirected state");
  }
}
const settings = existsSync(settingsPath) ? readManagedSettings(settingsPath) : null;
if (registration) {
  let inGuard = false;
  const updated = original.split(/(?<=\n)/).filter(line => {
    if (/^\s*\[/.test(line)) inGuard = /^\s*\[mcp_servers\.codex_quota_guard(?:\]|\.)/.test(line);
    return !inGuard;
  }).join("");
  const checked = parse(updated);
  const expected = structuredClone(config);
  delete expected.mcp_servers.codex_quota_guard;
  // TOML can omit the now-empty parent table after removing its last child.
  if (expected.mcp_servers && !Object.keys(expected.mcp_servers).length) delete expected.mcp_servers;
  if (checked.mcp_servers && !Object.keys(checked.mcp_servers).length) delete checked.mcp_servers;
  if (JSON.stringify(checked) !== JSON.stringify(expected)) throw Error("Unusual TOML layout; registration unchanged, merge manually");
  const temporary = `${configPath}.quota-guard-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    if ((existsSync(configPath) ? readFileSync(configPath, "utf8") : "") !== original) {
      throw Error("Codex config changed during removal; registration unchanged");
    }
    renameSync(temporary, configPath);
    if (process.platform !== "win32") chmodSync(configPath, 0o600);
  } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
}
let stopped = false;
if (settings) {
  const health = await managedHealth(settings).catch(() => null);
  if (typeof health?.pid === "number") { try { process.kill(health.pid); stopped = true; } catch { /* already stopped */ } }
}
let purged = false;
if (purge && existsSync(directory)) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  purged = true;
}
console.log(JSON.stringify({ removed: !!registration, stopped, purged,
  ...(!registration ? { reason: "not-installed" } : {}) }));

// Removes only the Guard registration. --purge additionally removes its validated private v0.6 state.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { managedHealth, readManagedSettings } from "../dist/managed.js";

const purge = process.argv.includes("--purge");
const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const configPath = join(home, "config.toml");
if (!existsSync(configPath)) throw Error("Codex config does not exist");
const original = readFileSync(configPath, "utf8");
const config = parse(original);
const registration = config.mcp_servers?.codex_quota_guard;
if (!registration) { console.log(JSON.stringify({ removed: false, reason: "not-installed" })); process.exit(0); }
const settingsPath = registration.env?.CODEX_QUOTA_GUARD_MANAGED_SETTINGS;
const settings = typeof settingsPath === "string" && existsSync(settingsPath) ? readManagedSettings(settingsPath) : null;
const lines = original.split(/(?<=\n)/);
let inGuard = false;
const updated = lines.filter(line => {
  if (/^\s*\[/.test(line)) inGuard = /^\s*\[mcp_servers\.codex_quota_guard(?:\]|\.)/.test(line);
  return !inGuard;
}).join("");
const backupRoot = home;
const backupPath = join(backupRoot, `codex-config-before-uninstall-${randomUUID()}.toml`);
writeFileSync(backupPath, original, { flag: "wx", mode: 0o600 });
const temporary = `${configPath}.quota-guard-${randomUUID()}.tmp`;
writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
if (process.platform !== "win32") { chmodSync(backupPath, 0o600); chmodSync(temporary, 0o600); }
renameSync(temporary, configPath);
if (process.platform !== "win32") chmodSync(configPath, 0o600);
let stopped = false;
if (settings) {
  const health = await managedHealth(settings).catch(() => null);
  if (typeof health?.pid === "number") { try { process.kill(health.pid); stopped = true; } catch { /* already stopped */ } }
}
let purged = false;
if (purge && settingsPath) {
  const directory = resolve(dirname(settingsPath));
  const stateRoot = resolve(join(home, "quota-guard"));
  const scope = relative(stateRoot, directory);
  if (!scope || scope.startsWith("..") || resolve(stateRoot, scope) !== directory || !/^core-[a-f0-9]{64}$/.test(scope)) {
    throw Error("Refusing to purge an unrecognized state directory");
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  purged = true;
}
console.log(JSON.stringify({ removed: true, stopped, purged, backupPath }));

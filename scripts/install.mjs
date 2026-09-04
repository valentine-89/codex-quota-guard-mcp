// Cross-platform, non-elevated installer for the on-demand authenticated connector.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { readManagedSettings } from "../dist/managed.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const configPath = join(home, "config.toml");
mkdirSync(home, { recursive: true, mode: 0o700 });
const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const config = parse(original);
const registration = config.mcp_servers?.codex_quota_guard ?? {};
const env = { ...process.env, ...registration.env, CODEX_HOME: home,
  CODEX_QUOTA_GUARD_MANAGED_SETTINGS: "", CODEX_QUOTA_GUARD_MIGRATE_FROM_SETTINGS: "" };
const provision = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "provision-managed.mjs")],
  { env, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const settings = readManagedSettings(provision.settingsPath);
const forwarded = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH", "CODEX_THREAD_ID",
  "CODEX_QUOTA_GUARD_SCHEDULER_SERVER"];
const newEnvironment = { ...registration.env, CODEX_HOME: home,
  CODEX_QUOTA_GUARD_NODE: settings.nodeExecutable, CODEX_QUOTA_GUARD_MANAGED_SETTINGS: provision.settingsPath };
if (process.platform === "win32") {
  newEnvironment.WSLENV = [...new Set([...(newEnvironment.WSLENV ?? "").split(":").filter(Boolean),
    ...forwarded.map(key => `${key}/w`), "CODEX_QUOTA_GUARD_MANAGED_SETTINGS/w", "CODEX_QUOTA_GUARD_NODE/w", "CODEX_HOME/w"])].join(":");
}
const next = { ...registration, command: settings.nodeExecutable,
  args: [join(root, "dist", "connector.js")], startup_timeout_sec: 60,
  default_tools_approval_mode: "approve",
  env_vars: [...new Set([...(registration.env_vars ?? []), ...forwarded])], env: newEnvironment };
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
if (!inserted) result.push(`${original && !original.endsWith("\n") ? "\n" : ""}${replacement}`);
const updated = result.join("");
const checked = parse(updated);
delete checked.mcp_servers.codex_quota_guard;
const expected = structuredClone(config);
if (expected.mcp_servers) delete expected.mcp_servers.codex_quota_guard;
else expected.mcp_servers = {};
if (JSON.stringify(checked) !== JSON.stringify(expected)) throw Error("Unusual TOML layout; registration unchanged, merge manually");
if ((existsSync(configPath) ? readFileSync(configPath, "utf8") : "") !== original) throw Error("Codex config changed during setup; registration unchanged");
const backupPath = join(dirname(provision.settingsPath), `codex-config-before-${randomUUID()}.toml`);
writeFileSync(backupPath, original, { flag: "wx", mode: 0o600 });
const temporary = `${configPath}.quota-guard-${randomUUID()}.tmp`;
writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
if (process.platform !== "win32") { chmodSync(backupPath, 0o600); chmodSync(temporary, 0o600); }
renameSync(temporary, configPath);
if (process.platform !== "win32") chmodSync(configPath, 0o600);
console.log(JSON.stringify({ installed: true, platform: process.platform, arch: process.arch,
  settingsPath: provision.settingsPath, backupPath, onDemand: true, scheduledTask: false,
  serviceInstalled: false, migrationPerformed: false }));

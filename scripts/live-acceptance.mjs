import { resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values } = parseArgs({ options: {
  isolated: { type: "boolean", default: false },
  command: { type: "string" },
  "args-json": { type: "string" },
  summary: { type: "boolean", default: false },
} });
const environment = getDefaultEnvironment();
for (const name of ["CODEX_HOME", "CODEX_CLI_PATH", "CODEX_QUOTA_GUARD_STATE_DIR", "CODEX_QUOTA_GUARD_CONFIG",
  "CODEX_QUOTA_GUARD_NODE", "CODEX_QUOTA_GUARD_MANAGED_SETTINGS", "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_MCP_NODE_PATH", "CODEX_THREAD_ID", "WSLENV", "WSL_INTEROP"]) {
  if (process.env[name]) environment[name] = process.env[name];
}
const customArgs = values["args-json"] ? JSON.parse(values["args-json"]) : null;
assert.ok(customArgs === null || (Array.isArray(customArgs) && customArgs.every((arg) => typeof arg === "string")),
  "--args-json must be a string array");
assert.ok(!values.isolated || customArgs !== null,
  "--isolated is available only with an explicit --args-json custom entrypoint");
let command = values.command ?? process.execPath;
let args = customArgs;
let transportKind = "custom";
if (args === null) {
  const codexHome = environment.CODEX_HOME ?? join(homedir(), ".codex");
  const config = parse(readFileSync(join(codexHome, "config.toml"), "utf8")).mcp_servers?.codex_quota_guard;
  assert.ok(config && typeof config.command === "string" && Array.isArray(config.args)
    && config.args.every((arg) => typeof arg === "string"), "Installed codex_quota_guard registration is missing or invalid");
  command = config.command;
  args = config.args;
  Object.assign(environment, config.env ?? {});
  for (const name of config.env_vars ?? []) {
    if (typeof name === "string" && process.env[name]) environment[name] = process.env[name];
  }
  transportKind = "registered";
}
assert.ok(!(values.isolated && process.platform !== "win32" && /\.exe$/i.test(command)),
  "Run --isolated from Windows when targeting a Windows executable; Linux temporary paths cannot configure the Windows server.");
// Isolate only guard state, never login state. Preserve custom runtime configuration.
let isolatedStateDir = null;
if (values.isolated) {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "quota-live-acceptance-"));
  const config = environment.CODEX_QUOTA_GUARD_CONFIG
    ? JSON.parse(readFileSync(environment.CODEX_QUOTA_GUARD_CONFIG, "utf8")) : {};
  config.stateDir = isolatedStateDir;
  const configPath = join(isolatedStateDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  environment.CODEX_QUOTA_GUARD_CONFIG = configPath;
  environment.CODEX_QUOTA_GUARD_STATE_DIR = isolatedStateDir;
}
const transport = new StdioClientTransport({
  command,
  args,
  cwd: root,
  env: environment,
  stderr: "pipe",
});
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const client = new Client({ name: "codex-quota-guard-live-acceptance", version: packageVersion });

try {
  await client.connect(transport);
  const server = client.getServerVersion();
  assert.equal(server?.version, packageVersion, `Registered entrypoint must expose MCP v${packageVersion}`);
  const instructions = client.getInstructions();
  assert.ok(typeof instructions === "string"
    && ["quota_status", "job_preflight", "defer_until_reset", "resume_prepare"].every((name) => instructions.includes(name)),
  "Registered entrypoint must expose the cross-tool server instructions");
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["checkpoint_create", "checkpoint_get", "defer_automation_attach", "defer_until_reset",
    "job_preflight", "quota_profile", "quota_status", "resume_prepare"]);
  const preflight = tools.tools.find((tool) => tool.name === "job_preflight");
  assert.deepEqual([...preflight.inputSchema.required].sort(), ["description", "jobClass", "jobId", "taskId", "workspaceRoot"]);
  const quota = await client.callTool({ name: "quota_status", arguments: {} });
  assert.ok(!quota.isError, "quota_status returned an MCP tool error");
  const structuredQuota = quota.structuredContent;
  assert.ok(structuredQuota?.profile && structuredQuota?.lanes, "v0.2 snapshot fields missing");
  assert.equal(structuredQuota.stale, false, `Live quota unavailable: ${JSON.stringify(structuredQuota.error)}`);
  assert.equal(structuredQuota.refreshInProgress, false, "A shared refresh is in progress; use the normal next refresh deadline");
  const profile = await client.callTool({ name: "quota_profile", arguments: { action: "get" } });
  assert.ok(!profile.isError && profile.structuredContent?.effectiveThresholdPercent != null);
  const lanes = structuredQuota && typeof structuredQuota === "object" ? structuredQuota.lanes : undefined;
  process.stdout.write(`${JSON.stringify({
    accepted: true, server, transport: transportKind, isolatedStateDir,
    toolNames,
    quota: values.summary ? { source: structuredQuota.source, stale: structuredQuota.stale,
      refreshInProgress: structuredQuota.refreshInProgress, planType: structuredQuota.planType,
      fetchedAt: structuredQuota.fetchedAt } : structuredQuota,
    laneRoles: lanes && typeof lanes === "object" ? Object.keys(lanes).sort() : [],
  }, null, 2)}\n`);
} finally {
  await client.close();
}

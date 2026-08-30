import { resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values } = parseArgs({ options: {
  isolated: { type: "boolean", default: false },
  command: { type: "string", default: process.execPath },
  "args-json": { type: "string" },
} });
const environment = getDefaultEnvironment();
for (const name of ["CODEX_HOME", "CODEX_CLI_PATH", "CODEX_QUOTA_GUARD_STATE_DIR", "CODEX_QUOTA_GUARD_CONFIG"]) {
  if (process.env[name]) environment[name] = process.env[name];
}
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
const args = values["args-json"] ? JSON.parse(values["args-json"])
  : ["--disable-warning=ExperimentalWarning", resolve(root, "dist", "main.js")];
assert.ok(Array.isArray(args) && args.every((arg) => typeof arg === "string"), "--args-json must be a string array");

const transport = new StdioClientTransport({
  command: values.command,
  args,
  cwd: root,
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "codex-quota-guard-live-acceptance", version: "0.2.0" });

try {
  await client.connect(transport);
  const server = client.getServerVersion();
  assert.equal(server?.version, "0.2.0", "Registered entrypoint must expose MCP v0.2.0");
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
    accepted: true, server, command: values.command, args, isolatedStateDir,
    toolNames,
    quota: structuredQuota,
    laneRoles: lanes && typeof lanes === "object" ? Object.keys(lanes).sort() : [],
  }, null, 2)}\n`);
} finally {
  await client.close();
}

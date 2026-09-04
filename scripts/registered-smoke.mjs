// Fresh connection to the actual registered deployment; no force-refresh or auth files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
const { values } = parseArgs({ options: { wsl: { type: "boolean" }, resume: { type: "boolean" },
  "job-id": { type: "string" }, "expect-weekly": { type: "boolean" } } });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = process.env.CODEX_HOME || join(homedir(), ".codex");
const config = parse(readFileSync(join(home, "config.toml"), "utf8")).mcp_servers.codex_quota_guard;
const env = { ...getDefaultEnvironment(), ...config.env };
for (const name of config.env_vars ?? []) if (process.env[name]) env[name] = process.env[name];
let wslNode;
if (values.wsl) {
  env.WSLENV = (env.WSLENV ?? "").split(":").map(x => x.replace(/\/w$/, "")).join(":");
  assert.ok(config.env?.CODEX_QUOTA_GUARD_NODE, "Managed Windows Node path missing");
  wslNode = execFileSync("wsl.exe", ["--exec", "wslpath", "-u", config.env.CODEX_QUOTA_GUARD_NODE], { encoding: "utf8" }).trim();
}
const transport = new StdioClientTransport({ command: values.wsl ? "wsl.exe" : config.command,
  args: values.wsl ? ["--exec", wslNode, ...config.args] : config.args, env, stderr: "pipe" });
transport.stderr?.on("data", data => {
  if (process.env.QUOTA_SMOKE_DEBUG === "1") process.stderr.write(data);
});
const client = new Client({ name: "quota-registered-smoke", version: "1" }, {
  versionNegotiation: { mode: "legacy" },
});
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} failed`); return result.structuredContent;
};
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 8);
  assert.equal(client.getServerVersion().version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  const taskId = process.env.CODEX_THREAD_ID;
  if (values.resume || values["job-id"]) assert.ok(taskId, "Current real CODEX_THREAD_ID is required");
  if (values.resume) {
    const resume = await call("resume_prepare", { workspaceRoot: root, taskId, laneId: "primary", trigger: "manual" });
    console.log(JSON.stringify({ resume: { canResume: resume.canResume, automationIdsToCancel: resume.automationIdsToCancel } }));
    assert.equal(resume.canResume, true);
  }
  const quota = await call("quota_status", { agentProtocol: "auto-reset-v1" });
  assert.equal(quota.stale, false); assert.equal(quota.refreshInProgress, false);
  if (values["expect-weekly"]) { assert.equal(quota.fiveHour, null); assert.equal(quota.profile.policyMode, "weekly_only"); }
  if (values["job-id"]) {
    const job = await call("job_preflight", { agentProtocol: "auto-reset-v1", workspaceRoot: root, taskId, laneId: "primary", jobClass: "medium",
      jobId: values["job-id"], description: "Bounded weekly-policy and managed deployment validation" });
    console.log(JSON.stringify({ preflight: { decision: job.decision, thresholdPercent: job.thresholdPercent, quotaPath: job.quotaPath } }));
    assert.notEqual(job.decision, "defer");
  }
  console.log(JSON.stringify({ accepted: true, via: values.wsl ? "WSL-interop" : "Windows", server: client.getServerVersion(),
    fiveHour: quota.fiveHour, weekly: quota.weekly, profile: quota.profile, quotaPath: quota.quotaPath, monitor: quota.monitor }));
} finally { await client.close(); }

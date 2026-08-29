import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const environment = getDefaultEnvironment();
if (process.env.CODEX_QUOTA_GUARD_STATE_DIR) {
  environment.CODEX_QUOTA_GUARD_STATE_DIR = process.env.CODEX_QUOTA_GUARD_STATE_DIR;
}
if (process.env.CODEX_QUOTA_GUARD_CONFIG) {
  environment.CODEX_QUOTA_GUARD_CONFIG = process.env.CODEX_QUOTA_GUARD_CONFIG;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", resolve(root, "dist", "main.js")],
  cwd: root,
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "codex-quota-guard-live-acceptance", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const quota = await client.callTool({ name: "quota_status", arguments: {} });
  process.stdout.write(`${JSON.stringify({
    toolNames: tools.tools.map((tool) => tool.name).sort(),
    quota: quota.structuredContent,
  }, null, 2)}\n`);
} finally {
  await client.close();
}

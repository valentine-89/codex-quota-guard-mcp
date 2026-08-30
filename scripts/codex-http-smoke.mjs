// Real Codex HTTP client handshake with an EMPTY isolated Codex home. No model/auth/quota RPCs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringify } from "smol-toml";
import { resolveCommand } from "../dist/app-server.js";
import { startHttpServer } from "../dist/http-server.js";

const dir = mkdtempSync(join(tmpdir(), "quota-codex-http-"));
const token = randomBytes(32).toString("base64url");
const http = await startHttpServer(() => {
  const server = new McpServer({ name: "quota-transport-fixture", version: "1" });
  server.registerTool("transport_probe", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
}, { token });
writeFileSync(join(dir, "config.toml"), stringify({ mcp_servers: { quota_http_probe: {
  url: http.url, bearer_token_env_var: "QUOTA_HTTP_SMOKE_SECRET", startup_timeout_sec: 10,
}, quota_http_header_probe: { url: http.url, env_http_headers: { Authorization: "QUOTA_HTTP_SMOKE_AUTH" }, startup_timeout_sec: 10 } } }));
const command = resolveCommand(process.env.CODEX_CLI_PATH ?? "codex");
const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
const child = spawn(batch ? process.env.ComSpec ?? "cmd.exe" : command,
  batch ? ["/d", "/s", "/v:off", "/c", '""%QUOTA_HTTP_SMOKE_COMMAND%" app-server --stdio"'] : ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: dir, QUOTA_HTTP_SMOKE_SECRET: token,
      QUOTA_HTTP_SMOKE_AUTH: `Bearer ${token}`, QUOTA_HTTP_SMOKE_COMMAND: command },
    windowsHide: true, windowsVerbatimArguments: batch, stdio: ["pipe", "pipe", "pipe"],
  });
child.stderr.resume();
const exit = new Promise(resolve => child.once("exit", resolve));
const pending = new Map(); let nextId = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  try {
    const message = JSON.parse(line), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(Error("Codex HTTP smoke RPC failed")); else entry.resolve(message.result);
  } catch { /* Non-protocol diagnostics are never logged with environment values. */ }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(Error("Codex HTTP smoke timeout")); }, 15_000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
});
try {
  await rpc("initialize", { clientInfo: { name: "quota-http-smoke", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const status = await rpc("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 10 });
  const server = status.data.find(item => item.name === "quota_http_probe");
  assert.ok(server?.tools?.transport_probe, "real Codex did not discover the HTTP fixture tool");
  assert.ok(status.data.find(item => item.name === "quota_http_header_probe")?.tools?.transport_probe,
    "real Codex did not supply the environment header");
  console.log(JSON.stringify({ accepted: true, actualCodexHttpClient: true,
    bearerAuthentication: true, environmentHeaders: true, isolatedEmptyCodexHome: true, modelTurns: 0,
    quotaRpcCalls: 0, desktopCapabilityRenewalVerified: false }));
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.stdin.end(); child.kill(); await exit; lines.close(); await http.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

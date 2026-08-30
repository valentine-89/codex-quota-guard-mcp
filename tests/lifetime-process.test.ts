import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quota-lifetime-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, codexHome: dir, monitorEnabled: false }));
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/main.ts")], {
    env: { ...process.env, CODEX_QUOTA_GUARD_CONFIG: config }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "", stdout = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  const exit = new Promise<number | null>(resolveExit => child.once("exit", resolveExit));
  return { child, exit, stdout: () => stdout, stderr: () => stderr,
    close: async () => { if (child.exitCode === null) child.kill(); await exit; rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("real MCP exits on startup EOF without initialize or forced client kill", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    f.child.stdin.end();
    assert.equal(await f.exit, 0);
    assert.match(f.stderr(), /stdin_(end|close)/);
  } finally { await f.close(); }
});

test("real initialized MCP stays alive while idle then exits when its client closes stdin", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    f.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifetime-test", version: "1" },
    } })}\n`);
    const deadline = Date.now() + 5_000;
    while (!f.stdout().includes('"id":1') && Date.now() < deadline) await delay(20);
    assert.ok(f.stdout().includes('"id":1'), f.stderr());
    f.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await delay(75); assert.equal(f.child.exitCode, null);
    f.child.stdin.end(); assert.equal(await f.exit, 0);
  } finally { await f.close(); }
});

test("real MCP exits when response pipe is closed", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    f.child.stdout.destroy();
    f.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "broken-output", version: "1" },
    } })}\n`);
    await f.exit;
    assert.match(f.stderr(), /stdout_(error|close)/);
  } finally { await f.close(); }
});

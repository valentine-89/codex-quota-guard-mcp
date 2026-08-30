import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { testConfig } from "./helpers.js";

// Real subprocess/stdio coverage on each CI OS, including paths with spaces.
function fixture(source: string): { root: string; command: string } {
  const root = mkdtempSync(join(tmpdir(), "quota app-server & %literal% ! "));
  const script = join(root, "fixture.cjs");
  writeFileSync(script, source);
  const command = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replaceAll("%", "%%")}" "%~dp0fixture.cjs" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(command, 0o700);
  return { root, command };
}

test("app-server subprocess handles native executable paths with spaces and propagates Codex home", async () => {
  const { root, command } = fixture(`
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m=JSON.parse(line); if(m.id == null) return;
 if(process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(8);
 const result = m.method==='account/read' ? {account:{type:'chatgpt', planType:'plus'}, home:process.env.CODEX_HOME}
   : m.method==='account/rateLimits/read' ? {rateLimits:{primary:{usedPercent:10,windowDurationMins:300}}} : {};
 console.log(JSON.stringify({id:m.id,result}));
});`);
  try {
    const config = { ...testConfig(join(root, "state.sqlite")), codexCommand: command,
      codexHome: join(root, "profile space"), appServerTimeoutMs: 5_000 };
    const response = await new CodexAppServerClient(config).readQuota();
    assert.equal(response.account.account?.type, "chatgpt");
    assert.equal((response.account as unknown as { home: string }).home, config.codexHome);
    assert.ok(response.rateLimits.rateLimits);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("early app-server exit reports its redacted cause instead of waiting for quota timeout", async () => {
  const { root, command } = fixture("process.stderr.write('cannot initialize state; access_token=secret-value'); process.exit(7);");
  try {
    const config = { ...testConfig(join(root, "state.sqlite")), codexCommand: command, appServerTimeoutMs: 5_000 };
    await assert.rejects(new CodexAppServerClient(config).readQuota(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "APP_SERVER_EXITED");
      assert.match(error.message, /cannot initialize state/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

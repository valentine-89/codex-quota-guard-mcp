import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stringify } from "smol-toml";
import { StateStore, profileKey } from "../src/store.js";
import { QuotaGuardService } from "../src/service.js";
import { DesktopSchedulerBridge, EARLY_RRULE } from "../src/scheduler.js";
import { rawQuota, testConfig } from "./helpers.js";

for (const mode of ["stdio", "http"] as const) test(`real ${mode} timer advances an owned fixture without a quota tool call`, { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-monitor-process-"));
  const state = join(dir, "state"); mkdirSync(state);
  const config = { ...testConfig(join(state, "state.sqlite")), codexHome: dir, appServerTimeoutMs: 5_000 };
  const appScript = join(dir, "app.cjs"), command = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const marker = join(dir, "advanced.json"), automationDir = join(dir, "automations", "owned");
  mkdirSync(automationDir, { recursive: true });
  const automationFile = join(automationDir, "automation.toml");
  const raw = rawQuota(0, Math.floor(Date.now() / 1000) + 7_200);
  writeFileSync(appScript, `const raw=${JSON.stringify(raw)};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?raw.account:m.method==='account/rateLimits/read'?raw.rateLimits:{}}));
});`);
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath.replaceAll("%", "%%")}" "%~dp0app.cjs" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${appScript.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(command, 0o700);
  const scheduler = join(dir, "scheduler.cjs");
  // Disposable protocol fixture: never connects to any real desktop capability.
  writeFileSync(scheduler, `const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;let result={};
 if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(m.method==='tools/list')result={tools:[{name:'automation_update',inputSchema:{type:'object',properties:{kind:{const:'heartbeat'},mode:{enum:['update','delete']},targetThreadId:{type:'string'},rrule:{type:'string'}}}}]};
 if(m.method==='tools/call'){
  const a=m.params.arguments;
  if(a.id!=='owned'||a.mode!=='update')throw Error('unexpected mutation');
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({id:a.id,rrule:a.rrule,at:Date.now()}));
  result={content:[{type:'text',text:JSON.stringify({automationId:a.id,mode:a.mode})}]};
 }
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`);
  const store = new StateStore(config.stateFile);
  const now = Date.now() - 300_001;
  const service = new QuotaGuardService(config, store, { readQuota: async () => rawQuota(100, Math.floor(Date.now() / 1000) + 7_200) }, { now: () => now });
  const bridge = new DesktopSchedulerBridge(dir, { ready: async () => {}, call: async () => false, close: async () => {} }, () => true);
  service.setAutomationCapture(defer => bridge.capture(defer)?.serialized ?? null);
  const deferred = await service.deferUntilReset({ workspaceRoot: dir, taskId: "task", objective: "fixture", completed: [], pending: [] });
  writeFileSync(automationFile, stringify({ version: 1, id: "owned", kind: "heartbeat", name: "fixture", status: "ACTIVE",
    rrule: "FREQ=MINUTELY;INTERVAL=115", target_thread_id: "task", created_at: now,
    prompt: deferred.automationPrompt }));
  service.attachAutomation(deferred.deferId, "owned");
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ stateDir: state, codexHome: dir, codexCommand: command,
    schedulerServerPath: scheduler, appServerTimeoutMs: 5_000 }));
  const client = new Client({ name: "timer-fixture", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", "tsx", resolve("src/main.ts")], env: { ...getDefaultEnvironment(),
      CODEX_QUOTA_GUARD_CONFIG: configPath, CODEX_APP_TOOLS_PIPE_PATH: "fixture-only-not-real" }, stderr: "pipe" });
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    if (mode === "stdio") await client.connect(transport); // No quota tool calls.
    else {
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const address = reservation.address(); assert.ok(address && typeof address !== "string");
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      child = spawn(process.execPath, ["--import", "tsx", resolve("src/http-main.ts")], {
        env: { ...getDefaultEnvironment(), CODEX_QUOTA_GUARD_CONFIG: configPath,
          CODEX_APP_TOOLS_PIPE_PATH: "fixture-only-not-real", CODEX_QUOTA_GUARD_HTTP_PORT: String(address.port),
          CODEX_QUOTA_GUARD_HTTP_TOKEN: randomBytes(32).toString("base64url") },
        windowsHide: true, stdio: "ignore",
      });
      exited = new Promise(resolve => child!.once("exit", resolve));
      // Deliberately never initialize an MCP client or keep a stdio connection open.
    }
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(marker), `internal timer must perform scheduler dispatch: ${JSON.stringify({ status: store.monitor.status(profileKey(dir)), records: store.monitor.list(profileKey(dir)), cache: store.getCache(profileKey(dir))?.snapshot.error })}`);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).rrule, EARLY_RRULE);
    assert.ok(["dispatching", "scheduled"].includes(store.monitor.list(profileKey(dir))[0]!.stage));
  } finally {
    await client.close();
    child?.kill(); await exited;
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

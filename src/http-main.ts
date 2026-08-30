#!/usr/bin/env node
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { profileKey } from "./store.js";
import { acquireCoreLock } from "./core-lock.js";
import { createRuntime } from "./runtime.js";
import { createMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http-server.js";

async function main() {
  const token = process.env.CODEX_QUOTA_GUARD_HTTP_TOKEN ?? "";
  const port = Number(process.env.CODEX_QUOTA_GUARD_HTTP_PORT ?? "");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("HTTP_PORT_REQUIRED: choose a loopback port from 1024 to 65535");
  const config = loadConfig();
  const release = acquireCoreLock(join(config.stateDir, `core-${profileKey(config.codexHome)}.sqlite`));
  const runtime = createRuntime(config);
  let closeHttp: (() => Promise<void>) | undefined;
  try {
    const http = await startHttpServer(() => createMcpServer(runtime.service), { token, port,
      diagnostics: () => ({ pid: process.pid, mode: "shared-http", monitor: runtime.service.monitorStatus() }) });
    closeHttp = http.close;
    runtime.service.setRuntimeMode("shared-http");
    // Server lifetime is independent of initialize/EOF/client disconnect.
    runtime.monitor.start();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 5_000);
      void http.close().then(() => runtime.close()).then(() => {
        release(); clearTimeout(deadline); process.exit(0);
      }).catch(() => { process.exit(1); });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    // No secret, capability, account data, or checkpoint contents in startup logs.
    process.stderr.write(`quota-guard: shared HTTP core ready on port ${port}\n`);
  } catch (error) { await closeHttp?.(); await runtime.close(); release(); throw error; }
}
main().catch(() => { process.stderr.write("quota-guard: HTTP core startup failed; verify token, port, configuration and singleton ownership\n"); process.exitCode = 1; });

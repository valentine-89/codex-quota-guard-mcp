#!/usr/bin/env node
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { profileKey } from "./store.js";
import { acquireCoreLock } from "./core-lock.js";
import { managedCoreCanStop, readManagedSettings } from "./managed.js";
import { ClientLeaseRegistry } from "./client-leases.js";

async function main() {
  const token = process.env.CODEX_QUOTA_GUARD_HTTP_TOKEN ?? "";
  const port = Number(process.env.CODEX_QUOTA_GUARD_HTTP_PORT ?? "");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("HTTP_PORT_REQUIRED: choose a loopback port from 1024 to 65535");
  const config = loadConfig();
  const release = acquireCoreLock(join(config.stateDir, `core-${profileKey(config.codexHome)}.sqlite`));
  // Startup contenders exit on the lock before loading the full MCP runtime.
  const [{ createRuntime }, { createMcpServer }, { startHttpServer }] = await Promise.all([
    import("./runtime.js"), import("./mcp-server.js"), import("./http-server.js"),
  ]);
  const managed = process.env.CODEX_QUOTA_GUARD_MANAGED_SETTINGS
    ? readManagedSettings(process.env.CODEX_QUOTA_GUARD_MANAGED_SETTINGS) : undefined;
  if (managed && (managed.token !== token || managed.port !== port || managed.guardConfig !== process.env.CODEX_QUOTA_GUARD_CONFIG)) {
    release(); throw new Error("MANAGED_CORE_CONFIG_MISMATCH");
  }
  const runtime = createRuntime(config);
  const clientLeases = new ClientLeaseRegistry(60_000);
  runtime.service.setLiveClientCount(() => clientLeases.snapshot().liveClients);
  runtime.monitor.setLiveClients(() => clientLeases.snapshot().liveClients > 0);
  let closeHttp: (() => Promise<void>) | undefined;
  try {
    const http = await startHttpServer(() => createMcpServer(runtime.service), { token, port, clientLeases,
      onClientLeaseChange: () => runtime.monitor.wake(),
      diagnostics: () => ({ pid: process.pid, mode: "shared-http", installationId: managed?.installationId ?? null,
        monitor: runtime.service.monitorStatus() }),
      ...(managed ? { bindDesktop: runtime.bindDesktop } : {}) });
    closeHttp = http.close;
    // Server lifetime is independent of protocol discovery, EOF, and any one client disconnect.
    runtime.monitor.start();
    let stopping = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (idleTimer) clearInterval(idleTimer);
      const deadline = setTimeout(() => process.exit(1), 5_000);
      void http.close().then(() => runtime.close()).then(() => {
        release(); clearTimeout(deadline); process.exit(0);
      }).catch(() => { process.exit(1); });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    if (managed) {
      let noClientSince = Date.now();
      idleTimer = setInterval(() => {
        const state = http.diagnostics();
        clientLeases.expire();
        if (clientLeases.snapshot().liveClients > 0) noClientSince = Date.now();
        if (managedCoreCanStop(Date.now() - noClientSince, 5_000, state.activeRequests,
          runtime.monitor.isBusy())) stop();
      }, 1_000);
      idleTimer.unref();
    }
    // No secret, capability, account data, or checkpoint contents in startup logs.
    process.stderr.write(`quota-guard: shared HTTP core ready on port ${port}\n`);
  } catch (error) { await closeHttp?.(); await runtime.close(); release(); throw error; }
}
main().catch(() => { process.stderr.write("quota-guard: HTTP core startup failed; verify token, port, configuration and singleton ownership\n"); process.exitCode = 1; });

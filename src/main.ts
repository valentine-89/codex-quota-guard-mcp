#!/usr/bin/env node

import { CodexAppServerClient } from "./app-server.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp-server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuotaGuardService } from "./service.js";
import { StateStore } from "./store.js";
import { QuotaMonitor } from "./monitor.js";
import { DesktopSchedulerBridge, DesktopSchedulerRpc, schedulerConfigured } from "./scheduler.js";
import { ProcessLifetime, parentIsAlive } from "./lifetime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.stateFile);
  const service = new QuotaGuardService(config, store, new CodexAppServerClient(config));

  if (process.argv.includes("--doctor")) {
    const status = await service.quotaStatus();
    process.stdout.write(`${JSON.stringify({ ok: status.error === null, config: {
      stateFile: config.stateFile,
      codexHome: config.codexHome,
      codexCommand: config.codexCommand,
    }, status }, null, 2)}\n`);
    store.close();
    process.exitCode = status.error === null ? 0 : 2;
    return;
  }

  const serverPath = config.schedulerServerPath ?? process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER;
  const available = (): boolean => config.monitorEnabled !== false && schedulerConfigured(serverPath);
  const bridge = new DesktopSchedulerBridge(config.codexHome, new DesktopSchedulerRpc(serverPath ?? ""), available);
  const monitor = new QuotaMonitor(config.codexHome, store, service, bridge);
  service.setMonitorCapability(available);
  service.setAutomationCapture(defer => available() ? bridge.capture(defer)?.serialized ?? null : null);
  const server = createMcpServer(service);
  const parentPid = process.ppid;
  const lifetime = new ProcessLifetime({
    input: process.stdin, output: process.stdout, parentAlive: () => parentIsAlive(parentPid),
    cleanup: async () => {
      await monitor.stop();
      await server.close();
      store.close();
    },
    exit: (code, reason) => {
      process.stderr.write(`quota-guard: exiting (${reason})\n`);
      process.exit(code);
    },
  });
  server.server.onclose = () => lifetime.stop("transport_closed");
  server.server.oninitialized = () => {
    lifetime.markInitialized();
    monitor.start();
  };
  process.once("SIGINT", () => lifetime.stop("signal"));
  process.once("SIGTERM", () => lifetime.stop("signal"));
  // Install EOF/error listeners before connecting so a short-lived client cannot race startup.
  await server.connect(new StdioServerTransport());
  if (process.stdin.destroyed || process.stdin.readableEnded) lifetime.stop("stdin_close");
  if (process.stdout.destroyed) lifetime.stop("stdout_close");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-quota-guard-mcp: ${message}\n`);
  process.exitCode = 1;
});

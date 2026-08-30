#!/usr/bin/env node

import { CodexAppServerClient } from "./app-server.js";
import { loadConfig } from "./config.js";
import { runStdioServer } from "./mcp-server.js";
import { QuotaGuardService } from "./service.js";
import { StateStore } from "./store.js";
import { QuotaMonitor } from "./monitor.js";
import { DesktopSchedulerBridge, DesktopSchedulerRpc, schedulerConfigured } from "./scheduler.js";

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
  const server = await runStdioServer(service);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void monitor.stop().finally(() => { store.close(); process.exit(0); });
  };
  server.server.onclose = shutdown;
  process.stdin.once("end", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  monitor.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-quota-guard-mcp: ${message}\n`);
  process.exitCode = 1;
});

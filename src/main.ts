#!/usr/bin/env node

import { CodexAppServerClient } from "./app-server.js";
import { loadConfig } from "./config.js";
import { runStdioServer } from "./mcp-server.js";
import { QuotaGuardService } from "./service.js";
import { StateStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.stateFile);
  const service = new QuotaGuardService(config, store, new CodexAppServerClient(config));

  const shutdown = (): void => {
    try { store.close(); } finally { process.exit(0); }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

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

  await runStdioServer(service);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-quota-guard-mcp: ${message}\n`);
  process.exitCode = 1;
});

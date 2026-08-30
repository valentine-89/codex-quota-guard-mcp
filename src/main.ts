#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

async function main(): Promise<void> {
  if (!process.argv.includes("--doctor")) {
    throw new Error("DIRECT_STDIO_DISABLED: install the authenticated on-demand connector with scripts/install.mjs");
  }
  const config = loadConfig();
  const runtime = createRuntime(config);
  const { service } = runtime;

  const status = await service.quotaStatus();
  process.stdout.write(`${JSON.stringify({ ok: status.error === null, config: {
    stateFile: config.stateFile,
    codexHome: config.codexHome,
    codexCommand: config.codexCommand,
  }, status }, null, 2)}\n`);
  await runtime.close();
  process.exitCode = status.error === null ? 0 : 2;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-quota-guard-mcp: ${message}\n`);
  process.exitCode = 1;
});

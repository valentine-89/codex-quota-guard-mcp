#!/usr/bin/env node
import { ensureManagedCore } from "./managed.js";

const path = process.env.CODEX_QUOTA_GUARD_MANAGED_SETTINGS ?? process.argv[2];
if (!path) { process.stderr.write("quota-guard: managed settings path required\n"); process.exitCode = 1; }
else {
  try { await ensureManagedCore(path); }
  catch { process.stderr.write("quota-guard: managed core unavailable; no fallback started\n"); process.exitCode = 1; }
}

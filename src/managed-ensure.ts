#!/usr/bin/env node
import { superviseManagedCore } from "./managed-supervision.js";

const path = process.env.CODEX_QUOTA_GUARD_MANAGED_SETTINGS ?? process.argv[2];
if (!path) { process.stderr.write("quota-guard: managed settings path required\n"); process.exitCode = 1; }
else {
  try { await superviseManagedCore(path); }
  catch { process.stderr.write("quota-guard: managed core unavailable; no fallback started\n"); process.exitCode = 1; }
}

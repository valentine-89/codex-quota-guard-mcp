/** Shared, read-only discovery contract. No version-number guesses or fallback. */
export function schedulerCapabilityReason(serverName: string | undefined,
  tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>): string | null {
  if (serverName !== "codex-app-tools") return "SCHEDULER_IDENTITY_UNSUPPORTED";
  const scheduler = tools.find(tool => tool.name === "automation_update");
  if (!scheduler) return "SCHEDULER_TOOL_MISSING";
  const encoded = JSON.stringify(scheduler.inputSchema ?? {});
  return ["heartbeat", "update", "delete", "targetThreadId", "rrule"].every(field => encoded.includes(`"${field}"`))
    ? null : "SCHEDULER_SCHEMA_UNSUPPORTED";
}

const safeReasons = new Set(["SCHEDULER_IDENTITY_UNSUPPORTED", "SCHEDULER_TOOL_MISSING",
  "SCHEDULER_SCHEMA_UNSUPPORTED", "SCHEDULER_CONTEXT_REJECTED"]);
export function schedulerFailureReason(error: unknown): string {
  return error instanceof Error && safeReasons.has(error.message) ? error.message : "SCHEDULER_DISCOVERY_FAILED";
}

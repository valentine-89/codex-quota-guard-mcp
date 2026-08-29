import type { GuardConfig } from "../src/config.js";

export function testConfig(stateFile: string): GuardConfig {
  return {
    stateDir: stateFile.replace(/[\\/][^\\/]+$/, ""),
    stateFile,
    codexHome: "C:\\test\\codex-home",
    codexCommand: "codex",
    warningRemainingPercent: 20,
    deferRemainingPercent: 10,
    appServerTimeoutMs: 1_000,
    leaseDurationMs: 30_000,
    resetGraceMs: 30_000,
    ttlMs: { high: 900_000, medium: 300_000, warning: 120_000, low: 60_000 },
  };
}

export function rawQuota(usedPercent: number, resetSeconds = 2_000_000_000) {
  return {
    account: { account: { type: "chatgpt", email: "test@example.invalid", planType: "plus" }, requiresOpenaiAuth: true },
    rateLimits: {
      rateLimits: {
        primary: { usedPercent, windowDurationMins: 300, resetsAt: resetSeconds },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: resetSeconds + 1_000 },
        planType: "plus",
        rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
      },
    },
  };
}

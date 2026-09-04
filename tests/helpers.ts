import type { GuardConfig } from "../src/config.js";
import type { AppServerQuotaResult } from "../src/types.js";

export function testConfig(stateFile: string): GuardConfig {
  return {
    stateDir: stateFile.replace(/[\\/][^\\/]+$/, ""), stateFile,
    codexHome: "C:\\test\\codex-home", codexCommand: "codex",
    planDefaults: { freeGo: 20, standard: 10, pro: 5, unknown: 15 },
    sampleWindow: 20, minSamples: 3, safetyFactor: 1.5, maxThreshold: 50, weeklyOnlyRemainingPercent: 3,
    cautionMarginPercent: 5, maxAutomationWaitMs: 86_400_000, manualResumeMinAgeMs: 60_000,
    appServerTimeoutMs: 1_000, leaseDurationMs: 30_000, resetGraceMs: 30_000,
    automaticWeeklyReset: { enabled: false, thresholds: { freeGo: 5, plus: 2, higher: 1 },
      minimumTimeToResetMs: 259_200_000, recheckDelaysMs: [3_000, 5_000, 10_000] },
    ttlMs: { high: 900_000, medium: 300_000, warning: 120_000, low: 60_000 },
  };
}

export function rawQuota(usedPercent: number, resetSeconds = 2_000_000_000, options: {
  planType?: string; weeklyUsed?: number; weeklyDurationMins?: number;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null };
  individualLimit?: { remainingPercent: number; resetsAt: number };
  spendControlReached?: boolean; rateLimitReachedType?: string | null; limitId?: string;
  secondaryReserveUsed?: number;
  resetCredits?: Array<{ id: string; resetType?: string; status?: string; expiresAt: number }>;
} = {}): AppServerQuotaResult {
  const planType = options.planType ?? "plus";
  return {
    account: { account: { type: "chatgpt", email: "test@example.invalid", planType }, requiresOpenaiAuth: true },
    rateLimits: { rateLimits: {
      primary: { usedPercent, windowDurationMins: 300, resetsAt: resetSeconds },
      secondary: { usedPercent: options.weeklyUsed ?? 40, windowDurationMins: options.weeklyDurationMins ?? 10_080, resetsAt: resetSeconds + 1_000 },
      planType, limitId: options.limitId ?? "codex",
      rateLimitReachedType: options.rateLimitReachedType === undefined ? usedPercent >= 100 ? "rate_limit_reached" : null : options.rateLimitReachedType,
      ...(options.credits ? { credits: options.credits } : {}),
      ...(options.individualLimit ? { individualLimit: { limit: "100", used: "50",
        remainingPercent: options.individualLimit.remainingPercent, resetsAt: options.individualLimit.resetsAt } } : {}),
      ...(options.spendControlReached === undefined ? {} : { spendControlReached: options.spendControlReached }),
    }, ...(options.secondaryReserveUsed === undefined ? {} : { rateLimitsByLimitId: {
      base_model_inference: { limitId: "base_model_inference", limitName: "gpt-reserve",
        primary: { usedPercent: options.secondaryReserveUsed, windowDurationMins: 10_080, resetsAt: resetSeconds + 2_000 },
        secondary: null, planType, rateLimitReachedType: null },
    } }), ...(options.resetCredits ? { rateLimitResetCredits: {
      availableCount: options.resetCredits.length,
      credits: options.resetCredits.map(credit => ({ resetType: "codexRateLimits", status: "available", ...credit })),
    } } : {}),
    },
  };
}

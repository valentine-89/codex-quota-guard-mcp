import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  $schema: z.string().optional(),
  stateDir: z.string().min(1).optional(),
  codexHome: z.string().min(1).optional(),
  codexCommand: z.string().min(1).optional(),
  monitorEnabled: z.boolean().default(true),
  schedulerServerPath: z.string().min(1).optional(),
  planDefaults: z.object({
    freeGo: z.number().min(1).max(50).default(20),
    standard: z.number().min(1).max(50).default(10),
    pro: z.number().min(1).max(50).default(5),
    unknown: z.number().min(1).max(50).default(15),
  }).strict().default({ freeGo: 20, standard: 10, pro: 5, unknown: 15 }),
  sampleWindow: z.number().int().min(3).max(100).default(20),
  minSamples: z.number().int().min(1).max(100).default(3),
  safetyFactor: z.number().min(1).max(5).default(1.5),
  maxThreshold: z.number().min(1).max(50).default(50),
  weeklyOnlyRemainingPercent: z.number().min(2).max(5).default(3),
  cautionMarginPercent: z.number().min(1).max(25).default(5),
  maxAutomationWaitMs: z.number().int().min(60_000).max(86_400_000).default(86_400_000),
  manualResumeMinAgeMs: z.number().int().min(30_000).max(900_000).default(60_000),
  appServerTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  leaseDurationMs: z.number().int().min(5_000).max(120_000).default(30_000),
  resetGraceMs: z.number().int().min(0).max(300_000).default(30_000),
  automaticWeeklyReset: z.object({
    enabled: z.boolean().default(false),
    thresholds: z.object({
      freeGo: z.number().min(1).max(50).default(5),
      plus: z.number().min(1).max(50).default(2),
      higher: z.number().min(1).max(50).default(1),
    }).strict().default({ freeGo: 5, plus: 2, higher: 1 }),
    minimumTimeToResetMs: z.number().int().min(60_000).max(604_800_000).default(259_200_000),
    recheckDelaysMs: z.tuple([
      z.number().int().min(1_000).max(60_000),
      z.number().int().min(1_000).max(60_000),
      z.number().int().min(1_000).max(60_000),
    ]).default([3_000, 5_000, 10_000]),
  }).strict().default({ enabled: false, thresholds: { freeGo: 5, plus: 2, higher: 1 },
    minimumTimeToResetMs: 259_200_000, recheckDelaysMs: [3_000, 5_000, 10_000] }),
  ttlMs: z.object({
    high: z.number().int().min(60_000).default(900_000),
    medium: z.number().int().min(30_000).default(300_000),
    warning: z.number().int().min(30_000).default(120_000),
    low: z.number().int().min(30_000).default(60_000),
  }).strict().default({ high: 900_000, medium: 300_000, warning: 120_000, low: 60_000 }),
}).strict().refine((value) => value.minSamples <= value.sampleWindow, {
  message: "minSamples must be less than or equal to sampleWindow",
  path: ["minSamples"],
}).refine((value) => Object.values(value.planDefaults).every((entry) => entry <= value.maxThreshold), {
  message: "plan defaults must be less than or equal to maxThreshold",
  path: ["planDefaults"],
}).refine((value) => value.weeklyOnlyRemainingPercent <= value.maxThreshold, {
  message: "weeklyOnlyRemainingPercent must be less than or equal to maxThreshold",
  path: ["weeklyOnlyRemainingPercent"],
});

export interface GuardConfig {
  stateDir: string;
  stateFile: string;
  codexHome: string;
  codexCommand: string;
  monitorEnabled?: boolean;
  schedulerServerPath?: string | undefined;
  planDefaults: { freeGo: number; standard: number; pro: number; unknown: number };
  sampleWindow: number;
  minSamples: number;
  safetyFactor: number;
  maxThreshold: number;
  weeklyOnlyRemainingPercent: number;
  cautionMarginPercent: number;
  maxAutomationWaitMs: number;
  manualResumeMinAgeMs: number;
  appServerTimeoutMs: number;
  leaseDurationMs: number;
  resetGraceMs: number;
  automaticWeeklyReset: {
    enabled: boolean;
    thresholds: { freeGo: number; plus: number; higher: number };
    minimumTimeToResetMs: number;
    recheckDelaysMs: [number, number, number];
  };
  ttlMs: { high: number; medium: number; warning: number; low: number };
}

function defaultStateDir(): string {
  const override = process.env.CODEX_QUOTA_GUARD_STATE_DIR;
  if (override) return resolve(override);
  return fileURLToPath(new URL("../data", import.meta.url));
}

export function loadConfig(): GuardConfig {
  const path = process.env.CODEX_QUOTA_GUARD_CONFIG;
  let fileConfig: unknown = {};
  if (path) {
    if (!existsSync(path)) throw new Error(`Configuration file does not exist: ${path}`);
    fileConfig = JSON.parse(readFileSync(path, "utf8")) as unknown;
  }
  const parsed = configSchema.parse(fileConfig);
  const stateDir = resolve(parsed.stateDir ?? defaultStateDir());
  mkdirSync(stateDir, { recursive: true });
  return {
    ...parsed,
    stateDir,
    stateFile: join(stateDir, "state.sqlite"),
    codexHome: resolve(parsed.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")),
    codexCommand: parsed.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex",
  };
}

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

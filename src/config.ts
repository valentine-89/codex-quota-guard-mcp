import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";

const configSchema = z.object({
  $schema: z.string().optional(),
  stateDir: z.string().min(1).optional(),
  codexHome: z.string().min(1).optional(),
  codexCommand: z.string().min(1).optional(),
  warningRemainingPercent: z.number().min(1).max(99).default(20),
  deferRemainingPercent: z.number().min(1).max(99).default(10),
  appServerTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  leaseDurationMs: z.number().int().min(5_000).max(120_000).default(30_000),
  resetGraceMs: z.number().int().min(0).max(300_000).default(30_000),
  ttlMs: z.object({
    high: z.number().int().min(60_000).default(900_000),
    medium: z.number().int().min(30_000).default(300_000),
    warning: z.number().int().min(30_000).default(120_000),
    low: z.number().int().min(30_000).default(60_000),
  }).default({ high: 900_000, medium: 300_000, warning: 120_000, low: 60_000 }),
}).refine((value) => value.deferRemainingPercent <= value.warningRemainingPercent, {
  message: "deferRemainingPercent must be less than or equal to warningRemainingPercent",
  path: ["deferRemainingPercent"],
});

export interface GuardConfig {
  stateDir: string;
  stateFile: string;
  codexHome: string;
  codexCommand: string;
  warningRemainingPercent: number;
  deferRemainingPercent: number;
  appServerTimeoutMs: number;
  leaseDurationMs: number;
  resetGraceMs: number;
  ttlMs: {
    high: number;
    medium: number;
    warning: number;
    low: number;
  };
}

function defaultStateDir(): string {
  const override = process.env.CODEX_QUOTA_GUARD_STATE_DIR;
  if (override) return resolve(override);

  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codex-quota-guard");
  }

  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "codex-quota-guard");
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

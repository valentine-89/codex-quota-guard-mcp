export type QuotaRecommendation =
  | "continue"
  | "caution"
  | "checkpoint_and_defer";

export type QuotaSource = "codex-app-server" | "cache" | "unavailable";

export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: string | null;
}

export interface QuotaError {
  code: string;
  message: string;
}

export interface QuotaSnapshot {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  recommendation: QuotaRecommendation;
  fetchedAt: string | null;
  nextRefreshAt: string;
  stale: boolean;
  refreshInProgress: boolean;
  backoffUntil: string | null;
  source: QuotaSource;
  error: QuotaError | null;
}

export interface RawRateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface RawRateLimitSnapshot {
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
  planType?: unknown;
  rateLimitReachedType?: unknown;
  limitId?: unknown;
}

export interface RawRateLimitsResponse {
  rateLimits?: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
}

export interface RawAccountResponse {
  account?: {
    type?: unknown;
    email?: unknown;
    planType?: unknown;
  } | null;
  requiresOpenaiAuth?: unknown;
}

export interface AppServerQuotaResult {
  account: RawAccountResponse;
  rateLimits: RawRateLimitsResponse;
}

export type JobClass = "small" | "medium" | "long";
export type JobDecision = "allow" | "caution" | "defer";

export interface JobPreflightResult {
  decision: JobDecision;
  reason: string;
  requiredAction: string | null;
  quota: QuotaSnapshot;
}

export interface CheckpointPayload {
  workspaceRoot: string;
  taskId?: string;
  objective: string;
  completed: string[];
  pending: string[];
  gitStatus?: string;
  lastTest?: string;
  pendingCommand?: string;
  resumeNotes?: string;
}

export interface StoredCheckpoint extends CheckpointPayload {
  id: string;
  createdAt: string;
  resumeAt: string | null;
}

export interface CachedQuotaRecord {
  snapshot: QuotaSnapshot;
  fetchedAtMs: number;
  nextRefreshAtMs: number;
  accountFingerprint: string | null;
}

export interface BackoffRecord {
  failureCount: number;
  kind: string;
  untilMs: number;
  errorCode: string;
}

import type { Pacing } from "./pacing.js";
export type QuotaRecommendation = "continue" | "caution" | "checkpoint_and_defer";
export type QuotaSource = "codex-app-server" | "cache" | "unavailable";
export type QuotaPath = "included" | "credits" | "weekly_advisory" | "unavailable";
export type JobClass = "small" | "medium" | "long";
export type JobDecision = "allow" | "caution" | "defer";
export type LearningConfidence = "cold_start" | "low" | "ready";
/** Stable roles, deliberately independent from model/product names. */
export type QuotaLaneId = "primary" | "secondary" | "unknown";
export type AgentProtocol = "auto-reset-v1";
export type ResetFollowupOutcome = "reset" | "alreadyRedeemed" | "noCredit" | "nothingToReset" | "uncertain";

export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: string | null;
}

export interface CreditsSnapshot { hasCredits: boolean; unlimited: boolean; balance: string | null }
export interface IndividualLimitSnapshot { limit: string; used: string; remainingPercent: number; resetsAt: string | null }
export interface ResetCreditInventory { availableCount: number; inventoryFingerprint: string | null }
export interface ResetCreditRecommendation {
  protocol: AgentProtocol;
  action: "consume_usage_reset";
  recommendationId: string;
  idempotencyKey: string;
  requiresUserConfirmation: false;
  weeklyRemainingPercent: number;
  thresholdPercent: number;
  weeklyResetsAt: string;
  minimumTimeToResetMs: number;
}
export interface ResetCreditStatus {
  enabled: boolean;
  availableCount: number;
  recommendation: ResetCreditRecommendation | null;
  verification: "not_requested" | "verified" | "consumed_pending_propagation" | "unavailable";
  reason: string | null;
}
export interface ResetFollowup {
  recommendationId: string;
  idempotencyKey: string;
  outcome: ResetFollowupOutcome;
}

export interface QuotaBucket {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  longWindows: QuotaWindow[];
  credits: CreditsSnapshot | null;
  individualLimit: IndividualLimitSnapshot | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: string | null;
  laneId: QuotaLaneId;
}

export interface PolicyProfile {
  policyMode: "adaptive" | "weekly_only";
  planGroup: "free_go" | "standard" | "pro" | "flexible" | "unknown";
  baselineRemainingPercent: number;
  learnedMeanPercent: number | null;
  sampleCount: number;
  confidence: LearningConfidence;
  userOverridePercent: number;
  automaticThresholdPercent: number;
  effectiveThresholdPercent: number;
  jobClass: JobClass | null;
}

export interface QuotaLaneStatus {
  laneId: QuotaLaneId;
  detection: "active_default" | "explicit_backend_bucket" | "unavailable";
  available: boolean;
  bucket: QuotaBucket | null;
  window: QuotaWindow | null;
  quotaPath: QuotaPath;
  recommendation: QuotaRecommendation;
  mayConsumeCredits: boolean;
  profile: PolicyProfile;
  reason: string | null;
}

export interface QuotaError { code: string; message: string }

export interface QuotaSnapshot {
  pacing?: Partial<Record<QuotaLaneId, Pacing>>;
  checkAgainBy?: string;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  longWindows: QuotaWindow[];
  activeBucket: QuotaBucket | null;
  buckets: Record<string, QuotaBucket>;
  planType: string | null;
  rateLimitReachedType: string | null;
  recommendation: QuotaRecommendation;
  quotaPath: QuotaPath;
  mayConsumeCredits: boolean;
  profile: PolicyProfile;
  fetchedAt: string | null;
  nextRefreshAt: string;
  stale: boolean;
  refreshInProgress: boolean;
  backoffUntil: string | null;
  source: QuotaSource;
  error: QuotaError | null;
  lanes: Partial<Record<QuotaLaneId, QuotaLaneStatus>>;
  resetCredit: ResetCreditStatus;
}

export interface RawRateLimitWindow { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
export interface RawCreditsSnapshot { hasCredits?: unknown; unlimited?: unknown; balance?: unknown }
export interface RawIndividualLimitSnapshot { limit?: unknown; used?: unknown; remainingPercent?: unknown; resetsAt?: unknown }

export interface RawRateLimitSnapshot {
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
  planType?: unknown;
  rateLimitReachedType?: unknown;
  limitId?: unknown;
  limitName?: unknown;
  credits?: RawCreditsSnapshot | null;
  individualLimit?: RawIndividualLimitSnapshot | null;
  spendControlReached?: unknown;
}

export interface RawRateLimitsResponse {
  rateLimits?: RawRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RawRateLimitSnapshot> | null;
  rateLimitResetCredits?: {
    availableCount?: unknown;
    credits?: Array<{ id?: unknown; resetType?: unknown; status?: unknown; expiresAt?: unknown }> | null;
  } | null;
}

export interface RawAccountResponse {
  account?: { type?: unknown; email?: unknown; planType?: unknown } | null;
  requiresOpenaiAuth?: unknown;
}

export interface AppServerQuotaResult { account: RawAccountResponse; rateLimits: RawRateLimitsResponse }

export interface JobPreflightInput {
  agentProtocol?: AgentProtocol;
  jobId: string;
  taskId: string;
  workspaceRoot: string;
  jobClass: JobClass;
  description: string;
  estimatedMinutes?: number;
  laneId?: QuotaLaneId;
  sessionRole?: "main" | "lightweight";
}

export interface StoredResetRecommendation {
  id: string;
  idempotencyKey: string;
  profileKey: string;
  accountFingerprint: string;
  planType: string;
  limitId: string;
  weeklyResetAt: string;
  initialRemainingPercent: number;
  thresholdPercent: number;
  inventoryFingerprint: string;
  state: "recommended" | "uncertain" | "consumed" | "verified" | "no_credit" | "nothing_to_reset";
  createdAtMs: number;
  updatedAtMs: number;
}

export interface JobPreflightResult {
  canStartSegment?: boolean;
  validUntil?: string | null;
  checkAgainBy?: string;
  maxSegmentMinutes?: number;
  checkpointRequired?: boolean;
  decision: JobDecision;
  reason: string;
  requiredAction: string | null;
  admissionRecorded: boolean;
  quotaPath: QuotaPath;
  mayConsumeCredits: boolean;
  thresholdPercent: number;
  quota: QuotaSnapshot;
  laneId: QuotaLaneId;
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
  laneId?: QuotaLaneId;
  jobClass?: JobClass;
}

export interface StoredCheckpoint extends CheckpointPayload { id: string; createdAt: string; resumeAt: string | null }

export interface StoredDefer {
  id: string;
  checkpointId: string;
  workspaceRoot: string;
  taskId: string;
  automationId: string | null;
  state: "active" | "superseded" | "fired";
  resumeAt: string | null;
  createdAt: string;
  updatedAt: string;
  laneId: QuotaLaneId;
}

export interface CachedQuotaRecord {
  snapshot: QuotaSnapshot;
  fetchedAtMs: number;
  nextRefreshAtMs: number;
  accountFingerprint: string | null;
}

export interface BackoffRecord { failureCount: number; kind: string; untilMs: number; errorCode: string }

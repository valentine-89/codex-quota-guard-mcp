import { createHash, randomUUID } from "node:crypto";
import { RESUME_AUTOMATION_PROMPT, resumeAutomationRequest, type ResumeAutomationRequest } from "./automation.js";
import type { GuardConfig } from "./config.js";
import { toGuardError } from "./errors.js";
import {
  buildPolicyProfile,
  creditsUsable,
  allowanceWindow,
  automaticResetThresholdForPlan,
  isWeeklyOnly,
  weeklyResetSoon,
  normalizeRateLimits,
  preflightLane,
  quotaPathFor,
  recommendationFor,
  ttlForWindow,
} from "./policy.js";
import { accountFingerprint, profileKey } from "./store.js";
import { MONITOR_INTERVAL_MS } from "./monitor-state.js";
import type { StateStore } from "./store.js";
import type {
  AppServerQuotaResult,
  CheckpointPayload,
  JobClass,
  JobPreflightInput,
  JobPreflightResult,
  PolicyProfile,
  QuotaSnapshot,
  QuotaLaneId,
  QuotaLaneStatus,
  ResetCreditStatus,
  ResetFollowup,
  StoredCheckpoint,
  StoredDefer,
} from "./types.js";

export interface QuotaReader { readQuota(): Promise<AppServerQuotaResult> }
export interface ServiceDependencies { now?: () => number; random?: () => number; ownerId?: string; sleep?: (ms: number) => Promise<void> }
export const INTERACTIVE_REFRESH_MIN_AGE_MS = 30_000;

function iso(ms: number | null): string | null { return ms === null ? null : new Date(ms).toISOString() }

export class QuotaGuardService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ownerId: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly key: string;
  private monitorCapability: () => boolean = () => false;
  private captureAutomation: ((defer: StoredDefer) => string | null) | undefined;
  private readonly runtimeMode = "shared-http" as const;
  private liveClientCount: () => number = () => 0;

  setLiveClientCount(read: () => number): void { this.liveClientCount = read; }

  setMonitorCapability(capability: () => boolean): void { this.monitorCapability = capability; }
  setAutomationCapture(capture: (defer: StoredDefer) => string | null): void { this.captureAutomation = capture; }
  monitorStatus(): object {
    const state = this.store.monitor.status(this.key);
    return { available: this.monitorCapability(), intervalMs: MONITOR_INTERVAL_MS,
      pendingRecords: this.store.monitor.list(this.key).length,
      nextPollAt: iso(state?.nextPollAt ?? null), lastPollAt: iso(state?.lastPollAt ?? null),
      lastError: state?.lastError ?? null, requiresLiveMcpProcess: true,
      requiresLiveClientConnection: true, runtimeMode: this.runtimeMode,
      lifecycleMode: "codex-bound", liveClients: this.liveClientCount() };
  }

  hasPendingRecovery(): boolean { return this.store.monitor.list(this.key).length > 0; }

  constructor(
    private readonly config: GuardConfig,
    private readonly store: StateStore,
    private readonly reader: QuotaReader,
    dependencies: ServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.ownerId = dependencies.ownerId ?? randomUUID();
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.key = profileKey(config.codexHome);
  }

  private unknownProfile(): PolicyProfile {
    return buildPolicyProfile(null, null, 0, 0, null, this.config);
  }

  private unknownSnapshot(nextRefreshAtMs: number, refreshInProgress: boolean): QuotaSnapshot {
    return {
      fiveHour: null, weekly: null, longWindows: [], activeBucket: null, buckets: {}, planType: null,
      rateLimitReachedType: null, recommendation: "checkpoint_and_defer", quotaPath: "unavailable",
      mayConsumeCredits: false, profile: this.unknownProfile(), fetchedAt: null,
      nextRefreshAt: new Date(nextRefreshAtMs).toISOString(), stale: true, refreshInProgress,
      backoffUntil: null, source: "unavailable", error: null, lanes: {},
      resetCredit: { enabled: this.config.automaticWeeklyReset.enabled, availableCount: 0,
        recommendation: null, verification: "unavailable", reason: "quota_unavailable" },
    };
  }

  private isV2Snapshot(snapshot: QuotaSnapshot): boolean {
    return typeof snapshot.profile === "object" && "activeBucket" in snapshot
      && Array.isArray(snapshot.longWindows) && typeof snapshot.lanes === "object"
      && typeof snapshot.resetCredit === "object";
  }

  private identity(snapshot: QuotaSnapshot, fingerprint: string | null, bucket = snapshot.activeBucket): { key: string; fingerprint: string; planType: string; limitId: string } | null {
    if (!fingerprint || !bucket) return null;
    return {
      key: this.key,
      fingerprint,
      planType: snapshot.planType ?? "unknown",
      limitId: bucket?.limitId ?? "active",
    };
  }

  private resetInventory(raw: AppServerQuotaResult["rateLimits"]["rateLimitResetCredits"], nowMs: number): {
    availableCount: number; fingerprint: string | null;
  } {
    const credits = Array.isArray(raw?.credits) ? raw.credits.filter(credit =>
      typeof credit.id === "string" && credit.id.length > 0
      && credit.resetType === "codexRateLimits" && credit.status === "available"
      && typeof credit.expiresAt === "number" && Number.isFinite(credit.expiresAt) && credit.expiresAt * 1_000 > nowMs) : [];
    if (!credits.length) return { availableCount: 0, fingerprint: null };
    const fingerprint = createHash("sha256").update(credits.map(credit => credit.id as string).sort().join("\n")).digest("hex");
    return { availableCount: credits.length, fingerprint };
  }

  private resetStatusForFresh(snapshot: QuotaSnapshot, fingerprint: string | null,
    inventory: { availableCount: number; fingerprint: string | null }): ResetCreditStatus {
    const disabled: ResetCreditStatus = { enabled: this.config.automaticWeeklyReset.enabled,
      availableCount: inventory.availableCount, recommendation: null, verification: "not_requested", reason: null };
    if (!this.config.automaticWeeklyReset.enabled) return { ...disabled, reason: "disabled" };
    if (snapshot.stale || snapshot.refreshInProgress || snapshot.error) return { ...disabled, verification: "unavailable", reason: "quota_unavailable" };
    const bucket = snapshot.activeBucket;
    const weekly = bucket?.weekly;
    const threshold = automaticResetThresholdForPlan(snapshot.planType, this.config);
    const identity = this.identity(snapshot, fingerprint, bucket);
    if (!bucket || !weekly || !weekly.resetsAt || !identity || threshold === null) return { ...disabled, reason: "ineligible_or_unknown_plan" };
    const resetAtMs = Date.parse(weekly.resetsAt);
    if (!Number.isFinite(resetAtMs) || resetAtMs - this.now() <= this.config.automaticWeeklyReset.minimumTimeToResetMs) {
      return { ...disabled, reason: "weekly_reset_within_72h" };
    }
    if (weekly.remainingPercent > threshold) return { ...disabled, reason: "weekly_quota_above_threshold" };
    const epoch = this.store.listResetRecommendationsForEpoch(identity, weekly.resetsAt);
    if (epoch.some(record => ["consumed", "verified", "nothing_to_reset"].includes(record.state))) {
      const verified = epoch.some(record => record.state === "verified");
      return { ...disabled, verification: verified ? "verified" : "consumed_pending_propagation",
        reason: verified ? "reset_verified" : "reset_already_consumed_for_epoch" };
    }
    const reusable = epoch.find(record => record.state === "uncertain" || record.state === "recommended");
    if (!reusable && (!inventory.fingerprint || inventory.availableCount <= 0)) return { ...disabled, reason: "no_available_reset" };
    const recommendation = reusable ?? this.store.getOrCreateResetRecommendation(identity, weekly.resetsAt,
      weekly.remainingPercent, threshold, inventory.fingerprint!, this.now());
    if (recommendation.state === "no_credit") return { ...disabled, reason: "no_credit_reported" };
    return { ...disabled, recommendation: {
      protocol: "auto-reset-v1", action: "consume_usage_reset", recommendationId: recommendation.id,
      idempotencyKey: recommendation.idempotencyKey, requiresUserConfirmation: false,
      weeklyRemainingPercent: recommendation.initialRemainingPercent,
      thresholdPercent: recommendation.thresholdPercent, weeklyResetsAt: recommendation.weeklyResetAt,
      minimumTimeToResetMs: this.config.automaticWeeklyReset.minimumTimeToResetMs,
    }, reason: recommendation.state === "uncertain" ? "retry_same_idempotency_key" : "weekly_threshold_and_reset_far" };
  }

  private profileFor(snapshot: QuotaSnapshot, fingerprint: string | null, jobClass: JobClass | null, bucket = snapshot.activeBucket): PolicyProfile {
    const identity = this.identity(snapshot, fingerprint, bucket);
    if (!identity) return buildPolicyProfile(snapshot.planType, null, 0, 0, jobClass, this.config, isWeeklyOnly(bucket));
    const learning = bucket?.fiveHour
      ? this.store.getLearning(identity, jobClass, this.config.sampleWindow, this.config.minSamples)
      : { mean: null, count: 0 };
    const override = this.store.getOverride(this.key, identity.fingerprint, identity.planType);
    return buildPolicyProfile(snapshot.planType, learning.mean, learning.count, override, jobClass, this.config, isWeeklyOnly(bucket));
  }

  private decorate(snapshot: QuotaSnapshot, fingerprint: string | null, jobClass: JobClass | null = null): QuotaSnapshot {
    const lanes: Partial<Record<QuotaLaneId, QuotaLaneStatus>> = { ...snapshot.lanes };
    const source = Object.keys(lanes).length ? lanes : {};
    if (!source.primary && snapshot.activeBucket?.laneId === "primary") {
      source.primary = this.emptyLane("primary", snapshot.activeBucket);
    }
    for (const laneId of ["primary", "secondary"] as const) {
      const entry = source[laneId];
      const bucket = entry?.bucket ?? null;
      const profile = this.profileFor(snapshot, fingerprint, jobClass, bucket);
      const path = snapshot.stale || snapshot.refreshInProgress ? "unavailable" : quotaPathFor(bucket, profile.effectiveThresholdPercent, this.config, this.now());
      lanes[laneId] = {
        laneId,
        detection: bucket
          ? (bucket.limitId === snapshot.activeBucket?.limitId ? "active_default" : "explicit_backend_bucket")
          : "unavailable",
        available: bucket !== null,
        bucket,
        window: allowanceWindow(bucket),
        quotaPath: path,
        recommendation: path === "unavailable" ? "checkpoint_and_defer" : recommendationFor(bucket, profile, this.config, this.now()),
        mayConsumeCredits: path === "credits",
        profile,
        reason: path === "weekly_advisory" ? "Weekly quota is low; reset is not under24h. Warning only; backend limits still apply."
          : bucket ? null : "No explicit app-server bucket was reported for this lane.",
      };
    }
    const activeLane = lanes[snapshot.activeBucket?.laneId ?? "primary"] ?? lanes.primary;
    const profile = activeLane?.profile ?? this.profileFor(snapshot, fingerprint, jobClass);
    const quotaPath = snapshot.stale || snapshot.refreshInProgress ? "unavailable" : quotaPathFor(snapshot.activeBucket, profile.effectiveThresholdPercent, this.config, this.now());
    return {
      ...snapshot,
      lanes,
      profile,
      recommendation: quotaPath === "unavailable" ? "checkpoint_and_defer" : recommendationFor(snapshot.activeBucket, profile, this.config, this.now()),
      quotaPath,
      mayConsumeCredits: quotaPath === "credits",
    };
  }

  private emptyLane(laneId: QuotaLaneId, bucket: NonNullable<QuotaSnapshot["activeBucket"]>): QuotaLaneStatus {
    const profile = buildPolicyProfile(bucket.planType, null, 0, 0, null, this.config);
    return { laneId, detection: "active_default", available: true, bucket,
      window: allowanceWindow(bucket), quotaPath: "unavailable", recommendation: "checkpoint_and_defer",
      mayConsumeCredits: false, profile, reason: null };
  }

  async quotaStatus(): Promise<QuotaSnapshot> {
    const nowMs = this.now();
    let cached = this.store.getCache(this.key);
    const backoff = this.store.getBackoff(this.key);
    if (cached && !this.isV2Snapshot(cached.snapshot)) {
      this.store.expireCache(this.key);
      this.store.invalidateObservations(this.key);
      cached = null;
    }
    if (cached && nowMs < cached.nextRefreshAtMs && !(backoff && nowMs < backoff.untilMs)) {
      return this.cachedStatus(cached.snapshot, cached.accountFingerprint, cached.nextRefreshAtMs, false, backoff?.untilMs ?? null);
    }
    if (backoff && nowMs < backoff.untilMs) {
      this.store.invalidateObservations(this.key);
      const base = cached
        ? this.cachedStatus(cached.snapshot, cached.accountFingerprint, Math.max(cached.nextRefreshAtMs, backoff.untilMs), true, backoff.untilMs)
        : this.unknownSnapshot(backoff.untilMs, false);
      return { ...base, backoffUntil: iso(backoff.untilMs), error: {
        code: backoff.errorCode, message: "Quota refresh is in shared backoff; using the latest safe state.",
      } };
    }

    const acquired = this.store.tryAcquireLease(this.key, this.ownerId, nowMs, this.config.leaseDurationMs);
    if (!acquired) {
      this.store.invalidateObservations(this.key);
      return cached
        ? this.cachedStatus(cached.snapshot, cached.accountFingerprint, cached.nextRefreshAtMs, true, backoff?.untilMs ?? null)
        : this.unknownSnapshot(nowMs + this.config.ttlMs.low, true);
    }

    try {
      const raw = await this.reader.readQuota();
      const normalized = normalizeRateLimits(raw.rateLimits);
      const account = raw.account.account;
      const accountPlan = account && typeof account.planType === "string" ? account.planType : null;
      const planType = accountPlan ?? normalized.activeBucket.planType;
      const activeBucket = { ...normalized.activeBucket, planType };
      const buckets = { ...normalized.buckets };
      const activeKey = activeBucket.limitId ?? "active";
      buckets[activeKey] = activeBucket;
      const fingerprint = accountFingerprint(account?.type, account?.email);
      const resetInventory = this.resetInventory(raw.rateLimits.rateLimitResetCredits, nowMs);
      if (fingerprint) this.store.invalidateResetRecommendationsForOtherAccounts(this.key, fingerprint);
      const baseProfile = buildPolicyProfile(planType, null, 0, 0, null, this.config);
      const roleBuckets = Object.values(normalized.laneBuckets);
      let ttl = Math.min(...roleBuckets.map((bucket) => ttlForWindow(allowanceWindow(bucket ?? null), nowMs, this.config)));
      // A usable secondary role keeps the shared cache observable while primary sleeps.
      // Never cache past a reported boundary without revalidation after reset grace.
      for (const bucket of roleBuckets) {
        if (isWeeklyOnly(bucket ?? null)) ttl = Math.min(ttl, MONITOR_INTERVAL_MS);
        if (creditsUsable(bucket ?? null)) ttl = Math.min(ttl, this.config.ttlMs.warning);
        for (const window of [bucket?.fiveHour, ...(bucket?.longWindows ?? []), bucket?.individualLimit]) {
          if (!window?.resetsAt) continue;
          const untilReset = Date.parse(window.resetsAt) + this.config.resetGraceMs - nowMs;
          if (untilReset > 0) ttl = Math.min(ttl, untilReset);
        }
      }
      const nextRefreshAtMs = nowMs + ttl;
      const lanes = {} as Partial<Record<QuotaLaneId, QuotaLaneStatus>>;
      for (const [laneId, bucket] of Object.entries(normalized.laneBuckets)) {
        if (!bucket || !["primary", "secondary", "unknown"].includes(laneId)) continue;
        const laneBucket = bucket === normalized.activeBucket ? activeBucket : bucket;
        lanes[laneId as QuotaLaneId] = {
          laneId: laneId as QuotaLaneId,
          detection: bucket === normalized.activeBucket ? "active_default" : "explicit_backend_bucket", available: true,
          bucket: laneBucket, window: allowanceWindow(laneBucket), quotaPath: "unavailable", recommendation: "checkpoint_and_defer",
          mayConsumeCredits: false, profile: baseProfile, reason: null,
        };
      }
      let snapshot: QuotaSnapshot = {
        fiveHour: activeBucket.fiveHour, weekly: activeBucket.weekly, longWindows: activeBucket.longWindows,
        activeBucket, buckets, planType, rateLimitReachedType: activeBucket.rateLimitReachedType,
        recommendation: "checkpoint_and_defer", quotaPath: "unavailable", mayConsumeCredits: false,
        profile: baseProfile, fetchedAt: new Date(nowMs).toISOString(), nextRefreshAt: new Date(nextRefreshAtMs).toISOString(),
        stale: false, refreshInProgress: false, backoffUntil: null, source: "codex-app-server", error: null, lanes,
        resetCredit: { enabled: this.config.automaticWeeklyReset.enabled, availableCount: resetInventory.availableCount,
          recommendation: null, verification: "not_requested", reason: null },
      };
      const learningWindowChanged = (["primary", "secondary"] as const).some((role) => {
        const previous = cached?.snapshot.lanes?.[role]?.bucket;
        const current = lanes[role]?.bucket;
        return previous?.limitId !== current?.limitId
          || previous?.fiveHour?.windowDurationMins !== current?.fiveHour?.windowDurationMins;
      });
      if (!cached || cached.accountFingerprint !== fingerprint || cached.snapshot.planType !== planType
        || cached.snapshot.activeBucket?.limitId !== activeBucket.limitId || backoff || learningWindowChanged) {
        this.store.invalidateObservations(this.key);
      }
      for (const bucket of roleBuckets) {
        const identity = this.identity(snapshot, fingerprint, bucket ?? null);
        if (identity && bucket?.fiveHour) {
          this.store.observeFreshQuota(identity, bucket.fiveHour.usedPercent, bucket.fiveHour.resetsAt,
            nowMs, this.config.sampleWindow);
        }
      }
      snapshot = this.decorate(snapshot, fingerprint);
      snapshot = { ...snapshot, resetCredit: this.resetStatusForFresh(snapshot, fingerprint, resetInventory) };
      this.store.saveCache(this.key, snapshot, nextRefreshAtMs, fingerprint, nowMs);
      return snapshot;
    } catch (error) {
      this.store.invalidateObservations(this.key);
      const guardError = toGuardError(error);
      if (guardError.code === "CHATGPT_LOGIN_REQUIRED" || guardError.code === "ACCOUNT_CHANGED_DURING_READ") {
        this.store.clearCache(this.key);
        this.store.clearResetRecommendations(this.key);
        const next = nowMs + this.config.ttlMs.low;
        return { ...this.unknownSnapshot(next, false), error: { code: guardError.code, message: guardError.message } };
      }
      const kind = guardError.retryAfterMs !== null || /429|RATE_LIMIT/i.test(guardError.code)
        ? "rate-limit" : /TIMEOUT|SERVER|CLOSED|FAILED/i.test(guardError.code) ? "server" : "other";
      const nextBackoff = this.store.recordFailure(this.key, kind, guardError.code, nowMs, guardError.retryAfterMs, this.random);
      const base = cached
        ? this.cachedStatus(cached.snapshot, cached.accountFingerprint, Math.max(cached.nextRefreshAtMs, nextBackoff.untilMs), true, nextBackoff.untilMs)
        : this.unknownSnapshot(nextBackoff.untilMs, false);
      return { ...base, backoffUntil: iso(nextBackoff.untilMs), error: { code: guardError.code, message: guardError.message } };
    } finally {
      this.store.releaseLease(this.key, this.ownerId);
    }
  }

  private async reconcileReset(followup: ResetFollowup): Promise<QuotaSnapshot> {
    const record = this.store.getResetRecommendation(followup.recommendationId, followup.idempotencyKey);
    if (!record || record.profileKey !== this.key) {
      throw new Error("RESET_FOLLOWUP_INVALID: recommendation ID and idempotency key do not match.");
    }
    const transition = followup.outcome === "uncertain" ? "uncertain"
      : followup.outcome === "noCredit" ? "no_credit"
      : followup.outcome === "nothingToReset" ? "nothing_to_reset" : "consumed";
    if (["consumed", "verified", "no_credit", "nothing_to_reset"].includes(record.state)) {
      if (record.state === transition || (record.state === "verified" && transition === "consumed")) {
        return this.quotaStatus();
      }
      throw new Error("RESET_FOLLOWUP_REPLAY: terminal recommendation cannot change outcome.");
    }
    const updated = this.store.updateResetRecommendation(record.id, record.idempotencyKey, transition, this.now())!;
    const cached = this.store.getCache(this.key);
    const baseStatus = cached?.snapshot.resetCredit ?? { enabled: this.config.automaticWeeklyReset.enabled,
      availableCount: 0, recommendation: null, verification: "unavailable" as const, reason: null };
    if (transition === "uncertain") {
      this.store.updateCachedResetCredit(this.key, { ...baseStatus, recommendation: {
        protocol: "auto-reset-v1", action: "consume_usage_reset", recommendationId: updated.id,
        idempotencyKey: updated.idempotencyKey, requiresUserConfirmation: false,
        weeklyRemainingPercent: updated.initialRemainingPercent, thresholdPercent: updated.thresholdPercent,
        weeklyResetsAt: updated.weeklyResetAt,
        minimumTimeToResetMs: this.config.automaticWeeklyReset.minimumTimeToResetMs,
      }, verification: "not_requested", reason: "retry_same_idempotency_key" }, this.now());
      return this.quotaStatus();
    }
    if (transition === "no_credit" || transition === "nothing_to_reset") {
      this.store.updateCachedResetCredit(this.key, { ...baseStatus, recommendation: null,
        verification: "unavailable", reason: transition }, this.now());
      return this.quotaStatus();
    }

    this.store.updateCachedResetCredit(this.key, { ...baseStatus, recommendation: null,
      verification: "consumed_pending_propagation", reason: "waiting_for_backend_propagation" }, this.now());
    let latest = await this.quotaStatus();
    for (const delay of this.config.automaticWeeklyReset.recheckDelaysMs) {
      await this.sleep(delay);
      this.store.expireCache(this.key);
      latest = await this.quotaStatus();
      const latestCache = this.store.getCache(this.key);
      const weekly = latest.activeBucket?.weekly;
      const sameIdentity = latestCache?.accountFingerprint === record.accountFingerprint
        && latest.planType === record.planType && latest.activeBucket?.limitId === record.limitId;
      if (sameIdentity && weekly && (weekly.resetsAt !== record.weeklyResetAt
        || weekly.remainingPercent > record.initialRemainingPercent)) {
        this.store.updateResetRecommendation(record.id, record.idempotencyKey, "verified", this.now());
        const verified = { ...latest.resetCredit, recommendation: null, verification: "verified" as const,
          reason: "reset_verified" };
        this.store.updateCachedResetCredit(this.key, verified, this.now());
        return { ...latest, resetCredit: verified };
      }
      if (!sameIdentity && latestCache?.accountFingerprint) return latest;
    }
    const pending = { ...latest.resetCredit, recommendation: null,
      verification: "consumed_pending_propagation" as const, reason: "backend_propagation_not_observed" };
    this.store.updateCachedResetCredit(this.key, pending, this.now());
    this.store.capCacheDeadline(this.key, this.now() + INTERACTIVE_REFRESH_MIN_AGE_MS);
    return { ...latest, resetCredit: pending };
  }

  /** Only detected caution/defer lanes tighten freshness; lease and backoff still apply. */
  async quotaStatusForRequest(followup?: ResetFollowup): Promise<QuotaSnapshot> {
    if (followup) return this.reconcileReset(followup);
    const cached = this.store.getCache(this.key);
    const status = cached && this.isV2Snapshot(cached.snapshot)
      ? this.decorate(cached.snapshot, cached.accountFingerprint) : null;
    const nearLimit = Object.values(status?.lanes ?? {}).some(lane => lane.available
      && (lane.recommendation === "caution" || lane.recommendation === "checkpoint_and_defer"));
    if (cached && nearLimit && this.now() - cached.fetchedAtMs > INTERACTIVE_REFRESH_MIN_AGE_MS) {
      this.store.capCacheDeadline(this.key, cached.fetchedAtMs + INTERACTIVE_REFRESH_MIN_AGE_MS);
    }
    return this.quotaStatus();
  }

  /** Internal timer path, never a public force-refresh input. */
  async monitorQuota(): Promise<QuotaSnapshot> {
    const cache = this.store.getCache(this.key);
    if (cache && this.store.monitor.list(this.key).length) {
      this.store.capCacheDeadline(this.key, cache.fetchedAtMs + MONITOR_INTERVAL_MS);
    }
    return this.quotaStatus();
  }

  monitorCanResume(defer: StoredDefer, snapshot: QuotaSnapshot): boolean {
    const cache = this.store.getCache(this.key);
    const recovery = this.store.monitor.list(this.key).find(item => item.deferId === defer.id);
    // The defer belongs to a workspace/task/role, not the account that exhausted
    // quota. A newly signed-in account may recover it using its own profile.
    if (!recovery || !cache?.accountFingerprint || cache.snapshot.fetchedAt !== snapshot.fetchedAt
      || snapshot.stale || snapshot.refreshInProgress || snapshot.error
      || !snapshot.lanes[defer.laneId]?.bucket) return false;
    const checkpoint = this.getCheckpoint(defer.workspaceRoot, defer.taskId, defer.checkpointId);
    const jobClass = checkpoint?.jobClass ?? (defer.laneId === "secondary" ? "small" : "long");
    const admission = preflightLane(this.decorate(snapshot, cache.accountFingerprint, jobClass), jobClass, this.config, defer.laneId, this.now());
    // Warning-only execution is not replenished quota and must not advance a schedule.
    return admission.decision !== "defer" && admission.quotaPath !== "weekly_advisory";
  }

  async jobPreflight(input: JobPreflightInput): Promise<JobPreflightResult> {
    if (![input.jobId, input.taskId, input.workspaceRoot, input.description].every((value) => typeof value === "string" && value.trim())) {
      throw new Error("jobId, taskId, workspaceRoot and description are required");
    }
    if (input.laneId && input.sessionRole && input.laneId !== (input.sessionRole === "lightweight" ? "secondary" : "primary")) {
      throw new Error("laneId conflicts with sessionRole");
    }
    const status = await this.quotaStatus();
    const cache = this.store.getCache(this.key);
    const quota = this.decorate(status, cache?.accountFingerprint ?? null, input.jobClass);
    const laneId = input.laneId ?? (input.sessionRole === "lightweight" ? "secondary" : "primary");
    let result = preflightLane(quota, input.jobClass, this.config, laneId, this.now());
    const laneBucket = quota.lanes[laneId]?.bucket ?? null;
    const identity = this.identity(quota, cache?.accountFingerprint ?? null, laneBucket);
    const laneWindow = allowanceWindow(laneBucket);
    if (result.decision !== "defer" && (!identity || cache?.snapshot.fetchedAt !== status.fetchedAt)) {
      return { ...result, decision: "defer", quotaPath: "unavailable", mayConsumeCredits: false,
        reason: "Account identity is unavailable or changed during admission; retry on a fresh shared snapshot." };
    }
    if (result.decision !== "defer" && identity) {
      const recorded = this.store.recordAdmission(identity, input, laneWindow?.usedPercent ?? 0, laneWindow?.resetsAt ?? null,
        this.now(), laneBucket?.fiveHour != null);
      result = { ...result, admissionRecorded: recorded };
    }
    return result;
  }

  async quotaProfile(action: "get" | "adjust" | "reset", deltaPercent?: number): Promise<PolicyProfile> {
    const status = await this.quotaStatus();
    const cache = this.store.getCache(this.key);
    const identity = this.identity(status, cache?.accountFingerprint ?? null);
    if (!identity && action !== "get") throw new Error("Cannot persist an override without a known account identity");
    if (!identity) return status.profile;
    if (status.stale && action !== "get") throw new Error("Wait for a fresh account snapshot before changing a profile");
    if (action === "adjust") this.store.adjustOverride(this.key, identity.fingerprint, identity.planType, deltaPercent ?? 0, this.now());
    if (action === "reset") this.store.resetOverride(this.key, identity.fingerprint, identity.planType);
    return this.profileFor(status, identity.fingerprint, null);
  }

  createCheckpoint(payload: CheckpointPayload, resumeAtMs: number | null = null): StoredCheckpoint {
    return this.store.createCheckpoint(this.key, payload, resumeAtMs, this.now());
  }
  getCheckpoint(workspaceRoot: string, taskId?: string, checkpointId?: string): StoredCheckpoint | null {
    return this.store.getCheckpoint(this.key, workspaceRoot, taskId, checkpointId);
  }

  private blockingResumeAt(quota: QuotaSnapshot, laneId: QuotaLaneId = "primary"): number | null {
    const lane = quota.lanes[laneId];
    const bucket = lane?.bucket ?? null;
    if (quota.stale || !bucket || creditsUsable(bucket)) return null;
    if (isWeeklyOnly(bucket) && !weeklyResetSoon(bucket, this.config, this.now())) return null;
    const allowance = allowanceWindow(bucket);
    const reachedType = bucket.rateLimitReachedType ?? "";
    const individualExhausted = bucket.individualLimit?.remainingPercent === 0;
    if (reachedType && reachedType !== "rate_limit_reached"
      && !(reachedType === "workspace_member_usage_limit_reached" && individualExhausted)) return null;
    if (bucket.spendControlReached === true && !individualExhausted) return null;
    const resets: Array<string | null> = [];
    const threshold = lane?.profile.effectiveThresholdPercent ?? quota.profile.effectiveThresholdPercent;
    if (allowance && allowance.remainingPercent <= threshold) resets.push(allowance.resetsAt);
    for (const window of bucket.longWindows) {
      if (window.remainingPercent <= 0) resets.push(window.resetsAt);
    }
    if (individualExhausted) resets.push(bucket.individualLimit?.resetsAt ?? null);
    // Unknown reset for even one mandatory constraint prevents a safe wake time.
    const timestamps = resets.map((reset) => reset === null ? NaN : Date.parse(reset));
    if (!timestamps.length || timestamps.some((reset) => !Number.isFinite(reset) || reset <= this.now())) return null;
    return Math.max(...timestamps) + this.config.resetGraceMs;
  }

  async deferUntilReset(payload: CheckpointPayload): Promise<{
    deferId: string; defer: StoredDefer; checkpoint: StoredCheckpoint; resumeAt: string | null; canSchedule: boolean;
    reason: "scheduled" | "reset_too_far" | "reset_unknown" | "advisory_only"; automationPrompt: string;
    automationRequest: ResumeAutomationRequest | null; quota: QuotaSnapshot;
  }> {
    if (!payload.taskId) throw new Error("taskId is required for defer_until_reset in v0.2");
    const status = await this.quotaStatus();
    const quota = this.decorate(status, this.store.getCache(this.key)?.accountFingerprint ?? null, payload.jobClass ?? null);
    const laneId = payload.laneId ?? "primary";
    const resumeAtMs = this.blockingResumeAt(quota, laneId);
    const checkpoint = this.createCheckpoint({ ...payload, laneId }, resumeAtMs);
    const defer = this.store.createDefer(this.key, checkpoint, payload.taskId, resumeAtMs, this.now(), laneId);
    const cache = this.store.getCache(this.key);
    const identity = this.identity(quota, cache?.accountFingerprint ?? null, quota.lanes[laneId]?.bucket ?? null);
    const observedIdentity = !quota.stale && !quota.refreshInProgress && cache?.snapshot.fetchedAt === quota.fetchedAt ? identity : null;
    this.store.monitor.enroll(this.key, defer.id, observedIdentity ?? { fingerprint: null, planType: null, limitId: null }, this.now());
    const canSchedule = resumeAtMs !== null && resumeAtMs > this.now()
      && resumeAtMs - this.now() <= this.config.maxAutomationWaitMs;
    const reason = quota.lanes[laneId]?.quotaPath === "weekly_advisory" ? "advisory_only"
      : resumeAtMs === null ? "reset_unknown" : canSchedule ? "scheduled" : "reset_too_far";
    const automationPrompt = RESUME_AUTOMATION_PROMPT;
    const automationRequest = canSchedule && resumeAtMs !== null
      ? resumeAutomationRequest(defer.id, payload.taskId, resumeAtMs)
      : null;
    return { deferId: defer.id, defer, checkpoint, resumeAt: iso(resumeAtMs), canSchedule, reason,
      automationPrompt, automationRequest, quota };
  }

  attachAutomation(deferId: string, automationId: string): StoredDefer {
    const before = this.store.getDefer(this.key, deferId);
    const defer = this.store.attachAutomation(this.key, deferId, automationId, this.now());
    if (!defer || defer.state !== "active" || defer.automationId !== automationId) {
      throw new Error("The defer record is missing, no longer active, or does not belong to this quota-guard profile.");
    }
    // Capture once at first attachment. Repeated attach must not adopt user edits.
    if (before?.automationId === null && this.captureAutomation) {
      try {
        const definition = this.captureAutomation(defer);
        if (definition) this.store.monitor.bindDefinition(this.key, deferId, definition);
      } catch { /* No verified baseline: leave original schedule unchanged. */ }
    }
    return defer;
  }

  async resumePrepare(input: { workspaceRoot: string; taskId: string; deferId?: string; trigger: "manual" | "automation"; laneId?: QuotaLaneId }): Promise<{
    shouldExit: boolean; automationIdsToCancel: string[]; cancellationBestEffort: true;
    checkpointId: string | null; deferIds: string[]; quota: QuotaSnapshot | null; canResume: boolean; laneId: QuotaLaneId;
  }> {
    const laneId = input.laneId ?? "primary";
    const prepared = this.store.prepareResume(this.key, input.workspaceRoot, input.taskId, input.deferId, input.trigger, this.now(), laneId);
    if (prepared.shouldExit) return { ...prepared, cancellationBestEffort: true, quota: null, canResume: false, laneId };
    const cached = this.store.getCache(this.key);
    const age = cached ? this.now() - cached.fetchedAtMs : Number.POSITIVE_INFINITY;
    const recommendation = cached?.snapshot.lanes?.[laneId]?.recommendation ?? cached?.snapshot.recommendation;
    if (recommendation === "checkpoint_and_defer" && age >= this.config.manualResumeMinAgeMs) {
      this.store.expireCache(this.key);
    }
    const quota = await this.quotaStatus();
    const current = this.store.getCache(this.key);
    const checkpoint = prepared.checkpointId
      ? this.getCheckpoint(input.workspaceRoot, input.taskId, prepared.checkpointId) : null;
    const jobClass = checkpoint?.jobClass ?? (laneId === "secondary" ? "small" : "long");
    const identitySafe = !!current?.accountFingerprint && current.snapshot.fetchedAt === quota.fetchedAt;
    const canResume = identitySafe && !quota.stale && !quota.refreshInProgress && !quota.error
      && preflightLane(this.decorate(quota, current.accountFingerprint, jobClass), jobClass, this.config, laneId, this.now()).decision !== "defer";
    return { ...prepared, cancellationBestEffort: true, quota, canResume, laneId };
  }

  private cachedStatus(snapshot: QuotaSnapshot, fingerprint: string | null, nextRefreshAtMs: number, stale: boolean, backoffUntilMs: number | null): QuotaSnapshot {
    const expired = Object.values(snapshot.lanes).some((lane) => {
      const bucket = lane?.bucket;
      return [bucket?.fiveHour, ...(bucket?.longWindows ?? []), bucket?.individualLimit]
        .some((window) => window?.resetsAt != null && Date.parse(window.resetsAt) <= this.now());
    });
    stale ||= expired;
    if (stale) this.store.invalidateObservations(this.key);
    const refreshInProgress = this.store.hasActiveLease(this.key, this.now());
    let resetCredit = !this.config.automaticWeeklyReset.enabled
      ? { ...snapshot.resetCredit, enabled: false, recommendation: null, reason: "disabled" }
      : stale || refreshInProgress || backoffUntilMs !== null
        ? { ...snapshot.resetCredit, recommendation: null, verification: "unavailable" as const, reason: "quota_unavailable" }
        : snapshot.resetCredit;
    if (resetCredit.recommendation) {
      const resetAtMs = Date.parse(resetCredit.recommendation.weeklyResetsAt);
      if (!Number.isFinite(resetAtMs)
        || resetAtMs - this.now() <= this.config.automaticWeeklyReset.minimumTimeToResetMs) {
        resetCredit = { ...resetCredit, recommendation: null, reason: "weekly_reset_within_72h" };
      }
    }
    return this.decorate({ ...snapshot, resetCredit, nextRefreshAt: new Date(nextRefreshAtMs).toISOString(), stale,
      refreshInProgress, backoffUntil: iso(backoffUntilMs), source: "cache" }, fingerprint);
  }
}

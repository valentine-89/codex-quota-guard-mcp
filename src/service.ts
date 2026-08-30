import { randomUUID } from "node:crypto";
import type { GuardConfig } from "./config.js";
import { toGuardError } from "./errors.js";
import {
  buildPolicyProfile,
  creditsUsable,
  allowanceWindow,
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
  StoredCheckpoint,
  StoredDefer,
} from "./types.js";

export interface QuotaReader { readQuota(): Promise<AppServerQuotaResult> }
export interface ServiceDependencies { now?: () => number; random?: () => number; ownerId?: string }

function iso(ms: number | null): string | null { return ms === null ? null : new Date(ms).toISOString() }

export class QuotaGuardService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ownerId: string;
  private readonly key: string;
  private monitorCapability: () => boolean = () => false;
  private captureAutomation: ((defer: StoredDefer) => string | null) | undefined;

  setMonitorCapability(capability: () => boolean): void { this.monitorCapability = capability; }
  setAutomationCapture(capture: (defer: StoredDefer) => string | null): void { this.captureAutomation = capture; }
  monitorStatus(): object {
    const state = this.store.monitor.status(this.key);
    return { available: this.monitorCapability(), intervalMs: MONITOR_INTERVAL_MS,
      pendingRecords: this.store.monitor.list(this.key).length,
      nextPollAt: iso(state?.nextPollAt ?? null), lastPollAt: iso(state?.lastPollAt ?? null),
      lastError: state?.lastError ?? null, requiresLiveMcpProcess: true };
  }

  constructor(
    private readonly config: GuardConfig,
    private readonly store: StateStore,
    private readonly reader: QuotaReader,
    dependencies: ServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.ownerId = dependencies.ownerId ?? randomUUID();
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
    };
  }

  private isV2Snapshot(snapshot: QuotaSnapshot): boolean {
    return typeof snapshot.profile === "object" && "activeBucket" in snapshot
      && Array.isArray(snapshot.longWindows) && typeof snapshot.lanes === "object";
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

  private profileFor(snapshot: QuotaSnapshot, fingerprint: string | null, jobClass: JobClass | null, bucket = snapshot.activeBucket): PolicyProfile {
    const identity = this.identity(snapshot, fingerprint, bucket);
    if (!identity) return buildPolicyProfile(snapshot.planType, null, 0, 0, jobClass, this.config);
    const learning = bucket?.fiveHour
      ? this.store.getLearning(identity, jobClass, this.config.sampleWindow, this.config.minSamples)
      : { mean: null, count: 0 };
    const override = this.store.getOverride(this.key, identity.fingerprint, identity.planType);
    return buildPolicyProfile(snapshot.planType, learning.mean, learning.count, override, jobClass, this.config);
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
      const path = snapshot.stale || snapshot.refreshInProgress ? "unavailable" : quotaPathFor(bucket, profile.effectiveThresholdPercent);
      lanes[laneId] = {
        laneId,
        detection: bucket
          ? (bucket.limitId === snapshot.activeBucket?.limitId ? "active_default" : "explicit_backend_bucket")
          : "unavailable",
        available: bucket !== null,
        bucket,
        window: allowanceWindow(bucket),
        quotaPath: path,
        recommendation: path === "unavailable" ? "checkpoint_and_defer" : recommendationFor(bucket, profile, this.config),
        mayConsumeCredits: path === "credits",
        profile,
        reason: bucket ? null : "No explicit app-server bucket was reported for this lane.",
      };
    }
    const activeLane = lanes[snapshot.activeBucket?.laneId ?? "primary"] ?? lanes.primary;
    const profile = activeLane?.profile ?? this.profileFor(snapshot, fingerprint, jobClass);
    const quotaPath = snapshot.stale || snapshot.refreshInProgress ? "unavailable" : quotaPathFor(snapshot.activeBucket, profile.effectiveThresholdPercent);
    return {
      ...snapshot,
      lanes,
      profile,
      recommendation: quotaPath === "unavailable" ? "checkpoint_and_defer" : recommendationFor(snapshot.activeBucket, profile, this.config),
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
      const baseProfile = buildPolicyProfile(planType, null, 0, 0, null, this.config);
      const roleBuckets = Object.values(normalized.laneBuckets);
      let ttl = Math.min(...roleBuckets.map((bucket) => ttlForWindow(allowanceWindow(bucket ?? null), nowMs, this.config)));
      // A usable secondary role keeps the shared cache observable while primary sleeps.
      // Never cache past a reported boundary without revalidation after reset grace.
      for (const bucket of roleBuckets) {
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
      this.store.saveCache(this.key, snapshot, nextRefreshAtMs, fingerprint, nowMs);
      return snapshot;
    } catch (error) {
      this.store.invalidateObservations(this.key);
      const guardError = toGuardError(error);
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
    return preflightLane(this.decorate(snapshot, cache.accountFingerprint, jobClass), jobClass, this.config, defer.laneId).decision !== "defer";
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
    let result = preflightLane(quota, input.jobClass, this.config, laneId);
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
    reason: "scheduled" | "reset_too_far" | "reset_unknown"; automationPrompt: string; quota: QuotaSnapshot;
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
    const reason = resumeAtMs === null ? "reset_unknown" : canSchedule ? "scheduled" : "reset_too_far";
    const automationPrompt = [
      `Resume quota-guard ${laneId} defer ${defer.id} from checkpoint ${checkpoint.id}.`,
      `First call resume_prepare with trigger "automation", workspaceRoot ${JSON.stringify(checkpoint.workspaceRoot)}, taskId ${JSON.stringify(payload.taskId)}, laneId "${laneId}", and deferId "${defer.id}".`,
      "If shouldExit is true, stop without doing work.",
      "If canResume is false, do not start work; read the checkpoint and defer again for the same lane. Schedule only when canSchedule is true and attach the heartbeat ID.",
      `Call checkpoint_get with workspaceRoot ${JSON.stringify(checkpoint.workspaceRoot)}, taskId ${JSON.stringify(payload.taskId)}, checkpointId "${checkpoint.id}". Verify repository state and preflight only pending work on lane "${laneId}".`,
      "Do not change models or start a primary job using a secondary allowance. Best-effort delete this completed one-shot heartbeat.",
    ].join(" ");
    return { deferId: defer.id, defer, checkpoint, resumeAt: iso(resumeAtMs), canSchedule, reason, automationPrompt, quota };
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
      && preflightLane(this.decorate(quota, current.accountFingerprint, jobClass), jobClass, this.config, laneId).decision !== "defer";
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
    return this.decorate({ ...snapshot, nextRefreshAt: new Date(nextRefreshAtMs).toISOString(), stale,
      refreshInProgress: this.store.hasActiveLease(this.key, this.now()), backoffUntil: iso(backoffUntilMs), source: "cache" }, fingerprint);
  }
}

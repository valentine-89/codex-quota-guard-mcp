import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type {
  BackoffRecord,
  CachedQuotaRecord,
  CheckpointPayload,
  JobClass,
  QuotaSnapshot,
  QuotaLaneId,
  StoredCheckpoint,
  StoredDefer,
  StoredResetRecommendation,
} from "./types.js";
import { redactSensitiveText, sanitizeStringList } from "./security.js";
import type { PacingSample } from "./pacing.js";
import { MonitorState } from "./monitor-state.js";

function rowRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
function numeric(value: unknown): number {
  if (typeof value !== "number") throw new Error("Unexpected SQLite numeric value");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unexpected SQLite text value");
  return value;
}
function nullableText(value: unknown): string | null { return typeof value === "string" ? value : null }
interface ResumeState { shouldExit: boolean; automationIdsToCancel: string[]; checkpointId: string | null; deferIds: string[] }

export function stableHash(value: string): string { return createHash("sha256").update(value).digest("hex") }
export function profileKey(codexHome: string): string { return stableHash(resolve(codexHome).toLocaleLowerCase()) }
export function accountFingerprint(accountType: unknown, email: unknown): string | null {
  if (typeof accountType !== "string" || typeof email !== "string" || !email.trim()) return null;
  return stableHash(`${accountType}:${email.trim().toLocaleLowerCase()}`);
}

export class StateStore {
  private readonly database: DatabaseSync;
  readonly monitor: MonitorState;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = numeric(rowRecord(this.database.prepare("PRAGMA user_version").get())?.user_version);
    if (version > 5) {
      this.database.close();
      throw new Error(`State schema ${version} is newer than supported schema 5; upgrade quota guard.`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS quota_cache (
        profile_key TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL,
        next_refresh_at_ms INTEGER NOT NULL, account_fingerprint TEXT, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_leases (
        profile_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backoff_state (
        profile_key TEXT PRIMARY KEY, failure_count INTEGER NOT NULL, kind TEXT NOT NULL,
        until_ms INTEGER NOT NULL, error_code TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, profile_key TEXT NOT NULL, workspace_hash TEXT NOT NULL,
        workspace_root TEXT NOT NULL, task_id TEXT, payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, resume_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_lookup
        ON checkpoints(profile_key, workspace_hash, task_id, created_at_ms DESC);
      CREATE TABLE IF NOT EXISTS policy_overrides (
        profile_key TEXT NOT NULL, account_fingerprint TEXT NOT NULL, plan_type TEXT NOT NULL,
        delta_percent REAL NOT NULL, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(profile_key, account_fingerprint, plan_type)
      );
      CREATE TABLE IF NOT EXISTS quota_observations (
        profile_key TEXT NOT NULL, account_fingerprint TEXT NOT NULL, plan_type TEXT NOT NULL,
        limit_id TEXT NOT NULL, reset_at TEXT, used_percent INTEGER NOT NULL,
        pending_total INTEGER NOT NULL DEFAULT 0, pending_small INTEGER NOT NULL DEFAULT 0,
        pending_medium INTEGER NOT NULL DEFAULT 0, pending_long INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(profile_key, account_fingerprint, plan_type, limit_id)
      );
      CREATE TABLE IF NOT EXISTS job_admissions (
        profile_key TEXT NOT NULL, account_fingerprint TEXT NOT NULL, plan_type TEXT NOT NULL,
        limit_id TEXT NOT NULL, job_id TEXT NOT NULL, task_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL, job_class TEXT NOT NULL, admitted_at_ms INTEGER NOT NULL,
        PRIMARY KEY(profile_key, account_fingerprint, plan_type, limit_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS quota_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_key TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL, plan_type TEXT NOT NULL, limit_id TEXT NOT NULL,
        job_class TEXT, cost_percent REAL NOT NULL, observed_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quota_samples_lookup
        ON quota_samples(profile_key, account_fingerprint, plan_type, limit_id, job_class, id DESC);
      CREATE TABLE IF NOT EXISTS defer_records (
        id TEXT PRIMARY KEY, profile_key TEXT NOT NULL, workspace_hash TEXT NOT NULL,
        workspace_root TEXT NOT NULL, task_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
        automation_id TEXT, state TEXT NOT NULL, resume_at_ms INTEGER, lane_id TEXT NOT NULL DEFAULT 'primary',
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_defer_lookup
        ON defer_records(profile_key, workspace_hash, task_id, state, created_at_ms DESC);
      CREATE TABLE IF NOT EXISTS automatic_reset_recommendations (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, profile_key TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL, plan_type TEXT NOT NULL, limit_id TEXT NOT NULL,
        weekly_reset_at TEXT NOT NULL, initial_remaining_percent REAL NOT NULL,
        threshold_percent REAL NOT NULL, inventory_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        UNIQUE(profile_key, account_fingerprint, plan_type, limit_id, weekly_reset_at, inventory_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_automatic_reset_epoch
        ON automatic_reset_recommendations(profile_key, account_fingerprint, plan_type, limit_id, weekly_reset_at, created_at_ms DESC);
      CREATE TABLE IF NOT EXISTS quota_pacing (
        profile_key TEXT NOT NULL, lane_id TEXT NOT NULL, sample_json TEXT NOT NULL,
        PRIMARY KEY(profile_key, lane_id)
      );
      PRAGMA user_version=5;
    `);
    const deferColumns = this.database.prepare("PRAGMA table_info(defer_records)").all()
      .map((row) => nullableText(rowRecord(row)?.name));
    if (!deferColumns.includes("lane_id")) this.database.exec("ALTER TABLE defer_records ADD COLUMN lane_id TEXT NOT NULL DEFAULT 'primary'");
    MonitorState.migrate(this.database);
    this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.database.close();
      throw error;
    }
    this.monitor = new MonitorState(this.database);
  }

  getPacing(key: string, lane: QuotaLaneId): PacingSample | null {
    const row = rowRecord(this.database.prepare("SELECT sample_json FROM quota_pacing WHERE profile_key=? AND lane_id=?").get(key, lane));
    return row ? JSON.parse(text(row.sample_json)) as PacingSample : null;
  }

  savePacing(key: string, lane: QuotaLaneId, sample: PacingSample): void {
    this.database.prepare("INSERT OR REPLACE INTO quota_pacing VALUES (?,?,?)").run(key, lane, JSON.stringify(sample));
  }

  clearPacing(key: string): void {
    this.database.prepare("DELETE FROM quota_pacing WHERE profile_key=?").run(key);
  }

  close(): void { this.database.close() }

  private resetRecommendation(row: unknown): StoredResetRecommendation | null {
    const value = rowRecord(row);
    if (!value) return null;
    const state = text(value.state) as StoredResetRecommendation["state"];
    return {
      id: text(value.id), idempotencyKey: text(value.idempotency_key), profileKey: text(value.profile_key),
      accountFingerprint: text(value.account_fingerprint), planType: text(value.plan_type), limitId: text(value.limit_id),
      weeklyResetAt: text(value.weekly_reset_at), initialRemainingPercent: numeric(value.initial_remaining_percent),
      thresholdPercent: numeric(value.threshold_percent), inventoryFingerprint: text(value.inventory_fingerprint), state,
      createdAtMs: numeric(value.created_at_ms), updatedAtMs: numeric(value.updated_at_ms),
    };
  }

  getResetRecommendation(id: string, idempotencyKey: string): StoredResetRecommendation | null {
    return this.resetRecommendation(this.database.prepare(
      "SELECT * FROM automatic_reset_recommendations WHERE id=? AND idempotency_key=?",
    ).get(id, idempotencyKey));
  }

  listResetRecommendationsForEpoch(identity: { key: string; fingerprint: string; planType: string; limitId: string },
    weeklyResetAt: string): StoredResetRecommendation[] {
    return this.database.prepare(`SELECT * FROM automatic_reset_recommendations
      WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=? AND weekly_reset_at=?
      ORDER BY created_at_ms DESC`).all(identity.key, identity.fingerprint, identity.planType, identity.limitId, weeklyResetAt)
      .map(row => this.resetRecommendation(row)).filter((row): row is StoredResetRecommendation => row !== null);
  }

  getOrCreateResetRecommendation(identity: { key: string; fingerprint: string; planType: string; limitId: string },
    weeklyResetAt: string, remainingPercent: number, thresholdPercent: number, inventoryFingerprint: string,
    nowMs: number): StoredResetRecommendation {
    const existing = this.resetRecommendation(this.database.prepare(`SELECT * FROM automatic_reset_recommendations
      WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=? AND weekly_reset_at=?
        AND inventory_fingerprint=?`).get(identity.key, identity.fingerprint, identity.planType, identity.limitId,
      weeklyResetAt, inventoryFingerprint));
    if (existing) return existing;
    const id = randomUUID();
    const idempotencyKey = randomUUID();
    this.database.prepare(`INSERT INTO automatic_reset_recommendations
      (id,idempotency_key,profile_key,account_fingerprint,plan_type,limit_id,weekly_reset_at,
       initial_remaining_percent,threshold_percent,inventory_fingerprint,state,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?)`).run(id, idempotencyKey, identity.key, identity.fingerprint,
      identity.planType, identity.limitId, weeklyResetAt, remainingPercent, thresholdPercent,
      inventoryFingerprint, "recommended", nowMs, nowMs);
    return this.getResetRecommendation(id, idempotencyKey)!;
  }

  updateResetRecommendation(id: string, idempotencyKey: string, state: StoredResetRecommendation["state"],
    nowMs: number): StoredResetRecommendation | null {
    this.database.prepare(`UPDATE automatic_reset_recommendations SET state=?,updated_at_ms=?
      WHERE id=? AND idempotency_key=?`).run(state, nowMs, id, idempotencyKey);
    return this.getResetRecommendation(id, idempotencyKey);
  }

  invalidateResetRecommendationsForOtherAccounts(key: string, fingerprint: string): void {
    this.database.prepare("DELETE FROM automatic_reset_recommendations WHERE profile_key=? AND account_fingerprint<>?")
      .run(key, fingerprint);
  }

  clearResetRecommendations(key: string): void {
    this.database.prepare("DELETE FROM automatic_reset_recommendations WHERE profile_key=?").run(key);
  }

  getCache(key: string): CachedQuotaRecord | null {
    const row = rowRecord(this.database.prepare(
      "SELECT snapshot_json, fetched_at_ms, next_refresh_at_ms, account_fingerprint FROM quota_cache WHERE profile_key = ?",
    ).get(key));
    if (!row) return null;
    return {
      snapshot: JSON.parse(text(row.snapshot_json)) as QuotaSnapshot,
      fetchedAtMs: numeric(row.fetched_at_ms),
      nextRefreshAtMs: numeric(row.next_refresh_at_ms),
      accountFingerprint: nullableText(row.account_fingerprint),
    };
  }

  saveCache(key: string, snapshot: QuotaSnapshot, nextRefreshAtMs: number, fingerprint: string | null, nowMs: number): void {
    this.database.prepare(`
      INSERT INTO quota_cache(profile_key, snapshot_json, fetched_at_ms, next_refresh_at_ms, account_fingerprint, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_key) DO UPDATE SET snapshot_json=excluded.snapshot_json,
        fetched_at_ms=excluded.fetched_at_ms, next_refresh_at_ms=excluded.next_refresh_at_ms,
        account_fingerprint=excluded.account_fingerprint, updated_at_ms=excluded.updated_at_ms
    `).run(key, JSON.stringify(snapshot), nowMs, nextRefreshAtMs, fingerprint, nowMs);
    this.database.prepare("DELETE FROM backoff_state WHERE profile_key = ?").run(key);
  }

  updateCachedResetCredit(key: string, resetCredit: QuotaSnapshot["resetCredit"], nowMs: number): void {
    const cached = this.getCache(key);
    if (!cached) return;
    this.database.prepare("UPDATE quota_cache SET snapshot_json=?,updated_at_ms=? WHERE profile_key=?")
      .run(JSON.stringify({ ...cached.snapshot, resetCredit }), nowMs, key);
  }

  expireCache(key: string): void {
    this.database.prepare("UPDATE quota_cache SET next_refresh_at_ms = 0 WHERE profile_key = ?").run(key);
  }

  clearCache(key: string): void {
    this.database.prepare("DELETE FROM quota_cache WHERE profile_key = ?").run(key);
    this.database.prepare("DELETE FROM backoff_state WHERE profile_key = ?").run(key);
  }

  capCacheDeadline(key: string, deadlineMs: number): void {
    this.database.prepare("UPDATE quota_cache SET next_refresh_at_ms=MIN(next_refresh_at_ms,?) WHERE profile_key=?")
      .run(deadlineMs, key);
  }

  invalidateObservations(key: string): void {
    // Keep learned samples; only discard an interval whose continuity is unknown.
    this.database.prepare("DELETE FROM quota_observations WHERE profile_key=?").run(key);
  }

  tryAcquireLease(key: string, ownerId: string, nowMs: number, durationMs: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM refresh_leases WHERE profile_key = ? AND expires_at_ms <= ?").run(key, nowMs);
      const inserted = this.database.prepare("INSERT OR IGNORE INTO refresh_leases(profile_key, owner_id, expires_at_ms) VALUES (?, ?, ?)")
        .run(key, ownerId, nowMs + durationMs);
      this.database.exec("COMMIT");
      // Concurrent calls in the same MCP process share ownerId too. Only the
      // inserting call owns this refresh; re-entry must not start another RPC.
      return inserted.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  hasActiveLease(key: string, nowMs: number): boolean {
    const row = rowRecord(this.database.prepare("SELECT expires_at_ms FROM refresh_leases WHERE profile_key = ?").get(key));
    return row ? numeric(row.expires_at_ms) > nowMs : false;
  }
  releaseLease(key: string, ownerId: string): void {
    this.database.prepare("DELETE FROM refresh_leases WHERE profile_key = ? AND owner_id = ?").run(key, ownerId);
  }
  getBackoff(key: string): BackoffRecord | null {
    const row = rowRecord(this.database.prepare(
      "SELECT failure_count, kind, until_ms, error_code FROM backoff_state WHERE profile_key = ?",
    ).get(key));
    return row ? {
      failureCount: numeric(row.failure_count), kind: text(row.kind), untilMs: numeric(row.until_ms), errorCode: text(row.error_code),
    } : null;
  }
  recordFailure(key: string, kind: string, errorCode: string, nowMs: number, retryAfterMs: number | null, random: () => number): BackoffRecord {
    const previous = this.getBackoff(key);
    const failureCount = (previous?.kind === kind ? previous.failureCount : 0) + 1;
    const schedule = kind === "rate-limit"
      ? [60_000, 120_000, 300_000, 600_000, 900_000]
      : kind === "server" ? [60_000, 120_000, 300_000] : [30_000, 60_000, 120_000];
    const base = retryAfterMs ?? schedule[Math.min(failureCount - 1, schedule.length - 1)] ?? 60_000;
    const jittered = retryAfterMs === null ? Math.round(base * (0.8 + random() * 0.4)) : base;
    const result = { failureCount, kind, untilMs: nowMs + jittered, errorCode };
    this.database.prepare(`
      INSERT INTO backoff_state(profile_key, failure_count, kind, until_ms, error_code, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_key) DO UPDATE SET failure_count=excluded.failure_count, kind=excluded.kind,
        until_ms=excluded.until_ms, error_code=excluded.error_code, updated_at_ms=excluded.updated_at_ms
    `).run(key, failureCount, kind, result.untilMs, errorCode, nowMs);
    return result;
  }

  observeFreshQuota(identity: { key: string; fingerprint: string; planType: string; limitId: string }, usedPercent: number, resetAt: string | null, nowMs: number, sampleWindow: number): void {
    const args = [identity.key, identity.fingerprint, identity.planType, identity.limitId] as const;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = rowRecord(this.database.prepare(`
        SELECT reset_at, used_percent, pending_total, pending_small, pending_medium, pending_long
        FROM quota_observations WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=?
      `).get(...args));
      if (!row) {
        this.database.prepare(`
          INSERT INTO quota_observations(profile_key, account_fingerprint, plan_type, limit_id, reset_at, used_percent, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(...args, resetAt, usedPercent, nowMs);
      } else {
        const previousReset = nullableText(row.reset_at);
        const previousUsed = numeric(row.used_percent);
        const sameCycle = resetAt !== null && previousReset === resetAt;
        const pending = numeric(row.pending_total);
        const delta = usedPercent - previousUsed;
        if (!sameCycle || delta < 0) {
          this.database.prepare(`UPDATE quota_observations SET reset_at=?, used_percent=?, pending_total=0,
            pending_small=0, pending_medium=0, pending_long=0, updated_at_ms=?
            WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=?`)
            .run(resetAt, usedPercent, nowMs, ...args);
        } else if (delta > 0) {
          if (pending > 0) {
            const cost = delta / pending;
            this.insertSample(identity, null, cost, nowMs, sampleWindow);
            const counts: Array<[JobClass, number]> = [
              ["small", numeric(row.pending_small)], ["medium", numeric(row.pending_medium)], ["long", numeric(row.pending_long)],
            ];
            const active = counts.filter(([, count]) => count > 0);
            if (active.length === 1) this.insertSample(identity, active[0]?.[0] ?? null, cost, nowMs, sampleWindow);
          }
          this.database.prepare(`UPDATE quota_observations SET used_percent=?, pending_total=0,
            pending_small=0, pending_medium=0, pending_long=0, updated_at_ms=?
            WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=?`)
            .run(usedPercent, nowMs, ...args);
        } else {
          this.database.prepare(`UPDATE quota_observations SET updated_at_ms=?
            WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=?`).run(nowMs, ...args);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertSample(identity: { key: string; fingerprint: string; planType: string; limitId: string }, jobClass: JobClass | null, cost: number, nowMs: number, sampleWindow: number): void {
    this.database.prepare(`INSERT INTO quota_samples(profile_key, account_fingerprint, plan_type, limit_id, job_class, cost_percent, observed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(identity.key, identity.fingerprint, identity.planType, identity.limitId, jobClass, cost, nowMs);
    const condition = jobClass === null ? "job_class IS NULL" : "job_class = ?";
    const common = [identity.key, identity.fingerprint, identity.planType, identity.limitId];
    const params = jobClass === null ? common : [...common, jobClass];
    this.database.prepare(`DELETE FROM quota_samples WHERE id IN (
      SELECT id FROM quota_samples WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=? AND ${condition}
      ORDER BY id DESC LIMIT -1 OFFSET ?)`)
      .run(...params, sampleWindow);
  }

  recordAdmission(identity: { key: string; fingerprint: string; planType: string; limitId: string }, input: { jobId: string; taskId: string; workspaceRoot: string; jobClass: JobClass }, usedPercent: number, resetAt: string | null, nowMs: number, trackLearning = true): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (trackLearning) this.database.prepare(`INSERT OR IGNORE INTO quota_observations(profile_key, account_fingerprint, plan_type, limit_id, reset_at, used_percent, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(identity.key, identity.fingerprint, identity.planType, identity.limitId, resetAt, usedPercent, nowMs);
      const result = this.database.prepare(`INSERT OR IGNORE INTO job_admissions(
        profile_key, account_fingerprint, plan_type, limit_id, job_id, task_id, workspace_hash, job_class, admitted_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(identity.key, identity.fingerprint, identity.planType, identity.limitId, input.jobId, input.taskId,
          stableHash(resolve(input.workspaceRoot).toLocaleLowerCase()), input.jobClass, nowMs);
      if (result.changes > 0 && trackLearning) {
        const column = input.jobClass === "small" ? "pending_small" : input.jobClass === "medium" ? "pending_medium" : "pending_long";
        this.database.prepare(`UPDATE quota_observations SET pending_total=pending_total+1, ${column}=${column}+1, updated_at_ms=?
          WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=?`)
          .run(nowMs, identity.key, identity.fingerprint, identity.planType, identity.limitId);
      }
      this.database.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getLearning(identity: { key: string; fingerprint: string; planType: string; limitId: string }, jobClass: JobClass | null, sampleWindow: number, minSamples: number): { mean: number | null; count: number } {
    const read = (kind: JobClass | null): number[] => {
      const condition = kind === null ? "job_class IS NULL" : "job_class = ?";
      const params = [identity.key, identity.fingerprint, identity.planType, identity.limitId];
      if (kind !== null) params.push(kind);
      params.push(String(sampleWindow));
      const rows = this.database.prepare(`SELECT cost_percent FROM quota_samples
        WHERE profile_key=? AND account_fingerprint=? AND plan_type=? AND limit_id=? AND ${condition}
        ORDER BY id DESC LIMIT ?`).all(...params);
      return rows.map((row) => numeric(rowRecord(row)?.cost_percent));
    };
    let values = jobClass === null ? read(null) : read(jobClass);
    if (jobClass !== null && values.length < minSamples) values = read(null);
    return { mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, count: values.length };
  }

  getOverride(key: string, fingerprint: string, planType: string): number {
    const row = rowRecord(this.database.prepare(`SELECT delta_percent FROM policy_overrides
      WHERE profile_key=? AND account_fingerprint=? AND plan_type=?`).get(key, fingerprint, planType));
    return row ? numeric(row.delta_percent) : 0;
  }
  adjustOverride(key: string, fingerprint: string, planType: string, delta: number, nowMs: number): number {
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 49) throw new Error("deltaPercent must be non-zero within -49..49");
    this.database.prepare(`INSERT INTO policy_overrides(profile_key, account_fingerprint, plan_type, delta_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_key, account_fingerprint, plan_type)
      DO UPDATE SET delta_percent=MAX(-49, MIN(49, delta_percent+excluded.delta_percent)), updated_at_ms=excluded.updated_at_ms`)
      .run(key, fingerprint, planType, delta, nowMs);
    return this.getOverride(key, fingerprint, planType);
  }
  resetOverride(key: string, fingerprint: string, planType: string): void {
    this.database.prepare("DELETE FROM policy_overrides WHERE profile_key=? AND account_fingerprint=? AND plan_type=?")
      .run(key, fingerprint, planType);
  }

  createCheckpoint(key: string, payload: CheckpointPayload, resumeAtMs: number | null, nowMs: number): StoredCheckpoint {
    const sanitized: CheckpointPayload = {
      workspaceRoot: resolve(payload.workspaceRoot), objective: redactSensitiveText(payload.objective, 4_000),
      completed: sanitizeStringList(payload.completed), pending: sanitizeStringList(payload.pending),
      ...(payload.taskId ? { taskId: redactSensitiveText(payload.taskId, 256) } : {}),
      ...(payload.gitStatus ? { gitStatus: redactSensitiveText(payload.gitStatus, 8_000) } : {}),
      ...(payload.lastTest ? { lastTest: redactSensitiveText(payload.lastTest, 4_000) } : {}),
      ...(payload.pendingCommand ? { pendingCommand: redactSensitiveText(payload.pendingCommand, 2_000) } : {}),
      ...(payload.resumeNotes ? { resumeNotes: redactSensitiveText(payload.resumeNotes, 4_000) } : {}),
      ...(payload.laneId ? { laneId: payload.laneId } : {}),
      ...(payload.jobClass ? { jobClass: payload.jobClass } : {}),
    };
    const id = randomUUID();
    this.database.prepare(`INSERT INTO checkpoints(id, profile_key, workspace_hash, workspace_root, task_id, payload_json, created_at_ms, resume_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, key, stableHash(sanitized.workspaceRoot.toLocaleLowerCase()), sanitized.workspaceRoot,
        sanitized.taskId ?? null, JSON.stringify(sanitized), nowMs, resumeAtMs);
    return { ...sanitized, id, createdAt: new Date(nowMs).toISOString(), resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString() };
  }

  getCheckpoint(key: string, workspaceRoot: string, taskId?: string, checkpointId?: string): StoredCheckpoint | null {
    let row: Record<string, unknown> | null;
    if (checkpointId) {
      const taskClause = taskId ? " AND task_id=?" : "";
      row = rowRecord(this.database.prepare(`SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints WHERE profile_key=? AND id=? AND workspace_hash=?${taskClause}`)
        .get(key, checkpointId, stableHash(resolve(workspaceRoot).toLocaleLowerCase()), ...(taskId ? [taskId] : [])));
    } else if (taskId) {
      row = rowRecord(this.database.prepare(`SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints
        WHERE profile_key=? AND workspace_hash=? AND task_id=? ORDER BY created_at_ms DESC LIMIT 1`)
        .get(key, stableHash(resolve(workspaceRoot).toLocaleLowerCase()), taskId));
    } else {
      row = rowRecord(this.database.prepare(`SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints
        WHERE profile_key=? AND workspace_hash=? ORDER BY created_at_ms DESC LIMIT 1`)
        .get(key, stableHash(resolve(workspaceRoot).toLocaleLowerCase())));
    }
    if (!row) return null;
    const payload = JSON.parse(text(row.payload_json)) as CheckpointPayload;
    const resumeAtMs = typeof row.resume_at_ms === "number" ? row.resume_at_ms : null;
    return { ...payload, id: text(row.id), createdAt: new Date(numeric(row.created_at_ms)).toISOString(), resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString() };
  }

  createDefer(key: string, checkpoint: StoredCheckpoint, taskId: string, resumeAtMs: number | null, nowMs: number, laneId: QuotaLaneId = "primary"): StoredDefer {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO defer_records(id, profile_key, workspace_hash, workspace_root, task_id,
      checkpoint_id, state, resume_at_ms, lane_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, key, stableHash(resolve(checkpoint.workspaceRoot).toLocaleLowerCase()), resolve(checkpoint.workspaceRoot), taskId,
        checkpoint.id, resumeAtMs, laneId, nowMs, nowMs);
    return { id, checkpointId: checkpoint.id, workspaceRoot: resolve(checkpoint.workspaceRoot), taskId,
      automationId: null, state: "active", resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString(),
      createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString(), laneId };
  }

  attachAutomation(key: string, deferId: string, automationId: string, nowMs: number): StoredDefer | null {
    const result = this.database.prepare(`UPDATE defer_records SET automation_id=?, updated_at_ms=?
      WHERE id=? AND profile_key=? AND state='active' AND (automation_id IS NULL OR automation_id=?)
      AND NOT EXISTS (SELECT 1 FROM defer_records WHERE automation_id=? AND id<>?)`)
      .run(automationId, nowMs, deferId, key, automationId, automationId, deferId);
    return result.changes > 0 ? this.getDefer(key, deferId) : null;
  }

  getDefer(key: string, deferId: string): StoredDefer | null {
    const row = rowRecord(this.database.prepare(`SELECT id, checkpoint_id, workspace_root, task_id, automation_id,
      state, resume_at_ms, lane_id, created_at_ms, updated_at_ms FROM defer_records WHERE id=? AND profile_key=?`).get(deferId, key));
    if (!row) return null;
    const resume = typeof row.resume_at_ms === "number" ? row.resume_at_ms : null;
    return { id: text(row.id), checkpointId: text(row.checkpoint_id), workspaceRoot: text(row.workspace_root),
      taskId: text(row.task_id), automationId: nullableText(row.automation_id), state: text(row.state) as StoredDefer["state"],
      resumeAt: resume === null ? null : new Date(resume).toISOString(), createdAt: new Date(numeric(row.created_at_ms)).toISOString(),
      updatedAt: new Date(numeric(row.updated_at_ms)).toISOString(), laneId: (nullableText(row.lane_id) as QuotaLaneId | null) ?? "primary" };
  }

  prepareResume(key: string, workspaceRoot: string, taskId: string, deferId: string | undefined, trigger: "manual" | "automation", nowMs: number, laneId: QuotaLaneId = "primary"): ResumeState {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.prepareResumeLocked(key, workspaceRoot, taskId, deferId, trigger, nowMs, laneId);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private prepareResumeLocked(key: string, workspaceRoot: string, taskId: string, deferId: string | undefined, trigger: "manual" | "automation", nowMs: number, laneId: QuotaLaneId): ResumeState {
    const workspaceHash = stableHash(resolve(workspaceRoot).toLocaleLowerCase());
    if (trigger === "automation") {
      if (!deferId) return { shouldExit: true, automationIdsToCancel: [], checkpointId: null, deferIds: [] };
      const record = this.getDefer(key, deferId);
      if (!record || stableHash(record.workspaceRoot.toLocaleLowerCase()) !== workspaceHash
        || record.taskId !== taskId || record.state !== "active" || record.laneId !== laneId
        || ((record.resumeAt === null || Date.parse(record.resumeAt) > nowMs)
          && !this.monitor.permitsEarly(key, deferId, nowMs))) {
        return { shouldExit: true, automationIdsToCancel: [], checkpointId: null, deferIds: [] };
      }
      this.database.prepare("UPDATE defer_records SET state='fired', updated_at_ms=? WHERE id=? AND profile_key=? AND state='active'")
        .run(nowMs, deferId, key);
      return { shouldExit: false, automationIdsToCancel: [], checkpointId: record.checkpointId, deferIds: [record.id] };
    }
    const params: Array<string | number> = [key, workspaceHash, taskId, laneId];
    const idClause = deferId ? " AND id=?" : "";
    if (deferId) params.push(deferId);
    const rows = this.database.prepare(`SELECT id, checkpoint_id, automation_id FROM defer_records
      WHERE profile_key=? AND workspace_hash=? AND task_id=? AND lane_id=? AND state='active'${idClause}
      ORDER BY created_at_ms DESC, rowid DESC`).all(...params);
    const records = rows.map(rowRecord).filter((row): row is Record<string, unknown> => row !== null);
    this.database.prepare(`UPDATE defer_records SET state='superseded', updated_at_ms=?
      WHERE profile_key=? AND workspace_hash=? AND task_id=? AND lane_id=? AND state='active'${idClause}`).run(nowMs, ...params);
    return {
      shouldExit: false,
      automationIdsToCancel: records.map((row) => nullableText(row.automation_id)).filter((id): id is string => id !== null),
      checkpointId: records.length ? text(records[0]?.checkpoint_id) : null,
      deferIds: records.map((row) => text(row.id)),
    };
  }
}

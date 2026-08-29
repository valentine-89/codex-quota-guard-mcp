import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type {
  BackoffRecord,
  CachedQuotaRecord,
  CheckpointPayload,
  QuotaSnapshot,
  StoredCheckpoint,
} from "./types.js";
import { redactSensitiveText, sanitizeStringList } from "./security.js";

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

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function profileKey(codexHome: string): string {
  return stableHash(resolve(codexHome).toLocaleLowerCase());
}

export function accountFingerprint(accountType: unknown, email: unknown): string | null {
  if (typeof accountType !== "string") return null;
  return stableHash(`${accountType}:${typeof email === "string" ? email.toLocaleLowerCase() : ""}`);
}

export class StateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS quota_cache (
        profile_key TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        fetched_at_ms INTEGER NOT NULL,
        next_refresh_at_ms INTEGER NOT NULL,
        account_fingerprint TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_leases (
        profile_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backoff_state (
        profile_key TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL,
        kind TEXT NOT NULL,
        until_ms INTEGER NOT NULL,
        error_code TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        profile_key TEXT NOT NULL,
        workspace_hash TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        task_id TEXT,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        resume_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_lookup
        ON checkpoints(profile_key, workspace_hash, task_id, created_at_ms DESC);
    `);
  }

  close(): void {
    this.database.close();
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
      accountFingerprint: typeof row.account_fingerprint === "string" ? row.account_fingerprint : null,
    };
  }

  saveCache(key: string, snapshot: QuotaSnapshot, nextRefreshAtMs: number, fingerprint: string | null, nowMs: number): void {
    this.database.prepare(`
      INSERT INTO quota_cache(profile_key, snapshot_json, fetched_at_ms, next_refresh_at_ms, account_fingerprint, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_key) DO UPDATE SET
        snapshot_json=excluded.snapshot_json,
        fetched_at_ms=excluded.fetched_at_ms,
        next_refresh_at_ms=excluded.next_refresh_at_ms,
        account_fingerprint=excluded.account_fingerprint,
        updated_at_ms=excluded.updated_at_ms
    `).run(key, JSON.stringify(snapshot), nowMs, nextRefreshAtMs, fingerprint, nowMs);
    this.database.prepare("DELETE FROM backoff_state WHERE profile_key = ?").run(key);
  }

  tryAcquireLease(key: string, ownerId: string, nowMs: number, durationMs: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM refresh_leases WHERE profile_key = ? AND expires_at_ms <= ?").run(key, nowMs);
      this.database.prepare(
        "INSERT OR IGNORE INTO refresh_leases(profile_key, owner_id, expires_at_ms) VALUES (?, ?, ?)",
      ).run(key, ownerId, nowMs + durationMs);
      const row = rowRecord(this.database.prepare("SELECT owner_id FROM refresh_leases WHERE profile_key = ?").get(key));
      this.database.exec("COMMIT");
      return row?.owner_id === ownerId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseLease(key: string, ownerId: string): void {
    this.database.prepare("DELETE FROM refresh_leases WHERE profile_key = ? AND owner_id = ?").run(key, ownerId);
  }

  hasActiveLease(key: string, nowMs: number): boolean {
    const row = rowRecord(this.database.prepare(
      "SELECT 1 AS active FROM refresh_leases WHERE profile_key = ? AND expires_at_ms > ?",
    ).get(key, nowMs));
    return row !== null;
  }

  getBackoff(key: string): BackoffRecord | null {
    const row = rowRecord(this.database.prepare(
      "SELECT failure_count, kind, until_ms, error_code FROM backoff_state WHERE profile_key = ?",
    ).get(key));
    if (!row) return null;
    return {
      failureCount: numeric(row.failure_count),
      kind: text(row.kind),
      untilMs: numeric(row.until_ms),
      errorCode: text(row.error_code),
    };
  }

  recordFailure(
    key: string,
    kind: "rate-limit" | "server" | "other",
    errorCode: string,
    nowMs: number,
    retryAfterMs: number | null,
    random: () => number,
  ): BackoffRecord {
    const previous = this.getBackoff(key);
    const failureCount = (previous?.kind === kind ? previous.failureCount : 0) + 1;
    const schedule = kind === "rate-limit"
      ? [60_000, 120_000, 300_000, 600_000, 900_000]
      : kind === "server"
        ? [60_000, 120_000, 300_000]
        : [30_000, 60_000, 120_000];
    const base = retryAfterMs ?? schedule[Math.min(failureCount - 1, schedule.length - 1)] ?? schedule[schedule.length - 1] ?? 60_000;
    const jittered = retryAfterMs === null ? Math.round(base * (0.8 + random() * 0.4)) : base;
    const result = { failureCount, kind, untilMs: nowMs + jittered, errorCode };
    this.database.prepare(`
      INSERT INTO backoff_state(profile_key, failure_count, kind, until_ms, error_code, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_key) DO UPDATE SET
        failure_count=excluded.failure_count,
        kind=excluded.kind,
        until_ms=excluded.until_ms,
        error_code=excluded.error_code,
        updated_at_ms=excluded.updated_at_ms
    `).run(key, failureCount, kind, result.untilMs, errorCode, nowMs);
    return result;
  }

  createCheckpoint(key: string, payload: CheckpointPayload, resumeAtMs: number | null, nowMs: number): StoredCheckpoint {
    const sanitized: CheckpointPayload = {
      workspaceRoot: resolve(payload.workspaceRoot),
      objective: redactSensitiveText(payload.objective, 4_000),
      completed: sanitizeStringList(payload.completed),
      pending: sanitizeStringList(payload.pending),
      ...(payload.taskId ? { taskId: redactSensitiveText(payload.taskId, 256) } : {}),
      ...(payload.gitStatus ? { gitStatus: redactSensitiveText(payload.gitStatus, 8_000) } : {}),
      ...(payload.lastTest ? { lastTest: redactSensitiveText(payload.lastTest, 4_000) } : {}),
      ...(payload.pendingCommand ? { pendingCommand: redactSensitiveText(payload.pendingCommand, 2_000) } : {}),
      ...(payload.resumeNotes ? { resumeNotes: redactSensitiveText(payload.resumeNotes, 4_000) } : {}),
    };
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO checkpoints(id, profile_key, workspace_hash, workspace_root, task_id, payload_json, created_at_ms, resume_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key,
      stableHash(sanitized.workspaceRoot.toLocaleLowerCase()),
      sanitized.workspaceRoot,
      sanitized.taskId ?? null,
      JSON.stringify(sanitized),
      nowMs,
      resumeAtMs,
    );
    return {
      ...sanitized,
      id,
      createdAt: new Date(nowMs).toISOString(),
      resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString(),
    };
  }

  getCheckpoint(key: string, workspaceRoot: string, taskId?: string, checkpointId?: string): StoredCheckpoint | null {
    let row: Record<string, unknown> | null;
    if (checkpointId) {
      row = rowRecord(this.database.prepare(
        "SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints WHERE profile_key = ? AND id = ?",
      ).get(key, checkpointId));
    } else if (taskId) {
      row = rowRecord(this.database.prepare(`
        SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints
        WHERE profile_key = ? AND workspace_hash = ? AND task_id = ?
        ORDER BY created_at_ms DESC LIMIT 1
      `).get(key, stableHash(resolve(workspaceRoot).toLocaleLowerCase()), taskId));
    } else {
      row = rowRecord(this.database.prepare(`
        SELECT id, payload_json, created_at_ms, resume_at_ms FROM checkpoints
        WHERE profile_key = ? AND workspace_hash = ?
        ORDER BY created_at_ms DESC LIMIT 1
      `).get(key, stableHash(resolve(workspaceRoot).toLocaleLowerCase())));
    }
    if (!row) return null;
    const payload = JSON.parse(text(row.payload_json)) as CheckpointPayload;
    const resumeAtMs = typeof row.resume_at_ms === "number" ? row.resume_at_ms : null;
    return {
      ...payload,
      id: text(row.id),
      createdAt: new Date(numeric(row.created_at_ms)).toISOString(),
      resumeAt: resumeAtMs === null ? null : new Date(resumeAtMs).toISOString(),
    };
  }
}

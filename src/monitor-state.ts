import type { DatabaseSync } from "node:sqlite";

export const MONITOR_INTERVAL_MS = 300_000;
export const MONITOR_LEASE_MS = 60_000;

export interface MonitorTicket { owner: string; generation: number }
export interface RecoveryIdentity { fingerprint: string | null; planType: string | null; limitId: string | null }
export interface RecoveryRecord extends RecoveryIdentity {
  deferId: string;
  stage: "waiting" | "dispatching" | "scheduled" | "cancelled" | "uncertain";
  earlyAtMs: number | null;
  expectedAutomation: string | null;
  originalAutomation: string | null;
}

/** All mutations use the guard's database, so manual supersession and claims serialize. */
export class MonitorState {
  constructor(private readonly db: DatabaseSync) {}

  static migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        profile_key TEXT PRIMARY KEY, owner TEXT, generation INTEGER NOT NULL DEFAULT 0,
        lease_until_ms INTEGER NOT NULL DEFAULT 0, next_poll_ms INTEGER NOT NULL DEFAULT 0,
        last_poll_ms INTEGER, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS defer_recovery (
        defer_id TEXT PRIMARY KEY REFERENCES defer_records(id), profile_key TEXT NOT NULL,
        fingerprint TEXT, plan_type TEXT, limit_id TEXT,
        stage TEXT NOT NULL DEFAULT 'waiting', early_at_ms INTEGER,
        expected_automation TEXT, original_automation TEXT, updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_profile ON defer_recovery(profile_key, stage);
    `);
  }

  bindDefinition(key: string, deferId: string, serialized: string): void {
    this.db.prepare(`UPDATE defer_recovery SET original_automation=? WHERE profile_key=? AND defer_id=?
      AND stage='waiting' AND original_automation IS NULL`).run(serialized, key, deferId);
  }

  enroll(key: string, deferId: string, identity: RecoveryIdentity, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO defer_recovery
      (defer_id,profile_key,fingerprint,plan_type,limit_id,updated_at_ms) VALUES(?,?,?,?,?,?)`)
      .run(deferId, key, identity.fingerprint, identity.planType, identity.limitId, now);
  }

  status(key: string): { nextPollAt: number; lastPollAt: number | null; lastError: string | null } | null {
    const row = this.db.prepare("SELECT * FROM monitor_state WHERE profile_key=?").get(key);
    return row ? { nextPollAt: row.next_poll_ms as number, lastPollAt: row.last_poll_ms as number | null,
      lastError: row.last_error as string | null } : null;
  }

  list(key: string): RecoveryRecord[] {
    return this.db.prepare(`SELECT r.* FROM defer_recovery r JOIN defer_records d ON d.id=r.defer_id
      WHERE r.profile_key=? AND d.automation_id IS NOT NULL
      AND (d.state='active' OR r.stage IN ('dispatching','scheduled','uncertain'))
      AND r.stage!='cancelled' ORDER BY r.updated_at_ms,r.defer_id`).all(key).map(row => ({
      deferId: row.defer_id as string, fingerprint: row.fingerprint as string,
      planType: row.plan_type as string, limitId: row.limit_id as string,
      stage: row.stage as RecoveryRecord["stage"], earlyAtMs: row.early_at_ms as number | null,
      expectedAutomation: row.expected_automation as string | null,
      originalAutomation: row.original_automation as string | null,
    }));
  }

  claim(key: string, owner: string, now: number, interval = MONITOR_INTERVAL_MS): MonitorTicket | null {
    // Reserving next_poll before I/O preserves cadence even if the winner crashes.
    this.db.prepare("INSERT OR IGNORE INTO monitor_state(profile_key) VALUES(?)").run(key);
    const row = this.db.prepare(`UPDATE monitor_state SET owner=?, generation=generation+1,
      lease_until_ms=?,next_poll_ms=?,last_poll_ms=? WHERE profile_key=? AND lease_until_ms<=?
      AND next_poll_ms<=? RETURNING generation`).get(owner, now + MONITOR_LEASE_MS,
      now + interval, now, key, now, now);
    return row ? { owner, generation: row.generation as number } : null;
  }

  owns(key: string, ticket: MonitorTicket, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM monitor_state WHERE profile_key=? AND owner=?
      AND generation=? AND lease_until_ms>?`).get(key, ticket.owner, ticket.generation, now);
  }

  renew(key: string, ticket: MonitorTicket, now: number): boolean {
    return this.db.prepare(`UPDATE monitor_state SET lease_until_ms=? WHERE profile_key=?
      AND owner=? AND generation=? AND lease_until_ms>?`).run(now + MONITOR_LEASE_MS,
      key, ticket.owner, ticket.generation, now).changes > 0;
  }

  finish(key: string, ticket: MonitorTicket, nextPollAt: number, error: string | null): void {
    this.db.prepare(`UPDATE monitor_state SET owner=NULL,lease_until_ms=0,
      next_poll_ms=MAX(next_poll_ms,?),last_error=? WHERE profile_key=? AND owner=? AND generation=?`)
      .run(nextPollAt, error, key, ticket.owner, ticket.generation);
  }

  /** Fenced SQL claim immediately before external I/O; never replay an uncertain update. */
  dispatch(key: string, ticket: MonitorTicket, deferId: string, expected: string, now: number): boolean {
    return this.db.prepare(`UPDATE defer_recovery SET stage='dispatching',early_at_ms=?,
      expected_automation=?,updated_at_ms=? WHERE defer_id=? AND profile_key=? AND stage='waiting'
      AND EXISTS(SELECT 1 FROM defer_records d WHERE d.id=defer_id AND d.state='active')
      AND EXISTS(SELECT 1 FROM monitor_state m WHERE m.profile_key=? AND m.owner=?
        AND m.generation=? AND m.lease_until_ms>?)`)
      .run(now, expected, now, deferId, key, key, ticket.owner, ticket.generation, now).changes > 0;
  }

  mark(key: string, deferId: string, stage: RecoveryRecord["stage"], now: number): void {
    this.db.prepare(`UPDATE defer_recovery SET stage=?,updated_at_ms=? WHERE profile_key=?
      AND defer_id=? AND stage IN ('dispatching','scheduled','uncertain')`).run(stage, now, key, deferId);
  }

  permitsEarly(key: string, deferId: string, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM defer_recovery WHERE profile_key=? AND defer_id=?
      AND stage IN ('dispatching','scheduled','uncertain') AND early_at_ms<=?`).get(key, deferId, now);
  }
}

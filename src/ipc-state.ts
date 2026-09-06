import type { DatabaseSync } from "node:sqlite";

export type WakeState = "scheduled" | "waiting" | "uncertain" | "cancelled" | "completed";
export interface IpcWake { deferId: string; due: number; nextCheck: number; state: WakeState; attempt: string | null; turnId: string | null; reason: string | null }
export class IpcState {
  constructor(private readonly db: DatabaseSync) {}
  static migrate(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS ipc_wakes (
      defer_id TEXT PRIMARY KEY REFERENCES defer_records(id), profile_key TEXT NOT NULL,
      due_ms INTEGER NOT NULL, next_check_ms INTEGER NOT NULL, state TEXT NOT NULL,
      attempt TEXT, turn_id TEXT, reason TEXT, dispatched_at_ms INTEGER
    ); CREATE INDEX IF NOT EXISTS ipc_wakes_profile ON ipc_wakes(profile_key,state);`);
  }
  create(key: string, deferId: string, due: number, now: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
    this.db.prepare(`UPDATE defer_records SET state='superseded',updated_at_ms=? WHERE profile_key=? AND id!=? AND state='active'
      AND id IN (SELECT defer_id FROM ipc_wakes WHERE profile_key=?)
      AND (task_id,workspace_hash,lane_id)=(SELECT task_id,workspace_hash,lane_id FROM defer_records WHERE id=? AND profile_key=?)`)
      .run(now, key, deferId, key, deferId, key);
    this.db.prepare(`INSERT OR IGNORE INTO ipc_wakes(defer_id,profile_key,due_ms,next_check_ms,state)
      SELECT id,profile_key,?,?,'scheduled' FROM defer_records WHERE id=? AND profile_key=? AND state='active' AND automation_id IS NULL`)
      .run(due, Math.min(due, now + 300_000), deferId, key);
    this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  list(key: string): IpcWake[] {
    this.reconcile(key);
    return this.db.prepare("SELECT * FROM ipc_wakes WHERE profile_key=? ORDER BY due_ms,defer_id").all(key).map(r => ({
      deferId: r.defer_id as string, due: r.due_ms as number, nextCheck: r.next_check_ms as number,
      state: r.state as WakeState, attempt: r.attempt as string | null, turnId: r.turn_id as string | null, reason: r.reason as string | null,
    }));
  }
  has(key: string, id: string): boolean { return !!this.db.prepare("SELECT 1 FROM ipc_wakes WHERE profile_key=? AND defer_id=?").get(key, id); }
  reconcile(key: string): void {
    this.db.prepare(`UPDATE ipc_wakes SET state=CASE WHEN (SELECT state FROM defer_records WHERE id=defer_id)='fired' THEN 'completed' ELSE 'cancelled' END
      WHERE profile_key=? AND state NOT IN ('completed','cancelled') AND EXISTS(SELECT 1 FROM defer_records WHERE id=defer_id AND state!='active')`).run(key);
  }
  postpone(key: string, id: string, next: number, reason: string): void {
    this.db.prepare("UPDATE ipc_wakes SET state='waiting',next_check_ms=?,reason=? WHERE profile_key=? AND defer_id=? AND attempt IS NULL AND state IN ('scheduled','waiting')")
      .run(next, reason, key, id);
  }
  claim(key: string, id: string, attempt: string, now: number): boolean {
    // Uncertain is persisted BEFORE I/O, including a crash between SQL and socket.write.
    return this.db.prepare(`UPDATE ipc_wakes SET state='uncertain',attempt=?,dispatched_at_ms=?,reason='IPC_ACK_UNCONFIRMED'
      WHERE profile_key=? AND defer_id=? AND attempt IS NULL AND state IN ('scheduled','waiting')
      AND EXISTS(SELECT 1 FROM defer_records WHERE id=defer_id AND state='active' AND automation_id IS NULL)`)
      .run(attempt, now, key, id).changes > 0;
  }
  confirm(key: string, id: string, attempt: string, turnId: string): void {
    this.db.prepare("UPDATE ipc_wakes SET turn_id=?,reason=NULL,state=CASE WHEN state='uncertain' THEN 'scheduled' ELSE state END WHERE profile_key=? AND defer_id=? AND attempt=?")
      .run(turnId, key, id, attempt);
  }
  permitsEarly(key: string, id: string, now: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM ipc_wakes WHERE profile_key=? AND defer_id=? AND attempt IS NOT NULL AND dispatched_at_ms<=? AND state IN ('uncertain','scheduled')").get(key, id, now);
  }
}

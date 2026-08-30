import { DatabaseSync } from "node:sqlite";

/** Dedicated lock database, never the quota database. OS releases the lock on crash. */
export function acquireCoreLock(path: string): () => void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new Error("SHARED_CORE_ALREADY_RUNNING: connect to the existing core; do not kill its process");
  }
  let released = false;
  return () => { if (!released) { released = true; database.exec("ROLLBACK"); database.close(); } };
}

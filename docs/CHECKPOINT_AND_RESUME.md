# Checkpoint and resume

Checkpoints are local SQLite records keyed by Codex profile, canonical workspace hash, optional task ID, and checkpoint UUID. They contain only the explicit objective, completed/pending lists, bounded Git/test/command state, and resume notes.

## Safe defer flow

1. Call `job_preflight` before a costly boundary.
2. If it returns `defer`, call `defer_until_reset` with current task state.
3. The tool stores the checkpoint and computes `resumeAt = fiveHour.resetsAt + resetGraceMs`.
4. Use Codex's heartbeat automation tool with the returned time and prompt, targeting the same task.
5. On wake, call `quota_status` first. If quota is unavailable or still exhausted, defer again.
6. Call `checkpoint_get`, inspect current repository state, and continue only pending work.

When the backend supplies no reset timestamp, `canSchedule` is false and `resumeAt` is null. The tool does not invent a reset time.

Checkpoint text is redacted for common key, bearer, token, and JWT patterns, but callers must still avoid supplying secrets or full model transcripts.

# Checkpoint and resume

Checkpoints are local SQLite records keyed by Codex profile, canonical workspace hash, optional task ID, and checkpoint UUID. They contain only the explicit objective, completed/pending lists, bounded Git/test/command state, and resume notes.

## Safe defer flow

1. Split work into bounded phases and call `job_preflight` before each one, including code editing/research. Save a checkpoint on `caution`; do not wait until 0%.
2. If it returns `defer`, immediately call `defer_until_reset` with current state, actual task ID, and the same `laneId`/`jobClass`. Do not spend the remaining safety margin on more investigation first.
3. The tool always stores a checkpoint and quota-owned defer record. `resumeAt` is the latest reset among all blocking constraints for the selected quota role plus grace. Pass `laneId="primary"` for main work or `laneId="secondary"` for an explicitly available reserve lane.
4. Create a same-task heartbeat only when `canSchedule=true` (reset no more than 24 hours away), then call `defer_automation_attach` with the returned `deferId` and created automation ID.
5. On automation wake, call `resume_prepare(trigger="automation")` with workspace, task, role and defer ID first. Exit immediately when `shouldExit=true`; otherwise require `canResume=true` for the selected role. A due wake claims the defer once. If still blocked, defer again on that role; best-effort delete the completed heartbeat.
6. On a user-requested manual resume, call `resume_prepare(trigger="manual")` before checking quota. Best-effort delete only the returned `automationIdsToCancel`; the defer is already superseded so a surviving heartbeat cannot resume work.
7. Call `checkpoint_get`, inspect current repository state, and preflight only pending work. Admission is not a reservation of tokens or a guarantee a command can finish.

Manual resume is role-scoped: superseding a secondary defer does not cancel a primary defer (and vice versa). A secondary heartbeat can therefore wake lightweight work while the primary task remains deferred.

When the backend supplies no reset timestamp, `canSchedule` is false and `resumeAt` is null. A reset farther than 24 hours remains visible on the checkpoint, but `canSchedule` is false. The tool does not invent a reset time.

Checkpoint text is redacted for common key, bearer, token, and JWT patterns, but callers must still avoid supplying secrets or full model transcripts.

Creation and attachment are separate host operations. Confirm both succeeded; an active defer with no automation ID means scheduling is not confirmed. If attachment fails after creation, best-effort delete only that newly created heartbeat. If the host has no scheduler tool, report the saved checkpoint and manual resume time. The MCP cannot create a heartbeat after the current agent turn is cut off by an upstream usage limit.

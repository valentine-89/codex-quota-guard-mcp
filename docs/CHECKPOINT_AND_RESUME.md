# Checkpoint and resume

Checkpoints are local SQLite records keyed by Codex profile, canonical workspace hash, optional task ID, and checkpoint UUID. They contain only the explicit objective, completed/pending lists, bounded Git/test/command state, and resume notes.

## Safe defer flow

1. Call `job_preflight` before substantial work and reuse admission until its deadline. Follow `checkpointRequired` and `requiredAction`; `caution` alone need not require a checkpoint. Jobs may span periodic checks.
2. If it returns `defer`, immediately call `defer_until_reset` with current state, actual task ID, and the same `laneId`/`jobClass`. Do not spend the remaining safety margin on more investigation first.
3. The tool always stores a checkpoint and quota-owned defer record. `resumeAt` is the latest reset among all blocking constraints for the selected quota role plus grace. Pass `laneId="primary"` for main work or `laneId="secondary"` for an explicitly available reserve lane.
4. Follow `scheduling.mechanism`. For Desktop, only when `canSchedule=true` and `automationRequest` is present, pass that request unchanged to the host `automation_update`, then attach its returned automation ID using `defer_automation_attach`. For IPC, `scheduling.state="scheduled"` confirms the saved wake; do not create or attach a heartbeat. `canSchedule` validates timing, not delivery. A weekly-only `weekly_advisory` caution requires neither defer nor automation.
5. On a Guard automation wake, call `resume_prepare(trigger="automation")` with workspace, task, role and defer ID first. Follow `action`: `exit` ends this wake, `wait` requires quota recovery, and `continue` permits preflight. A due wake claims the defer once. If still blocked, defer again on that role. Cancel only returned owned automation IDs, best effort. Ordinary scheduled work without a defer ID revalidates quota without claiming or cancelling Guard wakes.
6. On a user-requested manual resume, call `resume_prepare(trigger="manual")` before checking quota. Best-effort delete only the returned `automationIdsToCancel`; the defer is already superseded so a surviving heartbeat cannot resume work.
7. Call `checkpoint_get`, inspect current repository state, and preflight only pending work. Admission is not a reservation of tokens or a guarantee a command can finish.

Manual resume is role-scoped: superseding a secondary defer does not cancel a primary defer (and vice versa). A secondary heartbeat can therefore wake lightweight work while the primary task remains deferred.

With the [managed monitor](MONITOR.md), verified external recovery (including another signed-in account with sufficient quota) can advance an attached heartbeat. Its claimed early wake is allowed before `resumeAt`, but still revalidates the current account's own policy. Attachment captures the original automation definition; later user edits are not adopted by retrying attach. Missing scheduler capability or an unverifiable definition leaves the original schedule intact. Superseded/fired accelerated heartbeats are also cleaned on local timer ticks without quota reads.

When the backend supplies no reset timestamp, `canSchedule` is false and `resumeAt` is null. A weekly-only reset at least24 hours away is warning-only: continue without a Guard stop, checkpoint requirement or automation. Other blocked constraints beyond the ceiling retain the checkpoint but cannot schedule. The tool does not invent a reset time.

Checkpoint text is redacted for common key, bearer, token, and JWT patterns, but callers must still avoid supplying secrets or full model transcripts.

Creation and attachment remain separate host operations. `automationRequest` exists only when scheduling is safe and is designed for direct passthrough, not model-authored scheduler input. Confirm both operations succeeded; an active defer with no automation ID means scheduling is not confirmed. If attachment fails after creation, best-effort delete only that newly created heartbeat. If the host has no scheduler tool, report the saved checkpoint and manual resume time. The MCP cannot create a heartbeat after the current agent turn is cut off by an upstream usage limit.

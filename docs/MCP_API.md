# MCP API 3.0.0

Applies to version 3.0.0. Resume callers must use `action`; the removed fields have no compatibility aliases.

`quota_status` and `job_preflight` default to `detail="summary"`, normally around 1 KB of JSON. `detail="full"` returns the original data; `detail="compact"` keeps deduplicated quota data (including nested preflight quota). Selecting detail never forces a refresh. Responses omit the redundant `format` marker; no compatibility marker or fallback is provided.

Summary keeps decisions, permissions, deadlines, remaining percentages, resets, lane availability and exceptional limits. Normal `allow` prose, null diagnostics and learning statistics are omitted. Missing error/backoff/reset recommendation means none; `fiveHour=null` means no five-hour window. Active quota is at the root; other available lanes carry their own limits. Status `pacing` holds active confidence and maximum segment minutes; preflight has these action limits at the top level. Minute limits are rounded down. Reset proofs, warnings, errors and required actions are never truncated, so exceptional responses may exceed 1 KB. Text and structured output contain the same summary; an MCP envelope may include both copies.

Compact output keeps active windows, policy and safety fields at the root. `limits` holds active credits and individual limits. A lane with `quotaRef="root"` uses that data; a missing lane profile inherits root `profile`. Distinct lane buckets and profiles remain inline. `longWindows` contains only windows beyond `weekly`; extra buckets are in `otherBuckets`. Unavailable lanes retain `available=false` and their reason, without redundant pacing. Reset recommendations, keys, follow-ups, errors and deadlines are unchanged. Other tools retain their existing data layout.

Quota Guard exposes eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

Call `job_preflight` before substantial work with `agentProtocol="auto-reset-v1"`, actual task ID, absolute workspace root and stable `jobId`. Reuse valid admission for small steps. Use `quota_status` for status-only work; do not pair it with preflight unnecessarily.

During active work, follow `checkAgainBy`, `canStartSegment`, `validUntil`, `maxSegmentMinutes`, `checkpointRequired` and the returned reason/action. Actual quota deferral, expired admission and imminent reserve forecasts require different responses. Job estimates may span routine checks in every quota mode: the segment budget bounds unchecked work, not total duration. Only imminent reserve forecasts require shorter estimated segments. Atomic operations must fit admission. The MCP cannot interrupt a running model generation.

`resume_prepare` returns `action="continue"|"wait"|"exit"` without the removed `canResume`, `shouldExit` or `cancellationBestEffort` fields. `continue` permits preflight, `wait` requires quota recovery, and `exit` rejects an invalid, early or consumed Guard wake. Ordinary scheduled work without a defer ID revalidates quota without claiming or cancelling Guard wakes. Cancel only nonempty returned `automationIdsToCancel`, best effort. Empty metadata is omitted; quota is summarized.

If Guard is unavailable, disclose that quota is unverified and continue; repair when in scope and resume checks after recovery. Do not invent an admission or bypass credential boundaries.

Pacing starts conservatively, then learns from fresh backend samples. It resets after an account, plan, quota bucket, reset window, or quota increase changes; errors and long breaks also reset it. Cache hits do not create samples. Summary `quota_status.pacing` contains the active lane confidence and segment budget; `checkAgainBy` is its deadline. Full and compact detail include per-lane estimates.

Quota checks use shared cache, single-flight refresh, lease, and backoff. There is no public force-refresh input and no idle polling. Estimates are advisory and cannot guarantee that a long model generation will finish before quota exhaustion.

Automatic banked-reset use is opt-in. When enabled, Guard emits a recommendation only for a valid reset, an eligible plan, low weekly quota, and a reset more than 72 hours away. The host performs the reset; Guard never buys credits or reads auth files.

See [Getting started](GETTING_STARTED.md) and [README](../README.md).

## IPC scheduling (2.3.0, additive)

The eight tool names and inputs remain unchanged. `defer_until_reset.scheduling` reports `mechanism` (`desktop`, `ipc`, `unavailable`), `state` (`scheduled`, `waiting`, `uncertain`, `cancelled`, `completed`), and `reason`. IPC `scheduled` confirms a saved internal wake; `automationRequest` is null and no `defer_automation_attach` call is needed. Desktop still returns the unchanged heartbeat request for host creation and attachment. `canSchedule` validates timing only.

`quota_status.monitor.scheduling` contains task-scoped mechanism readiness and IPC records, including dispatch attempt and acknowledged turn ID. `scheduled` with a turn ID means delivery was acknowledged; only `resume_prepare` consuming the defer makes it `completed`. An `uncertain` dispatch is not retried automatically. Compact and summary outputs retain scheduler readiness. Existing direct clients without inherited context retain the Desktop contract; IPC requires a live connector and verified task identity.

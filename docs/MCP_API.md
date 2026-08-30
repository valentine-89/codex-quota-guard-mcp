# MCP API reference

Server: `codex-quota-guard-mcp`, version `0.5.1`, direct stdio or [managed shared Streamable HTTP](MANAGED_CORE.md). The public contract contains eight tools; `quota_status` additionally returns [monitor diagnostics](MONITOR.md), including `runtimeMode` and `requiresLiveClientConnection`. Successful results contain identical JSON in `structuredContent` and text content. Tool errors set `isError=true` with a bounded `{error:{code,message}}` payload; quota-read failures normally return a stale/unavailable snapshot with `error` populated. No tool accepts force refresh, credentials or a model name.

Timestamps are ISO 8601 UTC strings; missing timestamps are `null`. Percent values are percentage points, not token counts. Paths must be absolute on the MCP host. Use the actual Codex task identifier consistently, not a descriptive label. `laneId` defaults to `primary`; `secondary` is only for small work; `unknown` fails safe.

## `quota_status`

Input: `{}`. Returns a snapshot; reads may update shared cache, samples and backoff.

| Field | Meaning |
| --- | --- |
| `planType`, `profile` | Runtime account plan and active-bucket admission profile |
| `activeBucket`, `buckets` | Default decision bucket and all reported buckets; other entries are not interchangeable |
| `fiveHour`, `weekly`, `longWindows` | Active-bucket views; five-hour is exactly 300 minutes; long windows preserve arbitrary durations |
| `lanes.primary`, `lanes.secondary` | Per-role bucket, selected window, profile, quota path, recommendation, credit warning and detection |
| `quotaPath`, `mayConsumeCredits` | Allowance path: `included`, `credits`, warning-only `weekly_advisory`, or `unavailable` |
| `recommendation` | `continue`, `caution` or `checkpoint_and_defer`; inspect the selected lane for role-specific work |
| `source`, `fetchedAt`, `nextRefreshAt` | Origin, observation time, next permitted caller-driven refresh |
| `stale`, `refreshInProgress`, `backoffUntil`, `error` | Freshness and shared failure/lease state; stale or in-progress data never admits work |

Each lane has `available` (bucket detected, **not** spendable), `detection` (`active_default`, `explicit_backend_bucket`, `unavailable`), `bucket`, `window`, `quotaPath`, `mayConsumeCredits`, `profile`, `recommendation` and optional explanation in `reason`. A missing role may be absent on an unavailable snapshot or have `available=false`/`bucket=null`.

Each bucket preserves `limitId`, `limitName`, `planType`, normalized windows, `credits` (`hasCredits`, `unlimited`, `balance`), `individualLimit`, `spendControlReached` and `rateLimitReachedType`. Missing credit capability is not permission. Credit bypass requires a true credit/unlimited flag, no exhausted individual/spend control and no incompatible reached-limit type. It always warns `mayConsumeCredits=true`.

Profiles expose `policyMode` (`adaptive` or `weekly_only`), `planGroup`, `baselineRemainingPercent`, `learnedMeanPercent`, `sampleCount`, `confidence` (`cold_start`, `low`, `ready`), `userOverridePercent`, `automaticThresholdPercent`, `effectiveThresholdPercent` and `jobClass`. Class-specific means are used after enough homogeneous samples; otherwise the general mean is used. Ready means enough samples, not guaranteed accuracy.

## `job_preflight`

Required: `jobId`, `taskId`, `workspaceRoot`, `jobClass` (`small`, `medium`, `long`), `description`. Optional: `estimatedMinutes` (0–10080, informational), `laneId`, `sessionRole` (`main` aliases primary; `lightweight` aliases secondary). Conflicting role inputs are rejected.

```json
{
  "jobId": "<task-id>:build:1",
  "taskId": "<actual-task-id>",
  "workspaceRoot": "/absolute/project",
  "jobClass": "long",
  "description": "Run tests and build the release",
  "laneId": "primary"
}
```

Result: `decision`, `reason`, `requiredAction`, `admissionRecorded`, `thresholdPercent`, `laneId`, `quotaPath`, `mayConsumeCredits`, and the decorated `quota` snapshot.

- `allow`: admitted above the caution band.
- `caution`: admitted in the five-point band, via credits, or under warning-only weekly policy. For `weekly_advisory`, continue without a Guard-required checkpoint/automation while warning that backend quota still applies. Other caution paths keep work bounded; explain credit risk when applicable.
- `defer`: do not start. Checkpoint and follow the defer contract.

Every non-defer call records one part-job admission. Reuse a `jobId` only for a retry of the same job: `admissionRecorded=false` means it was already recorded. IDs are unique within Codex home/account/plan/limit bucket, so prefix with task ID to prevent cross-task collisions. Replays re-evaluate current policy, not replay an old authorization. This tool does not execute, charge, reserve capacity for, or guarantee completion of the job. Call it before bounded implementation/research phases too, not just shell builds.

## `quota_profile`

```json
{"action":"get"}
```

```json
{"action":"adjust","deltaPercent":5}
```

```json
{"action":"reset"}
```

Returns the current active-bucket profile. `adjust` requires a signed, nonzero delta in `[-49,49]`; positive stops earlier, negative stops later. The stored cumulative override is bounded to that range. Only `adjust` accepts a delta. `reset` removes the override, not samples. Mutations require a fresh known account. Overrides persist per Codex home/account fingerprint/plan and apply to either role; role means remain bucket-isolated.

Adaptive default `auto = max(baseline, ceil(mean * 1.5))` after 3 valid samples; otherwise baseline. Weekly-only uses a 3% default (configuration range 2–5), disables five-hour learning, and still applies the account/plan override. `effective = clamp(auto + override, 1, 50)`. There is no inferred token allocation from plan prices.

## `checkpoint_create` and `checkpoint_get`

Create requires `workspaceRoot`, `objective`, `completed` and `pending`. Optional fields: `taskId`, `laneId`, `jobClass`, `gitStatus`, `lastTest`, `pendingCommand`, `resumeNotes`.

Limits: workspace 4096 characters; task ID 256; objective/resume notes/last test 4000; git status 8000; pending command 2000; lists at most 200 entries of 2000 characters. Use concise summaries without credentials or complete transcripts. Common secret patterns are redacted, but redaction is not a secrets vault.

Create returns the sanitized payload plus UUID `id`, `createdAt` and `resumeAt` (`null` for a standalone checkpoint). It does not schedule anything.

Get input: required `workspaceRoot`, optional `taskId` and `checkpointId` (UUID). Result: `{found,checkpoint}`. Without an ID it returns the latest matching checkpoint. Explicit IDs are still scoped to the Codex home, workspace and supplied task. Keep the returned ID for reliable resume instead of depending on the latest record.

## `defer_until_reset`

Uses checkpoint-create fields but **requires `taskId`**. Pass the same `laneId` and `jobClass` as the blocked preflight so class-specific thresholds remain consistent.

Returns `deferId`, `defer`, `checkpoint`, `resumeAt`, `canSchedule`, `reason`, `automationPrompt`, and `quota`. Reasons: `scheduled` (eligible to schedule, not already created), `reset_too_far`, `reset_unknown`, or `advisory_only` for a weekly-only warning that must not create an automation. A checkpoint and active defer record are stored even when no wake can be scheduled.

`resumeAt` is the latest known reset of every mandatory blocking constraint plus grace. Any unknown mandatory reset prevents scheduling. A wait above 24 hours is a hard stop (`canSchedule=false`); keep the checkpoint and tell the user. A usable secondary allowance does not shorten the main task's wait.

When `canSchedule=true`, the calling task must create a heartbeat in that same task using the returned time and exact prompt with the host automation tool. Use that tool's supported schedule format; never write scheduling files or assume that passing an ISO time as a recurrence string is valid. Confirm the tool actually returns a created automation ID, then attach it. Do not claim a heartbeat exists if creation fails. The [monitor](MONITOR.md) can later advance only that attached owned heartbeat; it cannot create the initial automation.

## `defer_automation_attach`

Input: `deferId` (UUID), `automationId` (1–256 characters). Returns the updated defer record (`id`, `checkpointId`, workspace/task/role, `automationId`, `state`, timestamps).

Attach only the ID just created for this defer. The MCP records caller-declared ownership; it does not enumerate or independently inspect Codex automations. The defer must be active, an existing ID cannot be replaced, and the same automation cannot belong to another defer. Reattaching the same ID is idempotent. If attachment loses a race with manual resume, best-effort delete only the newly created heartbeat.

## `resume_prepare`

Required: `workspaceRoot`, `taskId`, `trigger` (`manual`, `automation`). Optional: `deferId`, `laneId` (default primary).

```json
{
  "workspaceRoot": "/absolute/project",
  "taskId": "<actual-task-id>",
  "trigger": "manual",
  "laneId": "primary"
}
```

Result: `shouldExit`, `canResume`, `laneId`, `automationIdsToCancel`, `cancellationBestEffort:true`, `checkpointId`, `deferIds`, and `quota` (null on no-op).

For manual resume, all active matching workspace/task/role records are atomically superseded **before quota I/O**. Supplying `deferId` narrows that set. Cancel only returned IDs, best-effort; no ACK is needed. Secondary resume does not cancel primary defers. If there is no matching record, quota can still be checked.

Automation calls must supply the original `deferId`. Missing, superseded, already-fired, wrong-scope or early wakes return `shouldExit=true` without quota I/O. A due active record is claimed as fired exactly once before revalidation. `canResume` is selected-role-specific; the top-level primary recommendation must not override a valid secondary result.

On valid wake, check `canResume`, load the checkpoint, inspect current repository state, and preflight pending work. If still blocked, create a new defer for that role and attach a new eligible heartbeat; best-effort delete the completed heartbeat. For superseded wakes, exit without work. Manual early reset detection is rate-limited by snapshot age (default 60 seconds), shared lease and backoff; there is no public force switch. The monitor authorizes a claimed early wake before the original `resumeAt`, but never bypasses revalidation. New-account quota can recover the same task/role without reusing the old account profile.

# Token-free five-minute recovery monitor

The monitor is a local timer in the Guard runtime. It reads quota through the
official Codex app-server and advances only Guard-owned heartbeats through the
installed OpenAI `codex-app-tools` MCP. A quota check does not start a model turn;
the task that eventually resumes consumes normal quota.

Use the [managed Windows/WSL deployment](MANAGED_CORE.md) for monitoring that can
survive client disconnection. Direct stdio mode monitors only while at least one
initialized Guard process remains alive.

## Enrollment and ownership

Only a complete defer sequence is monitored:

1. `job_preflight` returns `defer` for a specific workspace, task, role and class.
2. `defer_until_reset` stores the checkpoint and returns `deferId`, `resumeAt`,
   `canSchedule` and the exact heartbeat prompt.
3. The Codex task creates that same-task heartbeat only when `canSchedule=true`.
4. `defer_automation_attach` binds the returned automation ID to the defer.

Attachment captures the expected automation definition. The monitor never enumerates
unrelated automations and does not adopt a later user edit. A missing, paused,
deleted or changed heartbeat is left alone. Scheduler writes preserve the owned
automation's prompt, task, status and notification settings.

Manual resume calls `resume_prepare(trigger="manual")` first. It atomically marks
matching defers `superseded` and returns only their owned automation IDs for
best-effort cancellation. A surviving superseded heartbeat exits without work.

## Poll and early-wake flow

- A fast local tick inspects SQLite only. A durable lease chooses one owner and
  records the next external quota check before I/O.
- While an attached defer is blocked, quota revalidation occurs at most once every
  five minutes. Shared backoff and nearer reset boundaries remain authoritative.
- A different signed-in account with sufficient quota counts as external recovery.
  Its own plan profile, samples and override are evaluated; none are copied from the
  account that created the defer.
- Fresh quota must admit the original `primary` or `secondary` role and job class.
  Stale quota, logout, unknown identity, spend controls, role mismatch and
  warning-only `weekly_advisory` never authorize advancement.
- The monitor validates the exact owned active heartbeat, fences one outbox claim,
  then requests an earlier schedule. It never shortens a wake already close enough.
- A lost scheduler acknowledgement is marked uncertain and is not replayed as a new
  mutation. The checkpoint and `resume_prepare` fence remain the recovery authority.
- On the actual wake, the prompt calls `resume_prepare(trigger="automation")`.
  `shouldExit=true` ends the turn; only `canResume=true` permits checkpoint loading
  and a new preflight.

There is no public force-refresh input. The monitor never writes Codex automation
files or databases directly and never substitutes a token-consuming recurring AI
heartbeat.

## Runtime and account lifecycle

In managed Windows mode, the per-user five-minute probe starts a missing core only
when an attached active defer exists. The core stays alive for that recovery work
without a connected MCP client. With no pending recovery it exits after the idle
delay, so ordinary use does not leave a permanent Guard service.

The probe uses the active Windows session's least-privilege token. It does not run
while that OS session is signed out, and neither probe nor core runs while the
computer sleeps. ChatGPT account logout/login inside Codex is different and is
supported as described below. After an OS sign-in, wake or Codex restart, a new
connector must supply a valid desktop capability before scheduler advancement is
available. Original heartbeat times remain intact when capability is missing.

An account switch is detected on the next permitted quota refresh, not synchronously
with the login UI. Account metadata is read before and after quota data; an observed
mid-read change rejects that snapshot. A reset or new account may enable an earlier
wake, but never transfers learned statistics or threshold overrides.

## Diagnostics

`quota_status.monitor` reports:

| Field | Meaning |
| --- | --- |
| `available` | Trusted scheduler path and current runtime capability are usable. |
| `intervalMs` | Minimum external monitor cadence; default 300,000 ms. |
| `pendingRecords` | Attached active defers eligible for observation. |
| `nextPollAt`, `lastPollAt` | Durable quota-check deadlines. |
| `lastError` | Bounded latest monitor/scheduler error. |
| `runtimeMode` | `stdio` or `shared-http`. |
| `requiresLiveMcpProcess` | A Guard core/process must exist. |
| `requiresLiveClientConnection` | `false` for the managed shared core. |

`available=true` is not proof that a heartbeat was mutated or delivered. A successful
acceptance must observe the owned schedule change, actual same-task wake,
`resume_prepare` revalidation and deletion of only that heartbeat.

## Known boundaries

The scheduler integration is a runtime-verified shipped desktop MCP surface, not a
documented stable third-party scheduling API. Unknown schemas and authorization
failures fail closed. Five minutes is a polling ceiling, not guaranteed delivery
latency; backoff, sleep and desktop scheduling can delay a wake.

Automated tests cover competing monitor owners, account changes, logout, backoff,
manual-resume races, edited automations and uncertain scheduler acknowledgements. A
controlled Windows acceptance has also verified a real early same-task wake after an
account switch, quota revalidation and owned-heartbeat cleanup without periodic model
turns. Reboot, full desktop restart, sleep/wake and future plugin versions still need
acceptance on each target host.

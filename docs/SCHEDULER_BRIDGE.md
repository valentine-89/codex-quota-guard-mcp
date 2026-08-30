# Token-free scheduler bridge investigation

Status: **v0.3 production timer, Windows scheduler advancement, real early task wake and cleanup verified; WSL-to-Windows inventory verified**. See [monitor setup and exact acceptance boundary](MONITOR.md).
Date: 2026-08-30. Tested CLI 0.147.0, desktop 26.825.5331.0, bundled
`codex-app-tools` plugin 0.1.3 (MCP handshake version 0.1.0).

## Result

A local Node process can start the installed desktop app-tools MCP server,
connect using the desktop-supplied capability, and call `automation_update` for
an existing idle task. No model invocation or new task turn was needed in the
successful paused-update probe. This removes the previously unproven local
scheduler-dispatch link; it does not yet establish a production monitor.

```text
Local Node controller (no inference)
  -> standard MCP stdio client
  -> installed codex-app-tools/server.mjs
  -> desktop-supplied app-tools pipe
  -> desktop automation_update handler
  -> existing automation schedule
```

Use the shipped MCP server, not copied proprietary implementation code, raw
private IPC calls, UI injection, or direct writes to Codex TOML/SQLite. The
script inherits `CODEX_APP_TOOLS_PIPE_PATH` from the desktop environment. It
must not discover a capability by scanning processes/pipes or reading auth files.
The pipe value must not be logged, persisted, or copied across hosts.

## Evidence and its limits

| Check | Observed result |
| --- | --- |
| Standard MCP initialize and tools/list | Server identified itself as codex-app-tools; 38 tools, including automation_update |
| Read-only view dispatch with a real idle task ID | Succeeded; returned a rendered-card acknowledgment, not automation data |
| Official tool creates disposable PAUSED heartbeat | Succeeded; twenty-minute interval; never enabled |
| Separate Node MCP client updates that heartbeat | Succeeded at 01:58:18.334 UTC; changed interval to two minutes while retaining PAUSED |
| Read-only comparison of exact probe TOML | Only schedule and update timestamp changed; ID, prompt, target task, status, creation time preserved |
| Target task status before and after | Idle; same completed turn and unchanged status revision; no new turn |
| Cleanup through official automation tool | Probe deleted; exact probe automation.toml no longer existed |

The update response was `Updated automation in the app.` plus structured text
identifying the automation ID, mode `update`, and status `PAUSED`. Merely seeing
`Rendered automation card in the app.` from `view` is **not** mutation evidence.

The earlier experiment in local `work/automation-probe/FINDINGS.md` independently
verified a real heartbeat wake about 15 minutes 12 seconds ahead of its original
schedule after an active agent changed the interval. Recovery was simulated;
the schedule change and wake were real. This investigation adds standalone Node
mutation, but deliberately keeps its probe paused so it cannot consume inference
quota. Together these are component-level evidence, not an end-to-end idle
monitor/recovery acceptance test.

Local, ignored probe sources are in `work/scheduler-bridge-probe/`. Public docs
omit machine-specific task IDs, capability values, and live state.

## Read-only capability diagnostic

From a desktop-launched terminal whose environment already includes the
app-tools capability, locate the installed `codex-app-tools` plugin manifest and
its `server.mjs`. Then run:

```powershell
node scripts/scheduler-bridge-doctor.mjs --server 'C:\absolute\installed\codex-app-tools\version\server.mjs'
```

Supply only the trusted, installed OpenAI plugin entrypoint; the command executes
that file. The diagnostic lists tool schemas only: it does not call tools, modify
automations, start turns, read credentials, or install a monitor. It is bounded by
a timeout and fails when the desktop capability is absent. A successful result
only establishes transport/inventory, not permission to mutate an automation.

To repeat the mutation acceptance, use the official automation tool to create a
new disposable **PAUSED** heartbeat for a real idle test task. Record its exact
fields, use the shipped MCP with the real `threadId` metadata to update only its
schedule while preserving PAUSED and all other fields, inspect that exact record
read-only, confirm the task has no new turn, and delete only the probe using the
official tool. Never substitute a production automation or enable a periodic
inference probe. Do not invent active turn IDs or supply forged approvals.

## Required monitor implementation

The agreed requirement remains a local timer, **not an AI heartbeat every five
minutes**. Checking quota or dispatching a scheduler update must not invoke a
model. The eventual resumed work itself still consumes its normal quota.

1. Run one shared monitoring owner while there are active, attached quota-owned
   defers. Persist a five-minute poll deadline when their selected allowance is
   exhausted; do not retain an exhausted-cache deadline hours into the future.
   Coordinate all processes through shared leases/cache/backoff. Respect backend
   retry timing and nearer normal reset boundaries. No public force-refresh.
2. Revalidate the current account fingerprint and plan, workspace, task, selected primary/secondary
   role and defer ownership. A different signed-in account with sufficient quota
   counts as external recovery: do not require it to match the account that created
   the defer. Evaluate its own baseline, learned samples and override; never copy
   the previous account's statistics or preferences. Logout, unavailable identity,
   stale quota and backoff must retain the checkpoint and scheduled wake without
   authorizing work. Switching accounts is observed at the next permitted shared
   refresh, not synchronously with the login UI. Require fresh quota and an admissible policy result,
   not just a changed reset timestamp or any positive remaining percentage.
   Secondary recovery must not wake primary work. Do not use display model names.
3. Claim the active defer atomically, persist a recovery/outbox generation, and
   advance only its attached automation. Preserve prompt, task, status, notification
   preference and unrelated fields. A user-paused/deleted/edited automation must
   not be silently reactivated or overwritten. Recheck ownership immediately before
   dispatch and handle manual-resume races. Superseded prompts must remain no-ops.
4. Coordinate the earlier wake with `resume_prepare`: changing the scheduler alone
   is insufficient because v0.2 currently rejects a wake before stored `resumeAt`.
   Recovery state must allow a claimed early wake to revalidate safely. Handle a
   lost scheduler response idempotently, without retry storms or duplicate wakeups.
5. Require the expected MCP schema, desktop capability and usable task context.
   Inspect only known owned automation records for preserved fields: view returns
   a card, not a full data object. Never scan or mutate unrelated automations.
   Respect host authorization failures; do not disable approval or peer checks.
6. Verify capability inheritance in the **registered quota-guard process**, not
   merely this task's shell. Test process lifetime while all tasks are idle,
   desktop restart, disconnect, sleep/wake and concurrent guard instances. No
   unattended service or startup registration has been installed by this research.

## Support and acceptance boundary

This is a shipped desktop MCP surface observed live, **not a documented stable
third-party scheduler API**. Runtime inspection indicates idle task dispatch is
accepted; an active model turn was not required in the probe. The application
must be running and able to service the tool. Linux/macOS behavior, macOS peer
authorization, future plugin schemas, a fully idle application, and restarted
desktop capability propagation are not verified here.

Do not hardcode this plugin version as a universal installation path. Do not
select an older-version fallback automatically. If the capability is absent or
authorization fails, retain the original scheduled wake and report the monitor
as unavailable; do not switch to token-consuming polling or private state writes.

The v0.3 implementation adds the shared five-minute timer, fenced early-wake state,
ownership-checked scheduler adapter, and fast local cleanup. Automated tests cover
competing SQLite connections, account changes, backoff, manual-resume races and
uncertain scheduler acknowledgments. The controlled account-switch recovery test
received a real heartbeat at04:04:17.529Z, before the original05:22:30Z checkpoint
boundary, with successful quota revalidation and owned-heartbeat deletion. A
bounded SDK connection kept MCP alive; desktop reconnection, indefinite idle
lifetime and sleep/restart coverage remain separate, unverified claims. See the
[acceptance timeline](MONITOR.md#real-early-wake-after-account-switch).

### Windows/WSL follow-up

A WSL2 caller successfully ran the read-only bridge diagnostic using the shipped
**Windows** Node/MCP runtime through interop, with the existing desktop capability
forwarded through process-scoped WSLENV. This matches the installed desktop's
observed WSL launch strategy; it is not direct Linux access to a Windows pipe.
No scheduler mutation or model turn was performed in this follow-up. See
[Windows/WSL setup and acceptance](WINDOWS_AND_WSL.md) for the launcher, credential
boundaries, and distinctions between core quota support and scheduler availability.

## Official documentation versus local evidence

[Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) documents
desktop/web management and the local app/machine running requirement.
[App-server documentation](https://learn.chatgpt.com/docs/app-server) documents
quota RPCs and generic `mcpServer/tool/call`; it does not establish this bundled
desktop scheduler bridge as a stable external API. The live test used a standard
MCP client directly against the installed plugin, not app-server tool forwarding.

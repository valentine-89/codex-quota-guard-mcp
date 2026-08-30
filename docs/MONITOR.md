# Five-minute early-recovery monitor

Version 0.3 adds an optional timer inside the stdio MCP process. It reads quota via the official app-server and changes schedules via the installed OpenAI `codex-app-tools` MCP server. Quota checks do not invoke a model. The resumed task itself does consume normal model usage.

## Agent installation

1. Complete [normal installation](GETTING_STARTED.md) and use one state database per Codex home. Do not register a singleton-only MCP; each task needs its own stdio connection.
2. Locate the user's installed OpenAI `codex-app-tools` plugin from the installed plugin manifest. Verify its identity and locate `server.mjs`; do not download executable code from an untrusted location or hardcode the version from this repository's test machine.
3. Run `node scripts/scheduler-bridge-doctor.mjs --server <absolute-server.mjs-path>`. This lists schema only and never changes an automation. Missing desktop capability is not solved by reading auth files or finding pipe addresses.
4. Set `schedulerServerPath` in the guard JSON config, or `CODEX_QUOTA_GUARD_SCHEDULER_SERVER` in its MCP environment. Leave `monitorEnabled: true` (default), or set false to disable. Add `CODEX_APP_TOOLS_PIPE_PATH` and `CODEX_MCP_NODE_PATH` to the registration's `env_vars`. Never store their session-specific values in config.
5. For Windows-hosted WSL callers, forward `CODEX_APP_TOOLS_PIPE_PATH/w`, `CODEX_MCP_NODE_PATH/w`, and `CODEX_QUOTA_GUARD_SCHEDULER_SERVER/w` in the existing WSLENV alongside the documented guard variables. Do not use `/p` to translate a Windows pipe or a Windows server path. The server runs Windows Node, not Linux Node.
6. Start a new MCP connection and check `quota_status.monitor.available`. This means the path and capability are present, not that a scheduler write has succeeded; inspect `lastError` and perform an authorized bounded acceptance test before claiming full runtime acceptance.

Registration fragment (merge, do not overwrite unrelated settings):

```toml
[mcp_servers.codex_quota_guard]
# Keep the installed command, args and timeouts.
env_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"]

[mcp_servers.codex_quota_guard.env]
# Keep the configured CODEX_HOME, node, CLI and WSLENV entries.
CODEX_QUOTA_GUARD_SCHEDULER_SERVER = 'C:\actual\installed\codex-app-tools\version\server.mjs'
```

## Lifecycle and timing

- Only newly enrolled, active, attached guard defers are candidates; the timer does not enumerate unrelated automation files. The original automation definition must be captured during attachment with the bridge available. Missing capture or edits after attachment prevent automatic advancement; retrying attachment never adopts a changed definition.
- A local 15-second tick checks guard state. A durable SQLite lease chooses one quota owner and reserves the next external check at least five minutes later. Crashes cannot trigger a polling herd. Existing refresh leases and backoff remain authoritative.
- An exhausted cache can be revalidated after five minutes while a candidate waits, even if its normal TTL would last until reset. This is internal; there is no public force refresh.
- Fresh quota must admit the checkpoint's job class on its original primary/secondary role. A different account/plan is allowed, but statistics and overrides never migrate between accounts.
- Account metadata is read before and after the quota RPC; a detected change rejects that observation. This is a consistency check, not an atomic guarantee provided by the backend.
- The monitor validates the exact owned ACTIVE heartbeat's ID, task and guard prompt; preserves its fields; records a fenced outbox claim; then requests a two-minute schedule through the shipped MCP. It does not shorten a wake already within two minutes. Unexpected schema, paused/deleted/edited automation or missing authorization is not bypassed.
- `resume_prepare` permits a claimed early wake, rechecks quota, and atomically marks it fired. Manual resume supersedes matching defers first. Cleanup reconciles fired/superseded accelerated heartbeats on local ticks without extra quota reads; the prompt must also best-effort delete its completed heartbeat.
- Lost scheduler acknowledgments are marked uncertain and never replayed as a fresh advance. There is no cross-database atomic transaction with the desktop scheduler. A crash or concurrent user edit can still leave uncertain delivery; the original checkpoint and defer guard remain essential.

## Persistence and scope

Schema version 3 adds `monitor_state` and `defer_recovery` transactionally. It preserves cache, checkpoints and v0.2 policy/defer data. Old defers without recovery enrollment are left on their existing schedules; no account identity is invented. A deliberate migration of a particular old automation requires verified ownership and user authorization.

Do not run older binaries against the migrated database. Update the installation and open fresh MCP connections; do not kill unrelated active Codex tasks to enforce this.

## Limits and diagnostics

The app, computer and at least one guard MCP connection must remain alive. Sleep, app shutdown, closed stdio or revoked desktop capability stops monitoring. No standalone service is installed. Five minutes is a check cadence, not a guaranteed wake latency; backoff, sleep and scheduler delivery can extend it.

`quota_status.monitor` returns `available`, `intervalMs`, `pendingRecords`, `nextPollAt`, `lastPollAt`, `lastError`, and `requiresLiveMcpProcess`. A configured bridge with a scheduler error is not proof of delivery. The shipped desktop bridge is runtime-verified integration, not a documented stable third-party API; unsupported versions fail closed without a compatibility fallback.

## Acceptance — 2026-08-30

- Windows Node24 and WSL Ubuntu22.04/Node24: full `npm run check`, 63 tests passed on each platform.
- A real stdio MCP subprocess with isolated quota/scheduler fixtures advanced its attached heartbeat without any client quota-tool call. This proves internal timer dispatch, not delivery by the live desktop scheduler.
- Isolated live app-server/handshake: eight tools, server0.3.0, fresh ChatGPT Plus quota, both quota roles detected.
- Newly opened SDK connections using the locally registered Windows launcher, directly and through WSL interop: server0.3.0 and `monitor.available=true`.
- Actual account switch changed the observed primary allowance from9% to99%. With explicit user authorization, one existing v0.1 heartbeat was linked to a new defer while preserving its task, checkpoint and original resume boundary. The production monitor then advanced it and the real desktop heartbeat woke the task early; details below.
- Six identified older Quota Guard processes were stopped at the user's request. The existing task tool connection then returned `Transport closed`; automatic desktop reconnection was not observed. Updating files does not hot-reload an already-running MCP. Open a fresh connection/task or reload MCP through available app controls; a standalone smoke connection is not evidence of automatic reconnection.
- Full idle lifetime, desktop restart and sleep/wake delivery remain unverified.

### Real early wake after account switch

All timestamps below are UTC on 2026-08-30 (local test timezone UTC+07:00).

| Event | Timestamp / result |
| --- | --- |
| Original checkpoint resume boundary | 05:22:30.000 |
| Monitor's scheduler advancement observed | 04:01:10.995; outbox `scheduled`, no error |
| Actual incoming desktop heartbeat | 04:04:17.529 |
| Resume validation and marker persisted | 04:04:25.039; `canResume=true`, `shouldExit=false`, primary remaining79% |
| Cleanup verified | Defer `fired`, heartbeat file absent, pending monitor records0; bounded watcher exited successfully |

The incoming heartbeat arrived **78 minutes 12 seconds before the original checkpoint
resume boundary**, approximately **3 minutes 7 seconds after advancement was
observed**. The schedule was advanced from115 minutes to2 minutes by the monitor,
not by a manual agent reschedule call. Setup changed only the legacy prompt to the
new defer contract before attachment; the original interval was preserved until
the internal timer dispatched the update. No reset credit was consumed, and no
auth file or scheduler database was edited.

This was a real scheduler invocation, not a manually executed wake marker. It
revalidated quota via a fresh registered MCP connection and deleted only the
owned test heartbeat. No periodic model invocation was used to inspect quota;
the actual resumed task consumed ordinary model usage.

**Acceptance boundary:** a bounded SDK harness kept the registered Windows MCP's
stdio connection alive (maximum10 minutes) and observed guard state locally. The
task was idle between setup completion and heartbeat delivery. This validates
production timer → shipped scheduler → actual task wake → resume validation and
cleanup. It does not prove that desktop automatically reconnects a killed MCP,
keeps every MCP alive indefinitely, or delivers within exactly2 minutes. Because
conversion occurred after account switching, automatic detection across an
unattended live logout/login transition was not exercised; account-transition
eligibility and five-minute cadence are additionally covered by automated tests.

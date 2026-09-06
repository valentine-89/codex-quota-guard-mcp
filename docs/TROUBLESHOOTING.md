# Troubleshooting

## `CHATGPT_LOGIN_REQUIRED`

Codex is signed out, using API-key/Bedrock/another provider, or did not return a stable ChatGPT identity. Sign in through Codex itself and reconnect the MCP. Quota Guard deliberately provides no login flow or API-key fallback.

## `MANAGED_CORE_START_FAILED`

Confirm Node 22.13+, absolute paths in the private runtime settings, and that the selected loopback port is not occupied. A wrong listener is never terminated automatically. Rerun `npm run build` and `node scripts/install.mjs`.

## Connector unavailable after install

Restart or reconnect Codex so it reads the updated MCP registration. Verify the registration points to the current absolute Node executable and `dist/connector.js`, not `dist/main.js` or an old `http-connector.js`.

Connector diagnostics are emitted only on stderr and use a bounded phase label: `settings`, `core_startup`, `health`, `handshake`, or `forwarding`. Stdout is reserved for JSON-RPC. These messages never include the bearer, task content, or checkpoint data.

The installer sets `default_tools_approval_mode="approve"` only for the Guard server. This lets non-interactive Codex tasks use its quota/checkpoint lifecycle while leaving every unrelated MCP approval policy unchanged.

## Core remains briefly after Codex closes

A normal disconnect allows about five seconds for clean shutdown. A crashed connector can take up to 60 seconds for lease expiry, plus about five seconds of shutdown grace. A live connector or active request legitimately extends the lifetime; a pending defer alone does not.

## Windows permission error

Run with PowerShell 7 as the normal user. Do not elevate. The installer changes only the dedicated `core-<profile hash>` DACL. If corporate policy blocks user DACL changes, ask the administrator to permit a private user-owned directory rather than granting broad rights.

## WSL creates a second core

Use the Windows-side installation and Windows-hosted launcher for Windows Codex tasks. Do not mix Linux and Windows settings/SQLite for one profile.

## Monitor unavailable on Windows, WSL, Linux, or macOS

`quota_status.monitor.available=false` means no usable verified scheduler binding is active. `monitor.unavailableReason` is returned in every detail level (null when available):

| Reason | Action |
| --- | --- |
| `MONITOR_DISABLED` | Check `monitorEnabled` in the Guard configuration. |
| `SCHEDULER_SERVER_UNCONFIGURED` / `SCHEDULER_SERVER_INVALID` | Verify the current Desktop installation or host-provided resource directory; reconnect with fresh runtime context. |
| `SCHEDULER_NOT_BOUND` | Check that the current task inherits `CODEX_THREAD_ID` and `CODEX_APP_TOOLS_PIPE_PATH`, then reconnect. |
| `SCHEDULER_ENDPOINT_INVALID` / `SCHEDULER_TASK_INVALID` | The inherited endpoint or task ID failed validation. |
| `SCHEDULER_TOOL_MISSING` | The connected server does not advertise `automation_update`. Check the selected server and Desktop installation. |
| `SCHEDULER_SCHEMA_UNSUPPORTED` | The advertised tool lacks the required heartbeat/update/delete contract. |
| `SCHEDULER_IDENTITY_UNSUPPORTED` | The connected server does not identify as `codex-app-tools`. |
| `SCHEDULER_CONTEXT_REJECTED` | Same-task `list_threads` verification failed. |
| `SCHEDULER_DISCOVERY_FAILED` | Server launch, MCP negotiation, or discovery failed. |
| `SCHEDULER_CLOSED` | The scheduler runtime has stopped. |

Windows uses a named pipe; Linux/macOS use an absolute Unix-domain socket path. Having the environment variables alone is insufficient. Compatibility is checked by capability, not the `codex-app-tools` version number; no minimum Desktop version is established here.

Installation removes the retired schedulerServerPath setting and CODEX_QUOTA_GUARD_SCHEDULER_SERVER registration. No scheduler path is persisted. A custom host must supply its current CODEX_ELECTRON_RESOURCES_PATH in its process environment on every launch; do not pin a versioned path in config.toml.

After building, run `node scripts/scheduler-bridge-doctor.mjs` inside the task environment for automatic discovery, or pass `--server "/absolute/path/to/server.mjs"` to inspect a particular installation. Doctor and runtime share the same stable handshake and identity/tool/schema check. Doctor does not call tools, verify task context, or mutate automations: `ok=true` confirms discovery only, not monitor or auto-resume readiness.

Runtime resolves current Desktop resources on startup and binding renewal. Ambiguous discovery fails closed. Normal rediscovery does not rotate the core endpoint or require reinstalling Guard. Recheck monitor.available after repairing the host context. Existing baseline-less records are not silently adopted.

Quota/checkpoint tools remain usable without scheduling. `monitor.available` describes early-recovery monitoring, while scheduled resume requires the host to create and attach a heartbeat. `canSchedule=true` only validates reset timing; it does not prove the host has a scheduler. If the host lacks that tool, report the saved checkpoint and manual resume time. No alternate auto-resume mechanism is provided.

## Safe diagnostics

Run `npm run check`, `npm run acceptance:install`, `npm audit`, and inspect only authenticated health/settings paths. Never paste runtime bearer values, auth files, full prompts, responses, or live checkpoints into an issue.

## VS Code IPC

Run the installed scheduler-bridge-doctor from the task environment. With no Desktop capability, Windows discovery inspects the current IPC owner and snapshot. `ok=true` proves read-only discovery, not successful dispatch. IPC requires the exact task, profile rollout path, workspace, live lease, and idle owner; unknown/mismatched state remains waiting. Protocol 26.901.22334 is internal and not guaranteed by OpenAI. No guessed alternate protocol is attempted.

A wake with an attempt but no confirmed turn is `uncertain`; manually resume that defer rather than retry injection. A confirmed turn remains scheduled until `resume_prepare` claims its defer. After closing the app, reopen the same task and call a Guard tool to restore its live lease; saved pending schedules can then be reconsidered. Reconnect clients to load 2.3.0. Never kill another task or remove a thread writer lock.

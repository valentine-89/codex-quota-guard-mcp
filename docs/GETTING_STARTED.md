# Getting started (humans and AI agents)

This document is the shortest safe path from a repository link to a working local MCP server. It is also written so an AI coding agent can execute it without inventing credentials, paths, or quota values.

## Prerequisites

- Node.js 22.13 or newer (`node --version`).
- Codex CLI/Desktop installed and already signed in to ChatGPT.
- A Codex app-server that implements `account/read` and `account/rateLimits/read`.
- Git and an absolute writable checkout path.

The guard does not read `auth.json`, use OAuth tokens directly, scrape the UI, or send telemetry. It starts a short-lived `codex app-server --stdio`; that official process makes the upstream account/rate-limit requests. If sign-in is missing, ask the user to complete the official login flow; never search for credentials.

## Install

Windows PowerShell 7:

```powershell
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
Set-Location .\codex-quota-guard-mcp
npm ci
npm run check
```

Linux/macOS:

```bash
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
cd codex-quota-guard-mcp
npm ci
npm run check
```

`npm run check` performs typecheck, lint, regression tests, and builds `dist/main.js`. Do not register `src` or run a TypeScript loader in production.

## Register with Codex

If the Windows desktop may switch between native and WSL agent mode, use the
[Windows-hosted launcher recipe](WINDOWS_AND_WSL.md) instead of a Windows-only
direct executable entry below. It keeps the guard, ChatGPT profile and SQLite
cache on one host. The guide also covers independent Linux-native WSL installs.

Add one MCP entry using absolute paths. On Windows, edit `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.codex_quota_guard]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\to\codex-quota-guard-mcp\dist\main.js']
startup_timeout_sec = 30
```

Replace both paths with the actual executable and checkout locations (`Get-Command node` on PowerShell, `command -v node` on POSIX). TOML single-quoted strings use literal backslashes. On Linux/macOS use corresponding absolute paths. If `CODEX_HOME` is set, use its `config.toml` instead of the default. Merge only the quota-guard entry and preserve unrelated settings.

Merge [`../examples/AGENTS-snippet.md`](../examples/AGENTS-snippet.md) into the intended project `AGENTS.md` (or global instructions if the user wants all projects protected). Do not overwrite existing instructions. This step is required for automatic agent cooperation: installing MCP tools does not cause calls on its own. Open a new task after registration so both tools and instructions reload; existing tasks may retain their old inventory.

If `codex` is not on the MCP process PATH, set an absolute `codexCommand` in the guard config or `CODEX_CLI_PATH` in the MCP environment. An executable supplied by the installed Codex app is acceptable; do not invent a path. No administrator privilege or global npm install is required. If heartbeat tools are unavailable in the chosen client, checkpoint and report a manual resume time instead of inventing a scheduler.

## Verify the connection

From a fresh Codex task:

1. Call `quota_status` once and inspect `source`, `planType`, `lanes.primary`, and `lanes.secondary`.
2. Confirm `stale=false` and `refreshInProgress=false`. `lanes.primary` is the active/default allowance unless that bucket is explicitly recognized as reserve. Both role entries may be present; a missing capability has `available=false` and `bucket=null`.
3. Call `job_preflight` for a small read-only action with a stable `jobId`, current `taskId`, absolute `workspaceRoot`, `jobClass: "small"`, and a concise `description`.

If the response is `CODEX_UPGRADE_REQUIRED`, upgrade Codex. The guard intentionally has no direct-auth fallback. If the response source is `cache`, inspect `stale`, `nextRefreshAt`, and `backoffUntil`; do not add a public force-refresh argument.

## Operating contract

Before a costly boundary (build, full test suite, deploy, migration, packaging, or training), call `job_preflight` exactly once with a stable idempotent `jobId`. Always include `taskId`, `workspaceRoot`, `jobClass`, and `description`.

- `allow`: start the bounded job and keep its result resumable.
- `caution`: start only if the job is bounded; the response explains whether credits may be consumed.
- Weekly-only `caution` with `quotaPath="weekly_advisory"`: warn and continue freely; do not create a Guard-required checkpoint or automation. The backend can still reject truly exhausted usage.
- `defer`: do not start a new job. Call `defer_until_reset` with a redacted checkpoint payload. Always keep the returned checkpoint; create a same-task heartbeat only when `canSchedule` is true, then call `defer_automation_attach` with that automation ID.

On wake, the heartbeat must call `resume_prepare` with the original workspace, task, lane, defer ID and `trigger: "automation"` before reading the checkpoint. If `shouldExit=true`, stop without work. Otherwise require `canResume=true`, then preflight pending work. A manual resume calls `resume_prepare` with workspace/task/lane and `trigger: "manual"` first; only returned quota-guard automation IDs may be cancelled, and cancellation is best-effort. See the [API reference](MCP_API.md) for complete inputs.

## Primary/secondary quota roles

Roles are stable even when model names change:

- `primary`: the active/default Codex bucket. This is the main work lane.
- `secondary`: a separately reported reserve/secondary bucket. Use it only for small/lightweight work.

The adapter recognizes the observed app-server bucket ID `base_model_inference`, not a model name. The backend ID is not guaranteed to stay unchanged; if it changes or is omitted, the guard fails safe rather than guessing. Choosing a role does not change the model: the user must already have selected a model eligible for that allowance. A main task stays deferred while a user-selected lightweight session works; the guard does not create or switch sessions itself.

When the primary five-hour window is exhausted but secondary still has allowance, call:

```json
{
  "jobId": "inspect-2026-08-30-01",
  "taskId": "<current-task>",
  "workspaceRoot": "D:\\VSYS\\project",
  "jobClass": "small",
  "description": "Inspect files and prepare a report",
  "sessionRole": "lightweight"
}
```

The alias selects `laneId: "secondary"`. For the main task omit the alias or use `laneId: "primary"`; it remains deferred until the primary constraints clear. A secondary result never authorizes the primary task to continue.

## Profiles and persistence

Plan baselines are Free/Go 20%, Plus/Team/fixed Business/Enterprise/Edu 10%, Pro/Prolite 5%, and unknown 15%. After three valid intervals, `auto = max(baseline, ceil(mean * 1.5))`; the final threshold is `clamp(auto + override, 1, 50)`. Overrides are account-fingerprint + plan scoped within the Codex home and survive restarts until reset. Samples are also isolated by limit bucket. Usage-based plans need runtime credit/unlimited confirmation, not a plan-name assumption.

For example, `quota_profile({"action":"adjust","deltaPercent":5})` stops 5 percentage points earlier; `-5` moves it later. `{"action":"reset"}` clears only the override, not learned history. Outside usage, reporting delays and overlapping jobs make passive estimates approximate.

State is local SQLite under `%LOCALAPPDATA%\codex-quota-guard\state.sqlite` on Windows or `$XDG_STATE_HOME/codex-quota-guard/state.sqlite` on Linux/macOS (fallback `~/.local/state/...`). Never commit this file, checkpoints, or authentication material.

## Configuration

Defaults work without a config file. To customize them, set `CODEX_QUOTA_GUARD_CONFIG` to an absolute JSON path matching [`../examples/config.schema.json`](../examples/config.schema.json). `CODEX_QUOTA_GUARD_STATE_DIR` changes only the local state directory. Keep `sampleWindow`, `minSamples`, `safetyFactor`, `maxThreshold`, `weeklyOnlyRemainingPercent` (2–5), and `maxAutomationWaitMs` within the documented bounds.

Environment can be set on the same MCP entry:

```toml
[mcp_servers.codex_quota_guard.env]
CODEX_QUOTA_GUARD_CONFIG = 'C:\path\to\quota-guard.json'
# Optional if codex is not on PATH:
# CODEX_CLI_PATH = 'C:\actual\path\to\codex.exe'
```

Explicit JSON `stateDir`, `codexHome`, and `codexCommand` take precedence over their environment equivalents. `minSamples` must not exceed `sampleWindow`; plan defaults must not exceed `maxThreshold` (at most 50). `maxAutomationWaitMs` can be reduced, never raised beyond 24 hours.

## Upgrade from v0.1

1. Finish or checkpoint active work. Inspect `git status` and preserve local changes. Do not reset or overwrite a dirty checkout.
2. Stop only quota-guard processes when safe; do not kill the Codex app or unrelated tasks. Back up the SQLite state consistently: after all guard processes close, copy the database and any remaining `-wal`/`-shm` companions together, or use SQLite's online backup API. Never copy just the main file while a writer is active.
3. Update the checkout to the intended release, then run `npm ci` and `npm run check`. Keep the registered absolute entrypoint unchanged when possible.
4. Remove v0.1 percentage settings from the guard JSON and merge the v0.2 agent snippet. The MCP contract is intentionally breaking; SQLite migration is additive and preserves old checkpoints/cache. A v0.1 snapshot is revalidated before admission. Do not run old and new guard processes against the same state for ongoing work.
5. Start a new task, verify the eight tools and `0.5.0` server version, then call `quota_status`. Use `npm run acceptance:live` for a protocol smoke without creating admissions or automations. Configure the optional [early-recovery monitor](MONITOR.md) separately; cloning/registering quota tools alone does not enable its scheduler capability. On Windows/WSL, the recommended [managed shared core](MANAGED_CORE.md) provides per-user startup recovery and capability renewal without a full-process fallback.

For release acceptance, `npm run acceptance:live -- --isolated` uses a new temporary guard database while preserving the selected Codex login/profile. The script prints that directory and leaves it for inspection; do not publish its contents. Ordinary diagnostics should reuse shared state, not create isolated databases to bypass refresh limits. To smoke a registered command exactly, the script also accepts `--command <executable>` and `--args-json <JSON-string-array>` copied from the registration.

Add `--summary` to limit successful output to protocol version, tool inventory,
quota freshness/source, plan and role names. Cross-OS acceptance must use temporary
paths belonging to the server host: run `--isolated` from Windows when launching
the Windows-hosted server. Do not send Linux temporary config paths to Windows.

An interrupted migration rolls back transactionally. A database with a newer schema is refused rather than downgraded. Restoring a pre-upgrade backup loses newer state; ask before doing so.

## Uninstall

Remove only `[mcp_servers.codex_quota_guard]` (and its environment table) from Codex config and the quota-guard instruction block from the chosen `AGENTS.md`. Cancel only known guard-owned heartbeat IDs, then start a new task. Keep the checkout and SQLite state unless the user explicitly requests their deletion; state includes checkpoints and learned profiles. Removing the MCP entry does not cancel existing Codex automations automatically.

## Troubleshooting checklist

1. Run `node dist/main.js --doctor` from the checkout.
2. Verify `codex` is on `PATH` and is signed in; do not copy auth files.
3. Confirm the registered command points to the built `dist/main.js` and uses absolute paths.
4. Restart the Codex task after MCP config changes.
5. For missing checkpoints or heartbeat, verify that the agent called `defer_until_reset` and then created/attached the returned automation. The MCP server cannot create Codex UI automations by itself.
6. If a reserve allowance is expected but `lanes.secondary` is unavailable, inspect the raw app-server capability through a supported Codex build. Do not substitute an arbitrary `rateLimitsByLimitId` entry.

See [`CHECKPOINT_AND_RESUME.md`](CHECKPOINT_AND_RESUME.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), and [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the detailed contracts.

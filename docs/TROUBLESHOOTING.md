# Troubleshooting

## `CODEX_NOT_FOUND`

Confirm `codex --version` works in the same environment as the MCP process. Set `codexCommand` to an absolute executable path when Codex is not on `PATH`.

## `CODEX_UPGRADE_REQUIRED`

The installed app-server lacks `account/rateLimits/read`. Upgrade Codex and start a new MCP session. Direct credential/OAuth fallback is intentionally unsupported.

## Quota is unavailable or stale

Run `node dist/main.js --doctor`. Inspect `backoffUntil`, `refreshInProgress`, and the bounded error code. Do not repeatedly restart the server: shared backoff exists to protect the upstream account service.

## Authentication expired

Use the official Codex login flow, verify `codex` can read the account, then wait for the shared backoff deadline. This project does not repair or copy credentials.

## SQLite busy or corrupt

Close quota-guard processes first. Preserve the database for diagnosis, then move it out of the state directory and restart to create a new cache. Checkpoints in the moved database are not automatically migrated. Never publish the database.

## Automation did not run

`defer_until_reset` returns an automation contract; the calling Codex task must create the heartbeat and call `defer_automation_attach`. Confirm it targets the original task and uses the exact `resumeAt`/`automationPrompt`. The prompt must call `resume_prepare(trigger="automation")` first.

Distinguish three failures: no checkpoint (defer was never called or storage failed), checkpoint with no attached ID (creation/attachment was missed or rejected), and an attached heartbeat with no observed execution (host scheduler/runtime issue). An ACTIVE schedule alone is not proof it fired. Check host execution history, app/machine availability and whether the turn hit an upstream usage limit. Do not change unrelated automations while investigating.

An observed early-development incident reached preflight at only 1% remaining: checkpoint creation succeeded, then the turn failed with a usage-limit error before any automation-create call. The durable checkpoint survived, but the heartbeat was never created. This supports checking bounded implementation phases earlier, not treating time until reset as spare quota. The guard is advisory; no threshold can guarantee there is enough usage left for an unbounded turn.

## Reserve/secondary allowance is missing

The guard reports a usable secondary capability only when `account/rateLimits/read` supplies a recognized reserve bucket. The adapter currently recognizes the observed ID `base_model_inference`; callers select roles instead of depending on this ID or a display name. If the marker changes, an unlabelled bucket is not treated as interchangeable. Upgrade Codex and inspect `quota_status`; do not guess by model name or copy credentials. `available=true` means detected; obey preflight to determine whether it can actually admit work.

If `lanes.primary` is exhausted and `lanes.secondary` reports remaining allowance, use `sessionRole="lightweight"` (or `laneId="secondary"`) for small work. The primary task must continue to wait for `laneId="primary"`.

If the user resumed manually, call `resume_prepare(trigger="manual")` and best-effort delete only the returned automation IDs. The MCP never enumerates or cancels unrelated automations. If deletion fails, the superseded heartbeat safely exits when it later wakes.

## Profile threshold seems too high

Call `quota_profile` with `action: "get"` and inspect baseline, rolling mean, sample count, and override. Passive learning can be conservative when other Codex or shared agentic clients consume usage without calling `job_preflight`. Use `adjust` with a negative delta to lower the threshold, or `reset` to remove the persistent account-plan override.

## Node SQLite warning

Some supported Node releases still label `node:sqlite` experimental and print a warning to stderr. MCP JSON-RPC uses stdout, so this does not corrupt protocol traffic. Use a current Node LTS/current release and review Node release notes before suppressing warnings globally.

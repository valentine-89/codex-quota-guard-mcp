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

`defer_until_reset` returns an automation contract; the calling Codex task must create the heartbeat. Confirm the automation targets the original task and uses the exact `resumeAt`/`automationPrompt`. On wake, quota must be checked again.

## Node SQLite warning

Some supported Node releases still label `node:sqlite` experimental and print a warning to stderr. MCP JSON-RPC uses stdout, so this does not corrupt protocol traffic. Use a current Node LTS/current release and review Node release notes before suppressing warnings globally.

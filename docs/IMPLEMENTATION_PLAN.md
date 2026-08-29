# Implementation plan

## Goal

Build a local MCP server that reads Codex ChatGPT rate-limit windows through the installed `codex app-server`, shares one adaptive cache between concurrent Codex tasks, prevents long work from starting near exhaustion, and persists resumable checkpoints.

## Architecture

1. Start a short-lived `codex app-server --stdio` process only when the shared cache requires refresh.
2. Initialize JSON-RPC, then call `account/read` and `account/rateLimits/read`.
3. Normalize windows by duration (`300` minutes for five hours, `10080` for weekly) rather than by primary/secondary order.
4. Store snapshots, refresh leases, shared backoff state, and checkpoints in a user-state SQLite database.
5. Expose five MCP tools: `quota_status`, `job_preflight`, `checkpoint_create`, `checkpoint_get`, and `defer_until_reset`.
6. Return a resume time and automation prompt; Codex remains responsible for creating the heartbeat automation in the active task.

## Cache policy

| Remaining | Refresh TTL | Guard behavior |
| --- | ---: | --- |
| 51-100% | 15 minutes | Normal work |
| 21-50% | 5 minutes | Normal work, increased observation |
| 11-20% | 2 minutes | Caution before long work |
| 1-10% | 60 seconds | Defer long work and prepare a checkpoint |
| 0% | Reset time + 30 seconds | Checkpoint and defer |

Only one process may hold the refresh lease for a profile. Other processes return the cached snapshot with `refreshInProgress: true`. Shared exponential backoff with jitter prevents retry storms. No MCP tool accepts a force-refresh option.

## Security and compatibility

- Never read or copy `auth.json`, browser cookies, OAuth tokens, prompts, or responses.
- Let the official app-server own ChatGPT authentication and token refresh.
- Hash profile/account identity before persistence and redact error text before returning it.
- Return `CODEX_UPGRADE_REQUIRED` when `account/rateLimits/read` is unsupported. There is no direct OAuth fallback.
- Keep runtime state outside the repository and exclude all generated databases from source control.

## Delivery

- Node.js/TypeScript, MCP stdio transport, MIT license.
- Unit, integration, concurrency, failure, and live acceptance tests.
- Documentation for architecture, cache policy, checkpoint/resume, security, configuration, and troubleshooting.
- Prepare local commit and `v0.1.0` tag only after tests and secret scanning pass.
- Ask for explicit confirmation immediately before creating and pushing the public GitHub repository.

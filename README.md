# Codex Quota Guard MCP

`codex-quota-guard-mcp` is a local Model Context Protocol server that lets concurrent Codex tasks share one adaptive ChatGPT quota snapshot. It detects the current plan and runtime credit capability, learns passive part-job cost, prevents expensive work from starting near exhaustion, and stores resumable checkpoints. Version `0.2.0` also exposes independent `primary` and `secondary` quota roles so a lightweight session can use an explicitly reported reserve allowance while the primary session waits.

It does **not** read `auth.json`, copy OAuth tokens, scrape the Codex UI, route model traffic, or send telemetry.

## How it works

```text
Codex tasks ──MCP stdio──> quota guard processes
                              │
                              ├── shared SQLite cache/lease/backoff
                              │
                              └── one short-lived codex app-server refresh
                                      ├── account/read
                                      └── account/rateLimits/read
```

The five-hour window is identified by `windowDurationMins = 300`; longer windows are retained without assuming a weekly period or fixed slot order. The active/default bucket supplies `primary`; the separately identified reserve supplies `secondary`. The adapter currently recognizes the observed backend bucket ID `base_model_inference`, not a display/model name. This ID is not a guaranteed public role API: if it changes, unknown buckets remain informational and secondary work fails safe. Public callers use roles, so a model rename alone does not change the contract.

This is an **advisory admission guard**, not a background scheduler or a hard token limit. It cannot stop an in-flight turn, save a checkpoint after the agent loses access, or change the selected model. Install the agent instructions below so checkpoints are written at safe boundaries, before exhaustion.

## Requirements

- Node.js 22.13 or newer.
- An installed Codex CLI/app-server signed in with ChatGPT.
- A Codex version that supports `account/rateLimits/read`. Older versions return `CODEX_UPGRADE_REQUIRED`; direct OAuth fallback is intentionally unsupported.

## Install from source

```powershell
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
cd codex-quota-guard-mcp
npm ci
npm run check
```

The command is intentionally ordinary Node.js: no global package install and no credential copy is needed. An AI agent can follow this README from a repository link, run the four commands above, and register the absolute `dist/main.js` path below. `npm run check` includes typecheck, lint, tests, and a fresh build.

Register the built entrypoint in `%USERPROFILE%\.codex\config.toml` on Windows:

```toml
[mcp_servers.codex_quota_guard]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\to\codex-quota-guard-mcp\dist\main.js']
startup_timeout_sec = 30
```

Use equivalent absolute paths on Linux or macOS. Respect a custom `CODEX_HOME`; merge this entry without replacing other configuration. Merge [`examples/AGENTS-snippet.md`](examples/AGENTS-snippet.md) into the intended global or project `AGENTS.md`, preserving existing instructions. Then open a new Codex task so tools and instructions reload. Registration alone does not make an agent call the guard.

See [the complete install, upgrade and uninstall guide](docs/GETTING_STARTED.md). This repository is installed from source; it is not a published npm package. Installation does not require changing models or buying credits.

### First-run verification

1. Start a new Codex task after editing `config.toml`.
2. Call `quota_status` once. Confirm `stale=false`, `refreshInProgress=false`, and a usable path for the intended role. `source` may be `codex-app-server` or a valid shared `cache`; inspect `planType` and both `lanes` entries.
3. Before a bounded inspection, call `job_preflight` using a stable unique `jobId`, the current `taskId`, an absolute `workspaceRoot`, `jobClass: "small"`, and a short `description`. This writes an admission, not a token charge; retries reuse the ID.
4. For a long build/test/deploy, call `job_preflight` immediately before starting it. A `defer` result must be checkpointed and deferred; do not start the command.

`lanes.secondary.available` means a bucket was detected, not that it has spendable allowance. A lightweight task uses `jobClass: "small"` and `sessionRole: "lightweight"` (or `laneId: "secondary"`), then obeys the preflight decision. A primary task uses `laneId: "primary"` (the default). A missing or exhausted secondary lane never borrows primary allowance.

## Tools

| Tool | Purpose |
| --- | --- |
| `quota_status` | Return the shared quota snapshot; callers cannot force refresh. |
| `job_preflight` | Decide admission and record one idempotent passive part-job sample candidate. |
| `quota_profile` | Inspect, adjust, or reset the current account/plan threshold. |
| `checkpoint_create` | Store a bounded, redacted task checkpoint. |
| `checkpoint_get` | Retrieve a checkpoint by ID or latest workspace/task match. |
| `defer_until_reset` | Checkpoint and produce `resumeAt` plus a Codex heartbeat prompt. |
| `defer_automation_attach` | Bind the created heartbeat ID to its quota-owned defer record. |
| `resume_prepare` | Supersede manual defers or validate an automation wake before work. |

`defer_until_reset` prepares the automation contract. The calling Codex task must create the heartbeat and immediately attach its ID. On manual resume, `resume_prepare` returns only matching quota-guard automation IDs for best-effort deletion. A heartbeat whose defer was superseded exits without doing work. MCP itself does not control the Codex UI.

### Primary and secondary sessions

The role split is deliberately model-agnostic:

| Role | Source | Intended use | If absent/exhausted |
| --- | --- | --- | --- |
| `primary` | active/default bucket, unless explicitly identified as reserve | main work and long jobs | checkpoint/defer until its constraints clear |
| `secondary` | recognized backend reserve bucket | small/lightweight work while primary waits | do not borrow primary; return `defer` |

For example, when app-server reports primary five-hour remaining `0%` and a secondary long-window remaining `95%`, `quota_status` reports both facts. A lightweight preflight can be admitted on `secondary`; a primary preflight remains deferred. The guard does not select or rename the model used by Codex, and it cannot manufacture a reserve bucket when app-server does not report one.

## Plan profiles and passive learning

| Runtime plan family | Cold-start remaining threshold |
| --- | ---: |
| Free / Go | 20% |
| Plus / Team / fixed Business, Enterprise, Edu | 10% |
| Pro / Prolite | 5% |
| Unknown | 15% |

After three valid observations, the automatic threshold is `max(plan baseline, ceil(rolling mean × 1.5))`. The rolling window keeps 20 observations. The final threshold is `clamp(auto + user override, 1, 50)`. The override persists per Codex home + hashed account + plan until `quota_profile reset`. Positive adjustments stop earlier; negative adjustments allow work closer to exhaustion. These percentages are guard defaults, not OpenAI token allocations.

Passive learning divides the increase in five-hour usage between fresh snapshots by admissions in that interval. Zero-delta admissions accumulate; duplicates do not count again. Resets, account/plan changes, stale/backoff gaps, negative deltas and intervals with no admission are discarded. Homogeneous intervals train a job-class mean; mixed intervals train only the general mean. Secondary long-only allowances do not train a five-hour mean. Outside usage can overestimate cost; admitted jobs that consume no usage can underestimate it. Delayed reporting and overlapping jobs also introduce error: this is not exact accounting or a guarantee of completion.

When included usage is blocked, a job is admitted through `quotaPath: "credits"` only if app-server reports credits or unlimited usage and no individual/workspace spend control is exhausted. Such results are always `caution` and explicitly warn that credits may be consumed. Credit capability is evaluated independently for each reported role.

This runtime-first design follows the official OpenAI guidance that Codex usage varies by plan, model, task complexity, context, tools, and execution surface; eligible credits can extend usage, while flexible Enterprise/Edu plans may not use fixed rate limits. See [ChatGPT pricing](https://learn.chatgpt.com/docs/pricing), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-), and [Luna Reserve in Codex](https://help.openai.com/en/articles/20001499-luna-reserve-in-codex-and-chatgpt-work).

## Adaptive refresh policy

| Five-hour quota remaining | Shared TTL | Observation behavior |
| --- | ---: | --- |
| 51-100% | 15 minutes | Normal work |
| 21-50% | 5 minutes | Increased observation |
| 11-20% | 2 minutes | Profile-aware admission |
| 1-10% | 60 seconds | Profile-aware admission or credit bypass |
| 0% | Until reset + 30 seconds | Credit bypass or checkpoint/defer |

TTL is the minimum across detected role allowances, bounded by reported reset boundaries. A usable secondary role or credit path keeps refresh possible while primary waits. All roles, including credits, refuse new admissions on stale data. All tasks using the same Codex home/state database share the cache, lease, and backoff; expired leases recover after a crashed process. Refresh is caller-driven, not periodic polling.

## Configuration

Defaults require no configuration. To customize plan baselines, learning, a shorter automation ceiling (maximum 24 hours), or refresh behavior, set `CODEX_QUOTA_GUARD_CONFIG` to an absolute JSON file conforming to [`examples/config.schema.json`](examples/config.schema.json). v0.1 `warningRemainingPercent` and `deferRemainingPercent` are intentionally unsupported in v0.2. `CODEX_QUOTA_GUARD_STATE_DIR` selects the state directory unless `stateDir` is explicitly configured.

Default state locations:

- Windows: `%LOCALAPPDATA%\codex-quota-guard\state.sqlite`
- Linux/macOS: `$XDG_STATE_HOME/codex-quota-guard/state.sqlite`, falling back to `~/.local/state/...`

Run a live diagnostic (normal cache/lease writes; no admissions or automations):

```powershell
node dist/main.js --doctor
```

## Documentation

- [Getting started for humans and AI agents](docs/GETTING_STARTED.md)
- [MCP v0.2 API reference](docs/MCP_API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Cache policy](docs/CACHE_POLICY.md)
- [Checkpoint and resume](docs/CHECKPOINT_AND_RESUME.md)
- [Security](docs/SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Token-free scheduler bridge: verified probe and remaining work](docs/SCHEDULER_BRIDGE.md)

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). This project is licensed under the [MIT License](LICENSE).

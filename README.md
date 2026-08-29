# Codex Quota Guard MCP

`codex-quota-guard-mcp` is a local Model Context Protocol server that lets concurrent Codex tasks share one adaptive ChatGPT quota snapshot. It reads the installed Codex app-server's authenticated rate-limit API, prevents expensive work from starting near exhaustion, and stores resumable checkpoints.

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

The five-hour window is identified by `windowDurationMins = 300`; the weekly window is identified by `10080`. Slot order is not assumed.

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

Register the built entrypoint in `%USERPROFILE%\.codex\config.toml` on Windows:

```toml
[mcp_servers.codex_quota_guard]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\to\codex-quota-guard-mcp\dist\main.js']
startup_timeout_sec = 30
```

Use equivalent absolute paths on Linux or macOS, then open a new Codex task so the MCP tool inventory is refreshed. Add the policy in [`examples/AGENTS-snippet.md`](examples/AGENTS-snippet.md) to global or project instructions.

## Tools

| Tool | Purpose |
| --- | --- |
| `quota_status` | Return the shared quota snapshot; callers cannot force refresh. |
| `job_preflight` | Decide `allow`, `caution`, or `defer` before an expensive boundary. |
| `checkpoint_create` | Store a bounded, redacted task checkpoint. |
| `checkpoint_get` | Retrieve a checkpoint by ID or latest workspace/task match. |
| `defer_until_reset` | Checkpoint and produce `resumeAt` plus a Codex heartbeat prompt. |

`defer_until_reset` prepares the automation contract. The calling Codex task must use its built-in automation capability to schedule that prompt; MCP itself does not control the Codex UI.

## Adaptive refresh policy

| Five-hour quota remaining | Shared TTL | Guard behavior |
| --- | ---: | --- |
| 51-100% | 15 minutes | Normal work |
| 21-50% | 5 minutes | Increased observation |
| 11-20% | 2 minutes | Caution before long work |
| 1-10% | 60 seconds | Defer long work and checkpoint |
| 0% | Until reset + 30 seconds | Stop new work and defer |

All tasks using the same Codex profile share the same cache, lease, and backoff. A lease prevents simultaneous refreshes, while expired leases recover automatically after a crashed process.

## Configuration

Defaults require no configuration. To customize them, set `CODEX_QUOTA_GUARD_CONFIG` to an absolute JSON file conforming to [`examples/config.schema.json`](examples/config.schema.json). `CODEX_QUOTA_GUARD_STATE_DIR` overrides only the state directory.

Default state locations:

- Windows: `%LOCALAPPDATA%\codex-quota-guard\state.sqlite`
- Linux/macOS: `$XDG_STATE_HOME/codex-quota-guard/state.sqlite`, falling back to `~/.local/state/...`

Run a read-only live diagnostic:

```powershell
node dist/main.js --doctor
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Cache policy](docs/CACHE_POLICY.md)
- [Checkpoint and resume](docs/CHECKPOINT_AND_RESUME.md)
- [Security](docs/SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). This project is licensed under the [MIT License](LICENSE).

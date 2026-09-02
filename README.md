# Codex Quota Guard MCP 0.7.0

Quota Guard is a local MCP server that reads the current Codex ChatGPT quota through the official [`codex app-server`](https://learn.chatgpt.com/docs/app-server) interface, admits bounded work segments, and stores redacted checkpoints for resume. It never creates a login, accepts an API key, or reads Codex authentication files.

## Security and lifecycle guarantees

- Only the current stable `account.type === "chatgpt"` session is supported. API-key, Bedrock, signed-out, external-token and unstable identities return `CHATGPT_LOGIN_REQUIRED`; no quota percentage is read or cached for them.
- One authenticated `127.0.0.1` core owns SQLite and quota refresh for a Codex profile. Every Codex task gets only a small stdio connector.
- Connectors renew an in-memory lease every 20 seconds. A clean disconnect is observed immediately; a crashed connector expires after 60 seconds.
- The core exits about five seconds after the last connector disappears and no request or scheduler dispatch is active. Pending defers do not keep it alive.
- The five-minute early-recovery poll runs only when a connector is alive, a defer is waiting, and the current Codex task supplied a valid scheduler capability.
- There is no Scheduled Task, service, daemon, `launchd`, `systemd`, `wscript`, elevation request, Codex PID scan, browser login, or OAuth fallback.

## Requirements

- Node.js 22.13 or newer (Node 22 and 24 are CI-tested).
- A current Codex installation signed in with ChatGPT.
- PowerShell 7 (`pwsh`) on Windows, used only to apply a private user DACL; elevation is not requested.

Windows 10/11 on physical hardware or in a VM is treated identically. Windows x64 uses x64 Node/Codex; Windows ARM64 uses native ARM64 binaries or Windows' own compatibility layer. The Guard never detects Parallels, VMware, UTM, or the macOS host.

## Install

This project is not published to npm. Install it from its public GitHub checkout:

```powershell
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
cd codex-quota-guard-mcp
npm ci
npm run check
node scripts/install.mjs
```

The installer preserves unrelated `config.toml` content, creates a private local bearer and runtime settings, and registers the absolute Node executable with `dist/connector.js`. It does not start a persistent process. Restart or reconnect Codex after installation so it opens the new connector.

On a Windows machine that also uses WSL, run the installer with Windows Node from `pwsh`; both Windows and WSL tasks then use the Windows-hosted core and the same Windows profile. Native Linux and native macOS each use their own local Node, Codex login and state. Do not share Windows login/state with a macOS host.

## Uninstall

Remove only the MCP registration and stop an authenticated running managed core:

```text
node scripts/uninstall.mjs
```

Also delete the validated Guard-owned private state directory:

```text
node scripts/uninstall.mjs --purge
```

Both modes preserve unrelated Codex configuration and write a configuration backup. The purge refuses paths outside the recognized Guard-owned directory.

## MCP use

The public contract has eight tools:

- `quota_status`: call near the beginning of long work.
- `job_preflight`: call once, with a stable `jobId`, before each substantial token-consuming segment.
- `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare` support policy and controlled resume.

Do not call the Guard before every shell command, small file read, or trivial edit. No tool accepts credentials, a force-refresh flag, or a model name.

The MCP publishes concise server-wide `instructions` for portable cross-tool guidance. Individual tool descriptions remain self-contained, while the optional [Codex AGENTS snippet](examples/AGENTS-snippet.md) adds host-specific enforcement, Windows/WSL path handling, and heartbeat integration for Codex clients that support those features.

The registered STDIO connector and its authenticated loopback core require MCP `2026-07-28`. They use `server/discover`, per-request metadata, and strict modern-only Streamable HTTP routing; the removed `initialize`/`initialized` lifecycle is not accepted or emulated.

`quota_status.monitor` reports `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, and `lifecycleMode="codex-bound"`.

## Verification

```powershell
npm run check
npm run acceptance:install
npm audit
npm pack --dry-run
```

These portable checks run on Node 22/24 for Windows x64/ARM64, Ubuntu x64/ARM64, and macOS Intel/Apple Silicon in CI. `npm run acceptance:live` additionally verifies the currently installed registration and live quota on a signed-in host.

`npm run acceptance:shared` is a maintainer-only Windows desktop acceptance. It requires `CODEX_HOME`, the current real task ID in `QUOTA_PROBE_TASK_ID`, and an inherited desktop scheduler capability; it is not a portable installation check.

Release acceptance is recorded by guest OS. A Windows VM is simply a Windows acceptance result; there are no hypervisor-specific branches.

See [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [monitor behavior](docs/MONITOR.md), [Windows and WSL](docs/WINDOWS_AND_WSL.md), [MCP API](docs/MCP_API.md), and [troubleshooting](docs/TROUBLESHOOTING.md).

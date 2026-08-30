# Windows and WSL2

Choose one runtime host for each Codex home and database. The terminal appearance is
irrelevant: a WSL task may intentionally call the Windows-hosted Guard through WSL
interop, or it may run a fully Linux-native installation with separate state.

| Mode | Guard / Codex app-server | State and login | Use when |
| --- | --- | --- | --- |
| Managed Windows | Windows / Windows | Windows Codex home | Codex Desktop native tasks |
| Managed Windows from WSL | Windows / Windows | Same Windows home and SQLite | Desktop switches native/WSL agent mode |
| Linux-native WSL | Linux / Linux | Separate Linux home and SQLite | Independent Linux CLI/IDE workflow |

Never open one SQLite WAL database from both Windows and Linux, copy authentication
files between homes, or start Linux Codex against an active Windows Codex home.

## Managed Windows host

Keep the checkout on a Windows-accessible path and run with PowerShell 7 plus Windows
Node:

```powershell
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
Set-Location .\codex-quota-guard-mcp
npm ci
npm run check
node scripts/install-managed.mjs
```

The installer registers `node.exe dist/http-connector.js`, one shared Windows core,
and a least-privilege no-console recovery probe. It forwards only the named desktop
capability variables and managed settings path through `WSLENV`; their values are not
persisted by Guard. See [Managed deployment](MANAGED_CORE.md) for scheduler setup,
private state and lifecycle details.

From a new Windows task, call `quota_status`, then preflight a small read-only job.
To smoke the exact registered connector from the checkout:

```powershell
node scripts/registered-smoke.mjs
```

Do not terminate already-open tasks merely because they still have an older MCP
connection. New registration applies when a task opens a new connection.

## Windows-hosted calls from WSL

First verify WSL can launch Windows executables:

```bash
node.exe --version
wslpath -w "$PWD"
```

Use the second command's Windows path as `workspaceRoot` for every Guard call and
retain it in checkpoints and resume. Keep build commands in the native WSL working
directory; Guard stores identity only and does not execute those commands.

Test the registered Windows connector through interop from PowerShell:

```powershell
node scripts/registered-smoke.mjs --wsl
```

If `node.exe` returns `Exec format error` or `/proc/sys/fs/binfmt_misc/WSLInterop` is
absent, Windows executable interoperability is unavailable. Guard cannot repair it
inside a task. Do not restart WSL while unrelated Linux work is active, modify system
interop settings without permission, or fall back to a second core using Windows
state. Preserve work and let the user choose a maintenance window.

## Linux-native WSL

Use a checkout under the Linux filesystem with Linux Node and Linux Codex. Do not
reuse Windows `node_modules`; native dependencies are platform-specific.

```bash
command -v node
node --version
command -v codex
codex --version
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
cd codex-quota-guard-mcp
npm ci
npm run check
```

Register absolute Linux paths in that Linux client's Codex config:

```toml
[mcp_servers.codex_quota_guard]
command = '/absolute/path/to/linux/node'
args = ['/absolute/path/to/codex-quota-guard-mcp/dist/main.js']
startup_timeout_sec = 30

[mcp_servers.codex_quota_guard.env]
CODEX_HOME = '/home/YOUR_USER/.codex'
CODEX_CLI_PATH = '/absolute/path/to/linux/codex'
```

The Linux Codex profile must be signed in to ChatGPT. A Windows npm shim under
`/mnt/c/...`, an API-key-only Linux login, or filesystem access to Windows Codex
state is not a substitute. Run `node dist/main.js --doctor` and
`node scripts/live-acceptance.mjs --summary` before use.

The managed Windows scheduler bridge is not available to Linux-native Node through
a Windows named pipe. Direct stdio quota protection and checkpointing still work;
use the host's supported automation capability or report a manual resume time.

## Cross-platform acceptance rules

- Use `--isolated` only when temporary config/state paths belong to the server host.
  Run an isolated Windows-hosted acceptance from Windows, not Linux.
- A fresh shared-cache result is valid; do not bypass lease/backoff to force another
  upstream quota read.
- Verify all eight tools, `stale=false`, the intended role, and a real preflight.
- A quota read does not prove scheduler capability. Check `quota_status.monitor`
  separately and preserve the original heartbeat when the bridge is unavailable.
- Never change Wi-Fi, copy credentials, request elevation or restart Codex/WSL just
  to obtain a cleaner smoke result.

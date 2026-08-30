# Windows and WSL2

## Choose the process host, not the terminal appearance

The Codex agent environment and integrated terminal are separate settings.
Changing the agent from native Windows to WSL requires an app restart; opening a
WSL terminal alone does not change the agent. See the official
[Windows app guide](https://learn.chatgpt.com/docs/windows/windows-app) and
[WSL guide](https://learn.chatgpt.com/docs/windows/wsl).

| Installation | MCP process / app-server | Profile and guard state | Use case |
| --- | --- | --- | --- |
| Windows-hosted launcher, native caller | Windows / Windows | Windows | Desktop native mode |
| Same launcher, WSL2 caller | Windows through WSL interop / Windows | Same Windows profile and cache | Switch desktop agent modes without changing guard host |
| Linux-native WSL | Linux / Linux | WSL ChatGPT profile, Linux-local SQLite | Independent Linux CLI/IDE workflow |

The host is an explicit installation choice, not an automatic credential or
old-version fallback. Do not start Linux Codex against a Windows Codex home that
an active Windows desktop is using. Do not share a WAL database across the two
OS runtimes. The Windows-hosted option shares state safely by keeping **every
database reader/writer on Windows**, even when calls arrive from Linux.

## Recommended: Windows-hosted guard for both desktop modes

Keep the checkout on a Windows drive. Build it using Windows Node:

```powershell
git clone https://github.com/valentine-89/codex-quota-guard-mcp.git
Set-Location .\codex-quota-guard-mcp
npm ci
npm run check
Get-Command node.exe
Get-Command codex.cmd
```

Locate the intended Windows Codex home (`CODEX_HOME` when explicitly set,
otherwise the Windows user's `.codex`). The official CLI must be signed in to
ChatGPT there. Prefer an installed CLI path that survives app updates; if using a
versioned bundled executable, reverify its path after desktop upgrades.

Merge this entry into the **actual config loaded by Codex**, replacing all paths
with verified ones. Do not overwrite unrelated entries or assume a WSL-backed
desktop reads the same config as a standalone WSL CLI.

```toml
[mcp_servers.codex_quota_guard]
command = 'cmd.exe'
args = ['/d', '/s', '/c', 'call', 'D:\tools\codex-quota-guard-mcp\scripts\start-windows.cmd']
startup_timeout_sec = 30

[mcp_servers.codex_quota_guard.env]
CODEX_QUOTA_GUARD_NODE = 'C:\Program Files\nodejs\node.exe'
CODEX_HOME = 'C:\Users\YOUR_USER\.codex'
CODEX_CLI_PATH = 'C:\Users\YOUR_USER\AppData\Roaming\npm\codex.cmd'
WSLENV = 'CODEX_QUOTA_GUARD_NODE/w:CODEX_HOME/w:CODEX_CLI_PATH/w:CODEX_QUOTA_GUARD_CONFIG/w:CODEX_QUOTA_GUARD_STATE_DIR/w'
```

`WSLENV` forwards these explicitly selected Windows values when a WSL process
starts `cmd.exe`; `/w` means Linux-to-Windows, and absence of `/p` keeps Windows
paths unchanged. Merge any already-required `WSLENV` entries rather than dropping
them. This is scoped to the MCP child; do not change the global user environment.
Optional guard JSON/config/state paths must also be Windows paths. No `WSLENV`
setting is needed for native Windows execution, but this entry is harmless there.

The launcher uses the configured Windows Node, or `node.exe` on the Windows PATH
if omitted. It forwards stdio and exit status, emits no banners on stdout, and
does not create a background service. It never selects a different login.

In WSL, verify `command -v cmd.exe` and Windows executable interoperability. If
your MCP launch environment omits the Windows PATH, use the verified absolute
mounted `cmd.exe` path in that WSL registration (commonly
`/mnt/c/Windows/System32/cmd.exe`); do not guess mount points. Disabled interop
prevents the Windows-hosted mode. Do not silently change system settings to fix it.

### Workspace identity

When a WSL task calls a **Windows-hosted** guard, obtain the Windows workspace
root once and use it consistently for every tool call and resume:

```bash
wslpath -w "$PWD"
```

For `/mnt/d/project` this yields a drive path; a Linux filesystem workspace yields
a `\\wsl.localhost\<distro>\...` UNC path. Pass that returned string as
`workspaceRoot`, not the POSIX spelling. The guard identifies checkpoints but
does not execute build commands in that directory. Keep actual shell commands
in the task's native working directory. For an existing checkpoint, keep its
stored workspace root; do not rewrite it when switching shells.

Merge the [agent snippet](../examples/AGENTS-snippet.md). Reopen the task after
registration. Do not restart the whole desktop during somebody else's active
work merely to test a mode switch.

### Verify both callers

From Windows, test the launcher itself:

```powershell
& .\scripts\start-windows.cmd --doctor
node scripts/live-acceptance.mjs --summary --command cmd.exe --args-json '["/d","/s","/c","call","D:\\tools\\codex-quota-guard-mcp\\scripts\\start-windows.cmd"]'
```

From WSL, test the same Windows process:

```bash
cmd.exe /d /s /c call 'D:\tools\codex-quota-guard-mcp\scripts\start-windows.cmd' --doctor
```

Use the same explicit environment as the MCP entry when running these commands;
a plain terminal does not automatically load MCP environment settings. In a
fresh WSL-backed Codex task, verify all eight tools and call `quota_status`.
Expect `stale=false`, `refreshInProgress=false`, the correct plan and both role
entries. A fresh shared cache is valid evidence; do not force extra refreshes.

`scripts/live-acceptance.mjs` can also run from a Linux checkout with Linux Node
and use `--command /mnt/c/Windows/System32/cmd.exe` plus the same args JSON to
verify the cross-OS MCP protocol. Do **not** use `--isolated` on a Linux caller
launching a Windows server: that option creates host-local paths. If isolation
is needed, run acceptance from Windows so its temporary config/state are Windows
paths. This restriction is checked before starting the server for `.exe` commands.

## Linux-native WSL installation

Use a separate checkout under the Linux home and install dependencies with Linux
Node. Do not reuse Windows `node_modules` (dependencies such as esbuild have
platform-specific binaries).

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

If `codex` resolves into Windows npm under `/mnt/c/.../AppData/Roaming/npm`, it is
not a Linux Codex installation. Select/install the official Linux CLI following
the [WSL instructions](https://learn.chatgpt.com/docs/windows/wsl), and verify its
version. Do not substitute an older bundled binary automatically.

Register absolute **Linux** Node, entrypoint and CLI paths in the WSL client's
actual Codex config:

```toml
[mcp_servers.codex_quota_guard]
command = '/home/YOUR_USER/.nvm/versions/node/vXX.YY.Z/bin/node'
args = ['/home/YOUR_USER/tools/codex-quota-guard-mcp/dist/main.js']
startup_timeout_sec = 30

[mcp_servers.codex_quota_guard.env]
CODEX_HOME = '/home/YOUR_USER/.codex'
CODEX_CLI_PATH = '/absolute/path/to/linux/codex'
```

Do not put Windows drive paths in Linux configuration or Linux paths in the
Windows-hosted configuration. An NVM shell initialization file may not run when
MCP starts; absolute executable paths avoid dependence on it. Use POSIX
`workspaceRoot` values for this native Linux installation.

Then run `node dist/main.js --doctor` and
`node scripts/live-acceptance.mjs --summary`. The official Linux profile must be
signed in to **ChatGPT**, not only an API key. If authentication is missing or the
wrong type, ask the user to complete the official login; do not read, copy, or
rewrite credentials. Keep guard state on the Linux filesystem.

## Scheduler bridge and zero-inference monitoring

The guard's quota tools do not depend on the experimental scheduler bridge.
The [scheduler report](SCHEDULER_BRIDGE.md) records standalone schedule mutation
on Windows. A WSL caller can also reach that shipped desktop MCP by launching
its **Windows** Node runtime through interop, matching the installed desktop's
observed approach. Linux Node cannot directly use a Windows named pipe.

Read-only diagnostic through the launcher:

```powershell
& .\scripts\start-windows.cmd --scheduler-bridge-doctor 'C:\actual\installed\codex-app-tools\version\server.mjs'
```

For a WSL caller use `cmd.exe /d /s /c call` with that same launcher and arguments.
It requires the real desktop-supplied `CODEX_APP_TOOLS_PIPE_PATH` to reach the
Windows child. Forward only that existing capability using process-scoped
`WSLENV` (no `/p` path translation); never synthesize, print, save, or scan for its
value. A shell launched outside desktop may have no capability. Do not treat a
successful quota read as proof of scheduler availability.

The diagnostic only lists tools. It cannot start work or consume inference
tokens. The five-minute background recovery monitor is **not implemented in
v0.2.0**; publishing this guide does not enable it. Do not install a periodic AI
heartbeat as a substitute. Future integration must test capability inheritance
into MCP, all-tasks-idle lifetime, restart, ownership and manual-resume races.

## Acceptance record — 2026-08-30

- Windows Node 24.14.0: full check (48 tests) and live v0.2 MCP handshake against the official
  Windows app-server; primary and secondary quota roles present.
- Ubuntu 22.04 WSL2, Linux Node 24.15.0: full check (48 tests) in a separate Linux-local
  directory with Linux dependencies; real subprocess tests included.
- Linux MCP client -> Windows launcher: eight-tool handshake and fresh shared
  quota succeeded using the same Windows profile/cache as the native caller.
- WSL interop -> Windows scheduler diagnostic: shipped MCP inventory succeeded;
  automation_update advertised. No automation mutation or model turn in this test.
- Linux-native live ChatGPT quota was **not accepted on this machine**: the
  existing Linux profile reports API-key authentication. The available bundled
  Linux CLI was 0.145.0-alpha.30; accessing the active Windows Codex home from that
  CLI failed SQLite initialization. No credentials or desktop state were modified
  to work around it. Use the verified Windows-hosted mode here.
- Switching/restarting the active desktop itself was not tested, to avoid
  interrupting other tasks. The tested boundary is real MCP stdio from Windows
  and Linux clients, not a claim that every desktop release/configuration works.

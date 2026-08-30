# Managed Windows/WSL deployment

This is the recommended installation for Codex Desktop on Windows, including tasks
that switch between native Windows and WSL agent mode. One authenticated loopback
core owns quota policy, SQLite state and the recovery monitor. Each Codex task gets
only a small stdio wire connector.

The managed deployment is per Windows user. It does not install a Windows service,
request elevation, copy credentials, or expose a LAN port. Linux/macOS and fully
Linux-native WSL should use the direct stdio route in [Getting started](GETTING_STARTED.md).

## Install

Use PowerShell 7 and Windows Node from the repository checkout:

```powershell
npm ci
npm run check
node scripts/install-managed.mjs
```

The installer:

- creates a private `%CODEX_HOME%\quota-guard\managed-<home-key>` directory;
- writes a random local bearer secret and runtime settings readable only by the user;
- registers `node.exe dist/http-connector.js` without `cmd.exe` or PowerShell wrappers;
- creates one least-privilege per-user Scheduled Task using `wscript.exe //B` so no
  console window appears; and
- merges only `mcp_servers.codex_quota_guard`, preserving unrelated Codex settings.

Open a new Codex task after installation. Existing tasks retain their already-open
MCP process; the installer does not terminate Codex or unrelated processes.

### Enable early-recovery scheduling

Quota reads work without the scheduler bridge. Early advancement of an attached
heartbeat additionally needs the trusted `codex-app-tools` server shipped with the
installed Codex app and the desktop-provided capability inherited by a new task.
Do not download a replacement server or search for pipe values.

Before the first managed install, an agent may locate the versioned shipped server
under the current user's plugin cache and verify its schema:

```powershell
$pluginRoot = Join-Path $env:USERPROFILE '.codex\plugins\cache\openai-bundled\codex-app-tools'
$schedulerServer = Get-ChildItem -LiteralPath $pluginRoot -Recurse -Filter server.mjs -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $schedulerServer) { throw 'Installed codex-app-tools server.mjs was not found' }
node scripts/scheduler-bridge-doctor.mjs --server $schedulerServer.FullName
$env:CODEX_QUOTA_GUARD_SCHEDULER_SERVER = $schedulerServer.FullName
node scripts/install-managed.mjs
```

The discovery is based on the installed plugin location, not a hard-coded version.
The diagnostic lists tools only and does not read quota, change an automation or
start a model turn. If the plugin is absent or verification fails, keep quota tools
installed and report `monitor.available=false`; do not invent a private fallback.
After a Codex/plugin upgrade changes this path, update the Guard configuration in a
controlled maintenance window and reinstall; never point executable configuration
at an untrusted file.

## Runtime lifecycle

- Connectors authenticate to `127.0.0.1` with the protected local secret. Exact
  Host/Origin checks, bounded requests and an exclusive SQLite ownership lock prevent
  an accidental second core for the same installation.
- Concurrent connector starts elect one core. A conflicting or wrong listener fails
  closed; the connector never launches a full per-task Guard fallback or kills a peer.
- A new desktop connector can renew the scheduler capability in memory. Pipe values
  are never written to the settings file, command line, logs or checkpoint data.
- The Scheduled Task checks at logon and every five minutes, but starts a missing
  core only when SQLite contains an attached active defer. It performs no quota read
  and no model invocation by itself.
- With an attached defer, the core remains available for token-free monitoring. With
  no recovery work and no authenticated activity, it exits after `managedIdleMs`
  (default five minutes). The next MCP request transparently restarts it.
- Neither the probe nor the core runs while the Windows session is signed out or the
  machine is asleep. ChatGPT account logout/login inside an active desktop session is
  supported and is evaluated on the next quota refresh. Scheduler delivery after an
  OS wake/sign-in is best-effort.

The task uses the current user token at the lowest run level. It stores no password,
has no network-share or administrator permission, and uses the built-in GUI-subsystem
launcher only to suppress a console window. A configured Codex `.cmd` executable may
still run as a hidden child during an actual quota refresh; all child starts use the
Windows no-window flag.

## Windows-hosted WSL

The installer adds only the required values to `WSLENV`. A WSL task runs the same
Windows `node.exe` connector, Windows Codex profile and Windows-owned database. Use:

```bash
wslpath -w "$PWD"
```

as `workspaceRoot` for every Guard tool call and retain that spelling on resume.
Windows executable interoperability must already work (`node.exe --version`). If it
does not, do not copy credentials or silently start a Linux core against Windows
state. See [Windows and WSL](WINDOWS_AND_WSL.md).

## Upgrade and removal

Pull the intended release, run `npm ci`, `npm run check`, then rerun
`node scripts/install-managed.mjs`. The installer migrates an older managed database
with SQLite's online backup, retires only its ownership-marked endpoint/task, and
preserves checkpoints and profiles. Open a new task after the upgrade.

To remove only this installation's supervisor, use the exact settings path printed
by the installer:

```powershell
pwsh -NoProfile -NonInteractive -File scripts/managed-supervisor.ps1 -Remove -SettingsPath 'C:\absolute\managed-home-key\runtime.json'
```

Removing the MCP registration, Guard state, checkout and owned Codex heartbeats are
separate actions. Do not delete them unless the user requests that scope.

## Verification boundary

Automated coverage exercises concurrent bootstrap, authentication and HTTP bounds,
ownership-lock crash recovery, private settings, no-console supervisor registration,
idle shutdown, recovery-only startup and capability replacement. Run:

```powershell
npm run check
node scripts/managed-install-acceptance.mjs
node scripts/registered-smoke.mjs
```

`registered-smoke.mjs --wsl` additionally verifies the registered Windows connector
through WSL interop when that host feature is available. A successful quota smoke is
not proof of a real early automation wake. Reboot, full desktop restart, sleep/wake
and future plugin compatibility remain host acceptance boundaries; the integration
fails closed and preserves the original heartbeat schedule when capability is absent.

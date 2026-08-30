# Managed shared core deployment

Version0.5 managed deployment is the recommended Windows-hosted route for Windows
and WSL callers. It keeps the local service/store/monitor singleton while retaining
bounded wire connectors per stdio task. Do not interpret connection smokes as proof
of a desktop restart, reboot, sleep/wake or real automation wake.

## Installation (Windows host, also for WSL callers)

Build with `npm ci` and `npm run check`. Use Windows Node and PowerShell 7.
Preserve the existing Codex home, quota state/config, CLI path and trusted shipped
scheduler-server path. Follow [MONITOR.md](MONITOR.md) to obtain those paths from
the existing installation; do not discover or synthesize desktop pipe addresses.

After an explicit migration decision, run:

```powershell
node scripts/install-managed.mjs
```

The installer provisions a private `quota-guard/managed-<home-key>` directory under
the canonical Codex home. Windows ACLs allow only the installing user; native POSIX
provisioning requires user ownership and modes0700/0600. `runtime.json` contains
an independent random local bearer secret and trusted executable/config paths.
It is not an OpenAI credential. Never print, commit or send this file. The managed
SQLite database is kept in the same private directory so both the Codex process and
the external per-user supervisor see one physical path. LocalAppData is not used for
managed state because packaged desktop processes can virtualize that directory.

The port is allocated by the OS once and persisted. This avoids Windows/Hyper-V
reserved-port ranges. Later conflicts fail closed; the guard does not kill the
listener or silently move to a different port. Core identity must match the
protected installation ID, in addition to authenticating the bearer.

Deployment order is provision, healthy core, per-user supervisor, then MCP
registration. A protected backup of Codex configuration is retained. Unrelated
configuration is preserved and checked. Unsupported TOML layouts or concurrent
edits cause registration to remain unchanged. A failure can leave a provisioned
core/supervisor: inspect the installation, do not assume rollback occurred.

The registered command is `node.exe` with `dist/http-connector.js`, with a60-second
startup deadline and only a managed-settings **path** in config. It does not launch
`cmd.exe`, PowerShell, or another console shell. The desktop pipe and task ID are
inherited through `env_vars`, never saved as values. Normal WSL executable interop
resolves the same Windows `node.exe`; `/w` forwarding retains Windows paths and the
same home/state. No native WSL listener or second database.

Existing connected stdio sessions are not killed. New connections use the shared
core. There is no automatic full-guard fallback. One wire-only Node connector per
stdio connection remains; only the service/store/monitor is singleton. Deliberately
using different state directories creates separate installations.

Upgrading an older managed installation retires its old settings endpoint, stops
only the core PID authenticated by that endpoint, removes only its ownership-marked
supervisor, and copies SQLite with the native online-backup API into the new private
location. Existing guard policy/scheduler configuration is carried forward with
the canonical home and new state path. This preserves cache/checkpoints/defer data
without copying credentials.
Already-connected old wire adapters then fail closed instead of recreating the
retired core; open a fresh Codex task after upgrade.

## Recovery and scheduler capability

- Connectors start a missing core; an exclusive OS-released SQLite lock elects one
  winner from concurrent startup attempts before loading the full runtime.
- The Windows task `CodexQuotaGuard-<installation-id>` performs a bounded local
  check at user logon and every5 minutes while logged in. It uses the existing user
  token at lowest run level, with no password or elevation. Its action is the Windows
  GUI-subsystem `wscript.exe //B`, which launches the fixed Node probe with window
  style0; no console process or interactive prompt is created.
- The scheduled probe starts a missing core only when SQLite contains an attached,
  active quota-guard defer. With no such recovery work it exits immediately. Health
  requests do not read quota and do not extend the core idle deadline.
- When no authenticated request or pending recovery exists, the managed core exits
  after `managedIdleMs` (default5 minutes). The next wire request restarts it. An
  attached defer prevents idle shutdown so token-free monitoring can continue.
- A newly connected desktop connector forwards its already-inherited capability
  through authenticated `/desktop-session` (4KiB maximum), in memory only. The core
  accepts no executable/server path from HTTP.
- Candidate capabilities must pass the shipped server identity/schema check and
  a read-only `list_threads` request in the supplied task context. Replacement is
  serialized with scheduler dispatch. Rejection preserves the previous capability.
- A restarted core cannot recover a desktop pipe from disk. Until a connector
  supplies a valid one, quota tools can work but early scheduling is unavailable;
  the original heartbeat schedule remains. Reopening Codex alone is not proof that
  a new MCP connection has been established.
- Responses lost during restart are not replayed. Retry admission with the same
  `jobId`; never assume a timed-out mutation did not happen.

The supervisor is a local Windows task, **not** an AI polling heartbeat. To remove
only this installation's supervisor:

```powershell
pwsh -NoProfile -NonInteractive -File scripts/managed-supervisor.ps1 -Remove -SettingsPath 'C:\absolute\managed-home-key\runtime.json'
```

Removal verifies its ownership marker, preserves quota/checkpoint/settings data,
and does not terminate the running core or unrelated tasks. Removing the MCP
registration is a separate explicit action. Do not restore an entire old Codex
config over later user edits.

## Evidence and remaining acceptance

Initial managed acceptance on2026-08-30 passed82 tests; v0.5 weekly-only coverage
raised the Windows and isolated native WSL suite to91 passing tests. v0.5.1 adds
no-console registration, idle-stop and recovery-only supervisor regressions. Managed tests
coverage proves six concurrent bootstrap requests, crash/lock recovery, wrong
listener rejection, private settings validation, bounded authenticated binding,
and serialized capability replacement using fixtures. Windows provisioning applied
a single-user protected ACL without elevation. An isolated real user task ran the
shipped health starter with `LastTaskResult=0` and authenticated shared-core health;
the exact fixture task/core were subsequently removed/stopped. The disposable
`node scripts/managed-install-acceptance.mjs` installed twice, retained the same
core, preserved unrelated Codex configuration/comments, and kept the secret out
of that config. It removed its own supervisor/core/state afterwards. ACL updates
modify only DACL, avoiding an unnecessary audit/owner privilege on reinstallation.

Production acceptance on2026-08-30 switched the registered launcher without closing
existing sessions, bound the real desktop scheduler capability, and restarted only
the authenticated installation-owned core after the v0.5 build. Fresh Windows and
Windows-hosted WSL clients both reported v0.5.0, the same weekly-only snapshot,
`runtimeMode=shared-http`, `requiresLiveClientConnection=false`, and monitor available.
The per-user supervisor ran again with least privilege and retained the same healthy
PID. Reboot, actual desktop restart, sleep/wake and a real early heartbeat through the
managed core are not yet established. Prior v0.3 real-wake evidence remains separate.
One later repeat found the distro's own `WSLInterop` binfmt entry absent, so even a
plain Windows `cmd.exe` could not start; the distro was not forcibly restarted. See
[troubleshooting](TROUBLESHOOTING.md) and keep this host failure distinct from the
earlier successful v0.5 Windows-hosted WSL connection and final native-Linux tests.

On the current host, registering an S4U task without additional user rights returned
`E_ACCESSDENIED`. The installer does not request elevation or grant batch-logon rights.
It instead uses the ordinary least-privilege user token with the built-in no-console
launcher described above. This is a deliberate privilege boundary, not a hidden
administrative service.

v0.5.1 production acceptance migrated the prior virtualized LocalAppData database,
retired its old endpoint, and left exactly one ownership-marked supervisor. Its real
run reported `LastTaskResult=0`, `RunLevel=0`, `Hidden=true`, action `wscript.exe`,
and no cmd/PowerShell argument. After the authenticated core PID was stopped with
`pendingRecords=0`, a supervisor run returned0 and left health absent; a fresh MCP
request then restarted one v0.5.1 core and returned the same weekly-only profile.
Two older already-connected `cmd.exe` wire wrappers remained owned by existing Codex
tasks and were not killed. Their creation times predated deployment; new registration
contains no shell wrapper. A repeat Windows-hosted WSL smoke remained blocked by the
distro's missing `WSLInterop` (`Exec format error`); no WSL restart was forced.

# Shared HTTP core (experimental, v0.4)

Follow-up implementation: [managed bootstrap, supervision and capability renewal](MANAGED_CORE.md).
The status below records the original v0.4 transport acceptance; managed deployment
has its own explicit acceptance checklist and does not inherit untested claims.

Status: transport, shared state, bounded resource handling, no-client timer and
Windows-hosted WSL connector verified. **Not the default installation.** No service,
startup registration, auto-bootstrap, or migration of existing connections is installed.
An agent installing from README must not replace the normal launcher automatically.

## Why a shared core

The default stdio launch creates a full guard for each MCP connection. SQLite leases
already deduplicate quota reads but do not eliminate per-process memory/timers.
The shared core instead owns one service/store/monitor, while HTTP requests get
short-lived MCP protocol objects. No in-memory MCP session registry grows with tasks.

```text
Codex HTTP clients -------------------------+
Windows/WSL stdio -> wire-only connector ----+-> one Windows HTTP core
                                                -> shared quota policy + SQLite
                                                -> timer + shipped scheduler bridge
```

The wire connector still costs one Node process per stdio connection; this is not
a promise of a single OS process overall or measured RAM savings. Official
app-server and scheduler children may also run. Direct HTTP avoids connector processes.

## Runtime contract

- `dist/http-main.js`: shared server; binds **127.0.0.1 only**. A held exclusive
  transaction in `core-<home-key>.sqlite` prevents another HTTP core for the same
  configured state directory/home, even if it selects a different port. The OS
  releases the lock on crash. No PID scan, peer kill or stale-lock deletion.
- Use one configured state directory for one Codex home. Deliberately using
  different state directories creates separate deployments; this is not a global
  machine-wide process cap. Existing stdio servers do not acquire the HTTP lock.
- `CODEX_QUOTA_GUARD_HTTP_PORT`: required integer, 1024–65535. Port conflicts fail;
  the core does not move silently to a different address or kill the port owner.
- `CODEX_QUOTA_GUARD_HTTP_TOKEN`: required random base64url secret, 32–256 characters.
  Generate with `randomBytes(32).toString('base64url')`. This is a **local guard secret**,
  never an OpenAI token. Do not print it, put it in a URL/argument/log, or commit it.
- `/mcp` accepts authenticated JSON-RPC POST. GET/DELETE return405; response JSON
  is used instead of persistent SSE. Host must exactly match `127.0.0.1:<port>`;
  a supplied Origin must match that loopback origin. No broad CORS allowance.
- `/health` is authenticated and returns process/runtime/monitor diagnostics, not
  the token or desktop capability. Health checks do not read quota.
- Bounds:32 concurrent MCP requests,64 TCP connections,1 MiB request body,
  32 headers,10-second header timeout,60-second request deadline,5-second keepalive.
  Overload returns503; an in-flight operation retains its work slot after its client
  disconnects. A lost response is not proof that the mutation did not execute.
- Core shutdown drains work with a five-second process deadline. Checkpoints,
  admission IDs, leases/backoff and defer fencing retain their existing semantics.

`quota_status.monitor.runtimeMode` is `stdio` or `shared-http`.
`requiresLiveClientConnection=false` in shared mode; `requiresLiveMcpProcess=true`
still means the server process must be alive. Neither field promises a supervisor.
Closing the last client does not stop the HTTP core. Stop it explicitly when no
longer needed; zero defers means the monitor does not poll the quota backend.

## Controlled setup, not one-command unattended installation

1. Build with `npm ci` and `npm run check`.
2. Choose a free loopback port and configure a random local secret in the launching
   process environment. Deliver the same secret to clients through protected local
   configuration/environment. There is currently no bundled secret provisioner or
   supervisor; do not solve this by writing secrets into a shared project file.
3. Start `node dist/http-main.js` with the existing Windows guard configuration.
   For early recovery, the launching process must already have the real desktop
   capability and trusted scheduler-server path described in [MONITOR.md](MONITOR.md).
   Starting from an ordinary login task does not establish this capability.
4. For native HTTP clients, configure `url="http://127.0.0.1:<port>/mcp"` and
   `bearer_token_env_var="CODEX_QUOTA_GUARD_HTTP_TOKEN"`. Ensure that variable is
   available to the **Codex client process**, not just a shell opened afterwards.
5. For the stdio connector, set `CODEX_QUOTA_GUARD_HTTP_URL` to the same URL and
   provide the same token. Run `node dist/http-connector.js` directly. The core must already run.
   The connector validates loopback URL, refuses redirects, preserves JSON-RPC
   fields, bounds concurrency/output backlog, and exits with its client.
6. Confirm eight tools, fresh quota, `runtimeMode=shared-http` and the required lane.
   A missing core returns an error; the connector never launches the old full guard.

Do not switch a live default deployment without a migration decision. No old MCP
session is forcibly closed by this release. Configuring HTTP does not make Codex
start, restart or supervise this application.

## Windows / WSL

The tested route uses Windows Node for the core **and** connector, including when
the caller runs in WSL. It uses the same Windows Codex home and SQLite. Forward
the connector URL/token via process-scoped WSLENV; never translate a Windows pipe
or copy login files. This route needs neither mirrored networking nor a LAN listener.

Native Linux-to-Windows `localhost` reachability depends on WSL networking mode;
that direct route is not claimed by the interop test. Native Linux core regression
tests use separate Linux dependencies/state. Do not reuse Windows `node_modules`
for Linux tests (esbuild is platform-specific), or a Windows account database with
native Linux Codex merely because its filesystem is reachable.

## Scheduler capability: what was actually verified

On2026-08-30, a Windows child with ignored stdin hosted the HTTP core. Six SDK
clients initialized/listed eight tools and used one fresh quota snapshot; all closed.
The core stayed alive. Within that same child, a new standard MCP connection to
the shipped desktop server successfully called its read-only `list_threads` tool
with the real task metadata. No model turn or scheduler mutation was requested.
The Windows wire connector and WSL-to-Windows launcher then reused that snapshot.

This proves **inherited capability works after HTTP-client disconnect**, not that
a desktop restart renews it. The current bridge is a runtime-verified shipped
interface, not a documented stable external scheduler API. Do not discover pipe
addresses, persist them, or remove host authorization checks.

The real Codex app-server HTTP client also discovered a disposable fixture tool
using both `bearer_token_env_var` and `env_http_headers` authentication, in an empty
isolated Codex home. This handshake required no login, model turn or quota RPC.
The header experiment supplies only a generated local guard secret: it does not
establish that the desktop pipe variable is available or renewed in that environment.
This version does not accept scheduler capabilities or executable server paths from
HTTP headers; desktop capability bootstrap remains a separate acceptance gate.

## Reproduce acceptance

Automated: `npm run check`. HTTP coverage includes cache/admission sharing across
six clients, auth/Origin/Host/payload rejection, overload after disconnect, connector
EOF, lock conflict/crash release, and timer dispatch before any HTTP MCP initialization.
The timer regression uses a disposable fixture and never mutates a real automation.

From Windows desktop context, with `CODEX_HOME` pointing to the actual Windows home
and `QUOTA_PROBE_TASK_ID` set to this real task:

```powershell
npm run acceptance:shared
npm run acceptance:shared -- --wsl
node scripts/codex-http-smoke.mjs
```

The harness reads only the registered guard configuration, inherits existing
capability, isolates guard state, generates an in-memory local secret, runs one
fresh app-server read per invocation, and removes its temporary state/processes.
It never reads auth files, changes registration, forces the production cache,
creates an admission, or changes an automation. Do not run it as a polling loop.

The separate `codex-http-smoke.mjs` uses an empty disposable Codex home and a
single-tool transport fixture. It calls only app-server initialize and MCP inventory,
not account/quota methods. The temporary configuration stores environment variable
names, not secret values. This is actual Codex HTTP-client acceptance, not a desktop
restart or full eight-tool guard invocation through a desktop UI session.

On2026-08-30 the78-test suite passed on Windows Node24.14.0 and native WSL Linux
Node24.15.0, with platform-specific dependencies installed in an isolated Linux copy.
Final live smokes reported guard version0.4.0 and fresh primary/secondary snapshots.

## Before making this the default

Required next acceptance: coordinated bootstrap/secret storage, daemon crash/reboot
restart, desktop capability reacquisition, sleep/wake, a full desktop shared-core
deployment, and a separately authorized real early heartbeat through
the shared core. Keep the existing real v0.3 wake evidence separate from these probes.
Replacing the default launcher and selecting any old-version compatibility/fallback
requires an explicit user decision. Never silently downgrade when a core is unavailable.

References: [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[existing monitor acceptance](MONITOR.md), [scheduler boundary](SCHEDULER_BRIDGE.md).

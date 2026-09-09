# Architecture

`dist/connector.js` is the only MCP entrypoint registered with Codex. It contains no SQLite store, policy engine, app-server client, or scheduler state. It forwards the stable MCP STDIO handshake and requests to the authenticated loopback core, while retaining routing for internal `2026-07-28` clients. It registers an in-memory client lease at startup, before any tool call, renews every 20 seconds, and unregisters on normal shutdown.

The first connector starts `dist/core.js` on demand from private runtime settings. Concurrent starts race on the same exclusive OS/SQLite ownership lock; only one core wins. The core binds only `127.0.0.1`, requires the private bearer, validates Host and Origin, and creates request-scoped MCP protocol objects around one shared service/store. Its Streamable HTTP endpoint accepts the stable handshake and modern per-request discovery. Connector startup attempts Desktop binding when inherited context is available; later tool calls can renew binding. Discovery does not itself read quota.

If the saved port fails to bind with `EACCES`, the lock-owning managed core binds an OS-selected port and atomically updates private settings. Bootstrap clients reread settings while awaiting health. Identity, credentials and quota state remain unchanged. Occupied, unauthenticated or mismatched endpoints are not replaced.

The core has three kinds of temporary work: authenticated requests, scheduler dispatch, and live connector leases. With none active, it shuts down after about five seconds. A crashed connector's lease expires after 60 seconds. A durable defer is data, not a process-lifetime reason.

Quota refresh starts a short-lived `codex app-server --stdio` child, performs `account/read(refreshToken:false)`, validates stable ChatGPT identity, reads rate limits, re-reads identity, and terminates the child. SQLite provides single-flight refresh, cache, backoff, admission, checkpoint and defer ownership.

There is no direct full-runtime stdio deployment, supervisor, Scheduled Task, service, daemon, launchd/systemd unit, or Codex PID discovery.

## Extension IPC adapter

The core also owns an unreferenced IPC scheduler timer. Authenticated connector headers carry inherited task identity and a live client lease into request-local context. Tool arguments cannot bind another task. Windows extension contexts use the versioned follower IPC adapter; Desktop contexts retain their host scheduler. Additive schema 6 stores IPC wake ownership and pre-send uncertainty. No existing Desktop defer is converted. See [IPC resume](IPC_RESUME.md).

# Architecture

`dist/connector.js` is the only MCP entrypoint registered with Codex. It contains no SQLite store, policy engine, app-server client, or scheduler state. It forwards the stable MCP STDIO handshake and requests to the authenticated loopback core, while retaining routing for internal `2026-07-28` clients. It registers an in-memory client lease only when a capability is called, renews every 20 seconds, and unregisters on normal shutdown.

The first connector starts `dist/core.js` on demand from private runtime settings. Concurrent starts race on the same exclusive OS/SQLite ownership lock; only one core wins. The core binds only `127.0.0.1`, requires the private bearer, validates Host and Origin, and creates request-scoped MCP protocol objects around one shared service/store. Its Streamable HTTP endpoint accepts the stable handshake and modern per-request discovery. Discovery starts no quota read and performs no scheduler binding; a relevant tool call triggers those capabilities on demand.

The core has three kinds of temporary work: authenticated requests, scheduler dispatch, and live connector leases. With none active, it shuts down after about five seconds. A crashed connector's lease expires after 60 seconds. A durable defer is data, not a process-lifetime reason.

Quota refresh starts a short-lived `codex app-server --stdio` child, performs `account/read(refreshToken:false)`, validates stable ChatGPT identity, reads rate limits, re-reads identity, and terminates the child. SQLite provides single-flight refresh, cache, backoff, admission, checkpoint and defer ownership.

There is no direct full-runtime stdio deployment, supervisor, Scheduled Task, service, daemon, launchd/systemd unit, or Codex PID discovery.

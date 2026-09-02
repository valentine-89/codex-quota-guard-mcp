# On-demand shared core

The shared core is Codex-bound, not OS-managed. `scripts/install.mjs` provisions private settings and registers `node + dist/connector.js`; it does not create or start a Scheduled Task, service, daemon, login item, launchd agent, or systemd unit.

Each connector calls the authenticated health endpoint and starts the configured `dist/core.js` only when no verified listener exists. An unexpected or wrong listener is not killed. Concurrent bootstraps are resolved by the exclusive core lock.

Connector leases live only in RAM. Renewal is 20 seconds, expiry is 60 seconds, and normal unregister is immediate. The core shuts down after approximately five seconds with no clients, active HTTP requests, or scheduler dispatch. A crash is therefore bounded by lease expiry plus shutdown grace.

Use `node scripts/uninstall.mjs` to remove registration, or add `--purge` to delete validated Guard-owned state.

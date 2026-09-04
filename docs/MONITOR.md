# Early-recovery monitor

Early recovery exists only to notice a quota reset earlier than the original heartbeat. Its interval is five minutes and there is no public force-refresh input.

A poll is allowed only when all three conditions hold:

1. At least one connector lease is alive.
2. At least one active defer remains in the waiting stage.
3. The current Codex task supplied a valid scheduler capability.

The capability transport is platform-specific: a Windows named pipe on Windows or an absolute Unix-domain socket path on Linux/macOS. It is never accepted from a tool input and becomes available only after the Codex task context is verified. `CODEX_QUOTA_GUARD_SCHEDULER_SERVER` may be supplied through the install environment or Codex host environment; the installer forwards it but never discovers or guesses a private application path.

The poll uses one short-lived app-server child and the normal shared cache/lease/backoff path. SQLite claims make multiple ticks or bootstrap contenders idempotent. Scheduler dispatch is fenced and advances an owned heartbeat at most once; an uncertain acknowledgement is never replayed automatically.

When Codex closes, connector leases disappear and polling/dispatch stops. The original heartbeat remains unchanged for Codex to process when it is active again. Pending defer records never keep the core alive and no OS scheduler restarts it.

`quota_status.monitor` includes `intervalMs`, pending state, last/next poll, `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, `lifecycleMode="codex-bound"`, and current `liveClients`.

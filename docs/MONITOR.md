# Early-recovery monitor

Early recovery exists only to notice a quota reset earlier than the original heartbeat. Its interval is five minutes and there is no public force-refresh input.

Recovery also recognizes a different signed-in account or quota mode through normal fresh quota reads. Weekly-only allowance uses its own threshold, not a conversion to five-hour percent. Connector lease maintenance retries failed Desktop binding while idle (without reading quota); a successful binding is revalidated at most once per minute. The lease is registered before slow Desktop negotiation. One rejected task does not invalidate other verified tasks.

Desktop recovery requires an attached, owned heartbeat with a captured unchanged definition. A saved checkpoint/defer without an attached heartbeat cannot wake a task. `stage=scheduled` means the host schedule update was confirmed, not that a task turn has started; `resume_prepare` confirms consumption. No extra polling heartbeat is created.

A poll is allowed only when all three conditions hold:

1. At least one connector lease is alive.
2. At least one active defer remains in the waiting stage.
3. The current Codex task supplied a valid scheduler capability.

The host provides a Windows named pipe or Unix socket in memory. Scheduler discovery runs at startup and each bounded binding, using live host resources, the registered Windows package or standard macOS resources. Paths are never persisted. No saved-path or legacy server override fallback is supported. Stable MCP capability and task-context validation remain mandatory.

The poll uses one short-lived app-server child and the normal shared cache/lease/backoff path. SQLite claims make multiple ticks or bootstrap contenders idempotent. Scheduler dispatch is fenced and advances an owned heartbeat at most once; an uncertain acknowledgement is never replayed automatically.

When Codex closes, connector leases disappear and polling/dispatch stops. The original heartbeat remains unchanged for Codex to process when it is active again. Pending defer records never keep the core alive and no OS scheduler restarts it.

`quota_status.monitor` includes `intervalMs`, pending state, last/next poll, `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, `lifecycleMode="codex-bound"`, and current `liveClients`.

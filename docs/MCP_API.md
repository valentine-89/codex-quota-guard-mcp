# MCP API 0.8.0

The public STDIO connector supports stable MCP through `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. The shared HTTP core also supports MCP `2026-07-28` discovery for internal clients and validates its required routing headers against the request body. Both protocol paths expose the same instructions, eight tool names, schemas, and shared service implementation.

The server exposes exactly eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

When a defer is schedulable, `defer_until_reset` returns a complete `automationRequest` for direct passthrough to the host `automation_update` tool. It contains the same-task one-shot schedule, ownership-bearing name, active heartbeat fields, and the fixed `Continue the work.` prompt. Callers must not inspect existing automations, browse scheduler documentation, or rewrite this request before creation. The request is `null` when `canSchedule=false`; creation and ID attachment remain separate confirmation boundaries.

The server also publishes MCP-wide `instructions` with the portable cross-tool sequence. These instructions are advisory because MCP clients may ignore them. Tool descriptions therefore retain local call semantics; the provided AGENTS snippet remains optional for deployments that have separately demonstrated a need for host-specific enforcement or scheduler integration.

Call `quota_status` near the start of long work. Call `job_preflight` once with a stable `jobId` before each substantial token-consuming segment. Do not call either tool before every command, small read, or individual file edit.

`quota_status` has no refresh parameter. When a detected lane is already in caution/defer state and the previous successful read is more than 30 seconds old, the server may refresh through its normal shared lease and backoff before answering. Healthy quota and other callers use the adaptive cache TTL. No new background reader is added; the existing attached-defer monitor retains its bounded five-minute cadence and stops without a live connector.

No tool accepts credentials, direct OAuth data, API keys, model names, or force refresh. `quota_status` returns unavailable quota and `CHATGPT_LOGIN_REQUIRED` for unsupported auth. Every preflight then returns `defer`.

Successful tool output is duplicated in text and `structuredContent`. Operational quota failures are represented by a fail-safe snapshot with `error`; validation/mutation errors set MCP `isError=true` with a bounded `{error:{code,message}}` payload.

Monitor metadata is fixed to the shared runtime: `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, and `lifecycleMode="codex-bound"`.

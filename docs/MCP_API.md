# MCP API 0.7.2

The server implements MCP `2026-07-28` only. Clients discover capabilities and server-wide instructions with `server/discover`; each request carries its protocol version, client metadata, and capabilities. The shared HTTP core validates `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` headers against the request body. Legacy `initialize`/`initialized` traffic is rejected rather than downgraded.

The server exposes exactly eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

When a defer is schedulable, `defer_until_reset` returns a complete `automationRequest` for direct passthrough to the host `automation_update` tool. It contains the same-task one-shot schedule, ownership-bearing name, active heartbeat fields, and the fixed `Continue the work.` prompt. Callers must not inspect existing automations, browse scheduler documentation, or rewrite this request before creation. The request is `null` when `canSchedule=false`; creation and ID attachment remain separate confirmation boundaries.

The server also publishes MCP-wide `instructions` with the portable cross-tool sequence. These instructions are advisory because MCP clients may ignore them. Tool descriptions therefore retain local call semantics, and Codex deployments should keep the provided AGENTS snippet for host-specific enforcement and scheduler integration.

Call `quota_status` near the start of long work. Call `job_preflight` once with a stable `jobId` before each substantial token-consuming segment. Do not call either tool before every command, small read, or individual file edit.

No tool accepts credentials, direct OAuth data, API keys, model names, or force refresh. `quota_status` returns unavailable quota and `CHATGPT_LOGIN_REQUIRED` for unsupported auth. Every preflight then returns `defer`.

Successful tool output is duplicated in text and `structuredContent`. Operational quota failures are represented by a fail-safe snapshot with `error`; validation/mutation errors set MCP `isError=true` with a bounded `{error:{code,message}}` payload.

Monitor metadata is fixed to the shared runtime: `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, and `lifecycleMode="codex-bound"`.

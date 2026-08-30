# MCP API 0.6.0

The server exposes exactly eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

Call `quota_status` near the start of long work. Call `job_preflight` once with a stable `jobId` before each substantial token-consuming segment. Do not call either tool before every command, small read, or individual file edit.

No tool accepts credentials, direct OAuth data, API keys, model names, or force refresh. `quota_status` returns unavailable quota and `CHATGPT_LOGIN_REQUIRED` for unsupported auth. Every preflight then returns `defer`.

Successful tool output is duplicated in text and `structuredContent`. Operational quota failures are represented by a fail-safe snapshot with `error`; validation/mutation errors set MCP `isError=true` with a bounded `{error:{code,message}}` payload.

Monitor metadata is fixed to the shared runtime: `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, and `lifecycleMode="codex-bound"`.

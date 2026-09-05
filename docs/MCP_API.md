# MCP API 1.1.0

The public STDIO connector supports stable MCP through `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. The shared HTTP core also supports MCP `2026-07-28` discovery for internal clients and validates its required routing headers against the request body. Both protocol paths expose the same instructions, eight tool names, schemas, and shared service implementation.

Server instructions require a quota check by `checkAgainBy` at tool boundaries during active work, independently of checkpoint persistence. Do not start an unsplittable model operation beyond that deadline. MCP cannot interrupt a running generation or enforce client compliance.

The server exposes exactly eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

`quota_status` and `job_preflight` require `agentProtocol="auto-reset-v1"`. Calls without it return `AUTO_RESET_AGENT_REQUIRED`; this is the intentional v1 breaking boundary.

`quota_status` accepts an optional proof-bound `resetFollowup` containing the exact `recommendationId`, `idempotencyKey`, and host outcome (`reset`, `alreadyRedeemed`, `noCredit`, `nothingToReset`, or `uncertain`). It is not a general force-refresh input. A definitive consumed result rechecks quota after 3, then 5, then 10 additional seconds through the shared lease/backoff path and stops early when the weekly epoch changes or remaining quota increases.

When local `automaticWeeklyReset.enabled` is true and all eligibility conditions hold, `quota_status.resetCredit.recommendation` instructs the agent to call the host `consume_usage_reset` tool with the exact idempotency key without another confirmation. Only valid, unexpired `codexRateLimits` banked resets qualify. The thresholds are Free/Go 5%, Plus 2%, and 1% for every other recognized plan; the reported weekly reset must be strictly more than 72 hours away. Unknown plans, missing inventory, stale quota, refresh/backoff, and account ambiguity never recommend a reset. The MCP cannot buy a reset or credits and does not call the host tool itself.

When a defer is schedulable, `defer_until_reset` returns a complete `automationRequest` for direct passthrough to the host `automation_update` tool. It contains the same-task one-shot schedule, ownership-bearing name, active heartbeat fields, and the fixed `Continue the work.` prompt. Callers must not inspect existing automations, browse scheduler documentation, or rewrite this request before creation. The request is `null` when `canSchedule=false`; creation and ID attachment remain separate confirmation boundaries.

The server also publishes MCP-wide `instructions` with the portable cross-tool sequence. These instructions are advisory because MCP clients may ignore them. Tool descriptions therefore retain local call semantics; the provided AGENTS snippet remains optional for deployments that have separately demonstrated a need for host-specific enforcement or scheduler integration.

Call `quota_status` near the start of long work. Call `job_preflight` once with a stable `jobId` before each substantial token-consuming segment. Do not call either tool before every command, small read, or individual file edit.

`quota_status` has no refresh parameter. Both interactive status and preflight cap shared cache age at 30 seconds while cold, rapidly consuming quota (at least 1 percentage point/minute after a 1.5 safety multiplier), or near a limit; stable observations relax to 60 seconds. Lease, single-flight and backoff still apply. Deadlines are anchored to the successful backend read, so repeatedly reading cache cannot extend permission. No idle polling or background reader is added; the attached-defer monitor keeps its existing cadence.

`quota_status.pacing` reports each lane's `confidence`, `sampleCount`, conservative `burnRatePercentPerMinute`, `minutesToReserve`, `reservePercent`, `checkAgainBy`, `maxSegmentMinutes` and `reason`. Top-level `checkAgainBy` refers to the active lane. Rates measure aggregate account usage, including other sessions; they are estimates, not token measurements or reservations. Zero observed change does not imply unlimited runway. Each fixed window is measured separately; the earliest estimated reserve horizon bounds work.

`job_preflight` also returns `canStartSegment`, `validUntil`, `checkAgainBy`, `maxSegmentMinutes` and `checkpointRequired`. **A caution/allow decision does not override `canStartSegment=false`.** Split and preflight a shorter segment, or wait for a new check; do not execute the oversized segment. An oversized request does not record an admission. `estimatedMinutes` means active Codex work, excluding detached GPU/process wait time. Without an estimate, the returned maximum still applies. Save a concise checkpoint before expensive work, including job/PID, output location and resume instructions for detached jobs. The existing weekly-advisory and credit semantics remain (no forecast-based defer or automatic scheduling); deadlines still bound active work on every path. A timely preflight also counts as the due quota check, avoiding redundant paired calls.

Short-term rate state is persisted separately from job-cost learning in SQLite schema 5. Only fresh backend samples count; cache hits do not. Account, plan, bucket, window topology, reset epoch changes, quota increases, backend failure, and gaps over 15 minutes invalidate the applicable chain. Rate forecasts expire after 5 minutes without a fresh sample; after a break resume/preflight requests revalidate via the same bounded refresh path. Unknown or changed state starts cold (30-second segments) until fresh samples arrive. Two intervals yield `ready`; up to four recent interval rates contribute, using their maximum times 1.5. The reserve is at least 5% or the existing lane threshold, whichever is higher. Observed account changes are handled; switches not yet reported by the backend cannot be detected in advance.

The 1.1 trial does not consume resets or buy credits itself, nor does it guarantee timely checks inside a long model generation. Follow `checkAgainBy` opportunistically at tool boundaries and evaluate real-session logs before tuning these initial constants.

No tool accepts credentials, direct OAuth data, API keys, model names, or force refresh. `quota_status` returns unavailable quota and `CHATGPT_LOGIN_REQUIRED` for unsupported auth. Every preflight then returns `defer`.

Successful tool output is duplicated in text and `structuredContent`. Operational quota failures are represented by a fail-safe snapshot with `error`; validation/mutation errors set MCP `isError=true` with a bounded `{error:{code,message}}` payload.

Monitor metadata is fixed to the shared runtime: `runtimeMode="shared-http"`, `requiresLiveClientConnection=true`, and `lifecycleMode="codex-bound"`.

# MCP API 2.0.0

`quota_status` defaults to `detail="compact"` (`format="compact-v1"`). Use `detail="full"` for the original v1 snapshot; this option does not trigger a refresh. Both text and structured output contain the same data, with minified JSON text.

Compact output keeps active windows, policy and safety fields at the root. `limits` holds active credits and individual limits. A lane with `quotaRef="root"` uses that data; a missing lane profile inherits root `profile`. Distinct lane buckets and profiles remain inline. `longWindows` contains only windows beyond `weekly`; extra buckets are in `otherBuckets`. Unavailable lanes retain `available=false` and their reason, without redundant pacing. Reset recommendations, keys, follow-ups, errors and deadlines are unchanged. Other tools retain their existing data layout.

Quota Guard exposes eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

Call `quota_status` near the start of a long task. Before each substantial segment, call `job_preflight` with `agentProtocol="auto-reset-v1"` and a stable `jobId`. A preflight call also counts as the quota check for that step.

During active work, follow `checkAgainBy`. Preflight returns `canStartSegment`, `validUntil`, `maxSegmentMinutes`, and `checkpointRequired`. If `canStartSegment=false`, split the work and preflight again. Save a short checkpoint before expensive or detached GPU work. The MCP cannot interrupt a running model generation.

Pacing starts conservatively, then learns from fresh backend samples. It resets after an account, plan, quota bucket, reset window, or quota increase changes; errors and long breaks also reset it. Cache hits do not create samples. `quota_status.pacing` contains the estimate and deadline for each lane.

Quota checks use shared cache, single-flight refresh, lease, and backoff. There is no public force-refresh input and no idle polling. Estimates are advisory and cannot guarantee that a long model generation will finish before quota exhaustion.

Automatic banked-reset use is opt-in. When enabled, Guard emits a recommendation only for a valid reset, an eligible plan, low weekly quota, and a reset more than 72 hours away. The host performs the reset; Guard never buys credits or reads auth files.

See [Getting started](GETTING_STARTED.md) and [README](../README.md).

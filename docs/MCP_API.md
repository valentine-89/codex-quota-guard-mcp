# MCP API 1.1.0

Quota Guard exposes eight tools: `quota_status`, `job_preflight`, `quota_profile`, `checkpoint_create`, `checkpoint_get`, `defer_until_reset`, `defer_automation_attach`, and `resume_prepare`.

Call `quota_status` near the start of a long task. Before each substantial segment, call `job_preflight` with `agentProtocol="auto-reset-v1"` and a stable `jobId`. A preflight call also counts as the quota check for that step.

During active work, follow `checkAgainBy`. Preflight returns `canStartSegment`, `validUntil`, `maxSegmentMinutes`, and `checkpointRequired`. If `canStartSegment=false`, split the work and preflight again. Save a short checkpoint before expensive or detached GPU work. The MCP cannot interrupt a running model generation.

Pacing starts conservatively, then learns from fresh backend samples. It resets after an account, plan, quota bucket, reset window, or quota increase changes; errors and long breaks also reset it. Cache hits do not create samples. `quota_status.pacing` contains the estimate and deadline for each lane.

Quota checks use shared cache, single-flight refresh, lease, and backoff. There is no public force-refresh input and no idle polling. Estimates are advisory and cannot guarantee that a long model generation will finish before quota exhaustion.

Automatic banked-reset use is opt-in. When enabled, Guard emits a recommendation only for a valid reset, an eligible plan, low weekly quota, and a reset more than 72 hours away. The host performs the reset; Guard never buys credits or reads auth files.

See [Getting started](GETTING_STARTED.md) and [README](../README.md).

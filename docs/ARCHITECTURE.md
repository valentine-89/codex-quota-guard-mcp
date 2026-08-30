# Architecture

## Components

- `CodexAppServerClient` starts a short-lived official app-server, initializes JSON-RPC, reads account metadata and rate-limit windows, then terminates the child. It never reads auth files.
- `QuotaGuardService` applies cache, lease, backoff, plan profiles, passive learning, admission, and defer/resume policies.
- `StateStore` owns additive v0.2 SQLite persistence for cache/checkpoints plus samples, account-plan overrides, idempotent admissions, and quota-owned defer records.
- `mcp-server` exposes eight bounded stdio tools.
- `ProcessLifetime` owns stream/transport shutdown, a local parent-existence check,
  a60-second initialization deadline and a5-second shutdown ceiling. It terminates
  only its own MCP instance, never evicts a healthy initialized idle session, and
  starts the monitor only after initialization.
- `QuotaMonitor` coordinates five-minute quota checks using durable SQLite lease generations; `DesktopSchedulerBridge` advances only exact attached heartbeats through the installed OpenAI MCP server. Local cleanup runs independently of quota reads. See [monitor lifecycle](MONITOR.md).

## Refresh sequence

1. Hash the canonical Codex home to select the shared profile cache.
2. Return a fresh snapshot immediately when its adaptive TTL has not expired.
3. Return a stale snapshot while shared backoff is active.
4. Atomically acquire a refresh lease. Non-owners return cache with `refreshInProgress=true`.
5. Start `codex app-server --stdio`, send `initialize`, `account/read`, and `account/rateLimits/read`; re-read account metadata and reject an observed account change.
6. Normalize the active bucket, explicitly labelled secondary/reserve buckets, credits, spend controls, and arbitrary long windows; feed a valid fresh five-hour delta into passive learning.
7. Decorate the snapshot with the current account-plan profile, store it, clear backoff, and release the lease.

The cache profile key is derived from the normalized Codex home. The account fingerprint is a SHA-256 hash of account type and normalized email. It scopes overrides, admissions and learning; the email itself is never persisted. Missing account identity prevents a recorded admission or profile mutation. An account/plan change invalidates pending intervals and never reuses another profile's mean or override.

## Admission learning

Each non-deferred `job_preflight` inserts an idempotent admission keyed by profile, account, plan, role/limit bucket, and caller job ID. Pending admissions accumulate until a later fresh snapshot reports a positive five-hour delta. The delta is divided by the pending count and stored in a 20-observation rolling mean. Homogeneous intervals also update the matching job-class mean; mixed intervals update only the global mean. Reset epochs and identity changes isolate samples automatically. Secondary buckets with only weekly/long windows are admitted from that window but do not fabricate a five-hour learning sample.

## Defer ownership

Every `defer_until_reset` creates a local defer UUID linked to its checkpoint. Codex attaches the heartbeat ID after creation; ownership is immutable and cannot be assigned to another defer. Manual resume atomically supersedes active records matching Codex home, workspace, task and role (optionally a specific defer ID) before quota revalidation. Returned IDs are best-effort cancellation hints. An automation wake must name its defer UUID; early, wrong-scope, missing or superseded wakes exit. A due wake atomically claims the record as `fired`, so duplicate invocations cannot run it twice.

SQLite `user_version=3` migrations are transactional and additive, adding monitor deadlines and a recovery outbox. Old cache/checkpoint rows survive. Rolling samples are bounded per account/plan/bucket/class; idempotency records and checkpoints persist. Guard processes share WAL, a busy timeout and leases. Do not run older binaries against migrated state for ongoing work.

## Failure model

RPC errors are reduced to bounded error codes/messages. A missing rate-limit method becomes `CODEX_UPGRADE_REQUIRED`. Failures update a shared backoff record so concurrent tasks cannot create retry storms. Existing snapshots remain available with `stale=true`.

MCP cannot interrupt hidden model reasoning or a command already running. `job_preflight` therefore guards the boundary immediately before expensive, hard-to-stop work.

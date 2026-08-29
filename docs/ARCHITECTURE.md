# Architecture

## Components

- `CodexAppServerClient` starts a short-lived official app-server, initializes JSON-RPC, reads account metadata and rate-limit windows, then terminates the child.
- `QuotaGuardService` applies cache, lease, backoff, normalization, recommendation, and checkpoint policies.
- `StateStore` owns SQLite WAL persistence shared by every MCP process using the same Codex profile.
- `mcp-server` exposes the five bounded stdio tools.

## Refresh sequence

1. Hash the canonical Codex home to select the shared profile cache.
2. Return a fresh snapshot immediately when its adaptive TTL has not expired.
3. Return a stale snapshot while shared backoff is active.
4. Atomically acquire a refresh lease. Non-owners return cache with `refreshInProgress=true`.
5. Start `codex app-server --stdio`, send `initialize`, `account/read`, and `account/rateLimits/read`.
6. Normalize windows by duration, compute recommendation/TTL, store the snapshot, clear backoff, and release the lease.

The cache profile key is derived from the canonical Codex home. The account fingerprint is a SHA-256 hash of account type and normalized email and is stored only for diagnostics/invalidation evolution; the email itself is never persisted.

## Failure model

RPC errors are reduced to bounded error codes/messages. A missing rate-limit method becomes `CODEX_UPGRADE_REQUIRED`. Failures update a shared backoff record so concurrent tasks cannot create retry storms. Existing snapshots remain available with `stale=true`.

MCP cannot interrupt hidden model reasoning or a command already running. `job_preflight` therefore guards the boundary immediately before expensive, hard-to-stop work.

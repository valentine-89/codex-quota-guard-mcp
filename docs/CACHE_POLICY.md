# Cache policy

The state database uses SQLite WAL, normal synchronous mode, a five-second busy timeout, atomic transactions, and process-independent leases.

## Adaptive TTL

High remaining quota changes slowly and is refreshed at most every 15 minutes. Refresh frequency increases as remaining quota falls. At zero, the next permitted refresh is the backend reset timestamp plus the configured grace period, preventing pointless polling while blocked.

No MCP input can force a refresh. A diagnostic run follows the same cache policy.

## Single-flight lease

Lease acquisition uses `BEGIN IMMEDIATE`, removes an expired lease for the profile, and inserts only when no owner exists. The default lease lasts 30 seconds. A crashed owner cannot block later refreshes indefinitely.

## Shared backoff

- Rate-limit failures: 1, 2, 5, 10, then 15 minutes.
- Server/timeout failures: 1, 2, then 5 minutes.
- Other failures: 30 seconds, 1 minute, then 2 minutes.
- Backend retry timing takes precedence when supplied.
- Locally calculated delays use ±20% jitter.

The backoff record is shared by all tasks and cleared only after a successful refresh.

## Stale safety

A stale snapshot is labeled, never presented as current. Long jobs are deferred when the five-hour quota is unknown or when a low-quota snapshot is stale. Small bounded work may continue with a caution decision unless the backend reports exhaustion.

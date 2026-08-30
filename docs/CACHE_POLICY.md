# Cache policy

The state database uses SQLite WAL, normal synchronous mode, a five-second busy timeout, atomic transactions, and process-independent leases.

## Adaptive TTL

With defaults, high remaining quota is refreshed no more often than every 15 minutes; lower bands use 5 minutes, 2 minutes and 1 minute. A zero allowance can sleep until its reset plus grace. Shared TTL is the minimum across detected role allowances and their reset boundaries; a usable secondary role keeps refresh possible while primary is exhausted. Runtime credits cap TTL at the warning interval. No background timer polls: a caller must request status at or after that deadline.

No MCP input exposes a generic force-refresh switch. A manual or validated due-automation `resume_prepare` may expire a deferred selected-role snapshot after the configured minimum age, then uses the same shared lease/backoff for controlled revalidation. It cannot bypass an active backoff. A diagnostic follows normal cache policy. A passed reset marks cached data stale; reset grace never means old quota is fresh.

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

A stale snapshot or in-progress refresh cannot admit any new job, including secondary or credit-backed work. These gaps invalidate pending learning intervals, not previously accepted samples. The next successful refresh establishes a new observation baseline.

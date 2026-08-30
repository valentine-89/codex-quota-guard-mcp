# v0.2 implementation record

## Goal

Make quota admission plan-aware and adaptive without reading Codex credentials or adding a public force-refresh path. Preserve local v0.1 cache/checkpoint state while intentionally replacing the MCP/config interface.

## Delivered architecture

1. Read `account/read` and the active `account/rateLimits/read` snapshot from the installed official app-server.
2. Normalize the five-hour window, arbitrary longer windows, credits/unlimited capability, individual limits, spend control, and metered limit ID.
3. Select cold-start thresholds by runtime plan family and learn rolling passive part-job cost from idempotent preflight admissions and later fresh quota deltas.
4. Persist account-plan overrides, samples, observations, admissions, checkpoints, and quota-owned defer lifecycle in additive SQLite v2 tables.
5. Admit through included usage or a backend-confirmed credit path; never infer that unrelated limit buckets are interchangeable.
6. Always checkpoint blocked work. Schedule only resets within 24 hours, attach the created heartbeat ID, and supersede matching defers before manual resume.
7. Keep quota roles model-agnostic: the active/default bucket is `primary`; an explicitly labelled reserve bucket is `secondary`. Lightweight admission never substitutes an unlabelled bucket.

## Safety invariants

- The official app-server owns authentication and refresh; auth files and OAuth tokens remain outside this process.
- Cache refresh remains single-flight, adaptive, and protected by shared backoff.
- Manual resume can request one semantic revalidation of an old exhausted snapshot but cannot force arbitrary polling.
- Automation cancellation IDs come only from quota-guard records matching profile, workspace, and task. Superseded heartbeats exit without work.
- Passive learning rejects stale, reset, negative-delta, cross-account, cross-plan, and duplicate-admission data.

## Acceptance

- Typecheck, ESLint, unit/integration tests, and production build run through `npm run check`.
- Live acceptance starts the built stdio MCP, lists all v0.2 tools, and reads the real app-server quota without accessing credentials.
- The deployed local Codex registration points directly at the rebuilt `dist/main.js`.

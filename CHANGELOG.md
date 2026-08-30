# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

## [0.4.0] - 2026-08-30

### Added

- Opt-in authenticated loopback Streamable HTTP core, sharing one quota service,
  store and monitor across request-scoped MCP transports. No unbounded session map.
- Exclusive core ownership lock in the configured guard state directory, released
  by the OS on process death; conflicting starts fail without terminating a peer.
- Bounded HTTP requests/connections/body size, Host/Origin validation, random local
  bearer-secret requirement, and no automatic replay of unconfirmed mutations.
- Wire-only stdio connector, including a Windows launcher callable through WSL.
  It has no quota/store/scheduler instances and never starts a fallback full guard.
- Runtime diagnostics distinguish a live core requirement from a live client
  connection requirement. HTTP monitoring starts without MCP initialization.
- Isolated live Windows/WSL acceptance harness; six clients share one snapshot,
  the core survives disconnect, and inherited desktop read dispatch still works.
- Actual Codex app-server HTTP-client inventory smoke with bearer/environment-header
  authentication in an empty isolated Codex home; no model turn or quota read.

### Acceptance boundary

- Shared HTTP is experimental. No automatic bootstrap, supervisor, login startup,
  desktop capability renewal, or change to an existing MCP registration is installed.
  Desktop restart, reboot and sleep/wake recovery are not yet verified.
- Live probes perform no scheduler mutations/model turns. The no-client early-wake
  regression uses a disposable scheduler fixture, not a real production heartbeat.

## [0.3.1] - 2026-08-30

### Fixed

- Exit on stdin EOF/close/error, stdout close/error, transport disconnect and detected
  parent loss. Register stream listeners before connecting to avoid startup races.
- Expire connections that never finish initialization after60 seconds; bound shutdown
  cleanup to5 seconds. Start the monitor only after MCP initialization completes.
- Preserve healthy idle sessions, including quota waits; no arbitrary idle eviction
  or process-wide kill. Document that multiple stdio sessions are not evidence of
  orphaned processes and that this cleanup does not cap legitimate concurrency.

### Documentation

- Record the successful real early-recovery heartbeat after an account switch:
  automatic scheduler advancement, early task wake, quota revalidation and owned
  heartbeat cleanup. Distinguish bounded MCP-harness acceptance from unverified
  desktop reconnection, indefinite idle lifetime and sleep/restart behavior.

## [0.3.0] - 2026-08-30

### Added

- Optional token-free five-minute in-MCP quota monitor, shared durable deadlines,
  fenced early-resume outbox and ownership-checked shipped desktop scheduler adapter.
- Account-switch recovery with independent profiles, and local accelerated-heartbeat
  cleanup without additional quota reads; configuration and diagnostics documentation.
- Regression coverage for concurrent monitor connections, lease expiry, uncertain
  acknowledgments, account-read races, logout and user-edited automation ownership.

- Explicit Windows-hosted stdio launcher callable from native Windows and WSL2,
  retaining one Windows ChatGPT profile and shared cache.
- Windows/WSL installation, workspace identity, verification and troubleshooting
  guide, plus read-only scheduler bridge diagnostic and evidence.
- Concise live acceptance output and cross-OS isolation-path safety check.

### Fixed

- Windows cmd/bat app-server launch quoting for paths containing spaces and shell
  metacharacters; real subprocess regression tests run on every CI platform.
- Early app-server exit now reports a bounded, redacted cause instead of an
  unrelated quota timeout.

## [0.2.0] - 2026-08-30

### Added

- Runtime ChatGPT plan profiles with passive part-job cost learning and persistent user threshold overrides.
- Credit/unlimited allowance detection, individual spend-control handling, and arbitrary long-window normalization.
- Quota-owned defer records, automation attachment, manual-resume cancellation hints, and superseded-heartbeat protection.
- Model-agnostic `primary`/`secondary` quota roles. A separately labelled reserve bucket can admit lightweight work while the primary role waits.

### Changed

- `job_preflight` now requires stable job, task, and workspace identity and records every non-deferred admission.
- Configuration uses plan-aware learning defaults instead of the v0.1 fixed warning/defer percentages.
- MCP public interface is intentionally breaking and now exposes eight tools.
- Onboarding documentation now covers clone/install, absolute-path registration, verification, role selection, and safe resume behavior.

### Fixed

- Stale reserve/credit snapshots cannot admit work; a primary wait no longer freezes reserve observations.
- Concurrent calls from the same MCP process no longer reacquire an in-flight refresh lease.
- Manual supersession and due-heartbeat claiming are atomic; attachment cannot overwrite or reuse another defer's automation ID.
- Missing mandatory reset times cannot create a misleading resume schedule. Final thresholds are clamped after user overrides.
- Agent guidance checkpoints at caution and preflights bounded implementation phases before quota can cut off heartbeat creation.

## [0.1.0] - 2026-08-30

### Added

- Shared adaptive Codex quota cache with SQLite lease and backoff.
- Official app-server account/rate-limit reader without credential access.
- Quota status, job preflight, checkpoint, and defer/resume MCP tools.
- Cross-platform configuration, diagnostics, tests, and security documentation.

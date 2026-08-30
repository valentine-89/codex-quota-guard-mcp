# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [Unreleased]

### Added

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

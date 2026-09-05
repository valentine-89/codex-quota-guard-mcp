# Getting started

1. Install Node.js 22.13+ and sign in to Codex with ChatGPT.
2. Clone the repo, then run `npm ci`, `npm run check`, and `node scripts/install.mjs`.
3. Restart or reconnect Codex, call `quota_status`, and preflight each substantial segment.

Automatic use of an existing banked reset is disabled by default. Run `node scripts/install.mjs --enable-auto-reset` to opt this profile in; this does not buy resets or credits and does not modify a global AGENTS file. Version 1 agents must pass `agentProtocol="auto-reset-v1"` to `quota_status` and `job_preflight`.
During active work, follow `checkAgainBy`, `validUntil`, `canStartSegment`, and `maxSegmentMinutes`; save a checkpoint before expensive or detached GPU work.

The installer creates private Guard state under the tool's `data/core-<profile hash>/` and preserves unrelated Codex configuration without creating backups. Run it from the intended installed checkout, which must be writable. `guard.json`, `runtime.json`, and `state.sqlite` stay together; keep `data/` when updating code. Only the MCP registration remains in Codex's `config.toml`.

To replace an old external-state installation, close Guard clients, run the old version's `node scripts/uninstall.mjs --purge`, update code, then install again. This deletes old state and resets policy/learning; there is no migration or fallback. Re-enable automatic reset explicitly if wanted. Existing resume automations require separate review.

Windows plus WSL must be installed using Windows Node from PowerShell 7 so both use the Windows-hosted singleton. Native macOS and native Linux install separately on their own filesystems.

Automation recovery is optional. Without a scheduler capability, quota and checkpoint tools still work.

To remove the registration run `node scripts/uninstall.mjs`. Add `--purge` only when you also intend to delete the validated Guard-owned state.

Portable verification consists of `npm run check`, `npm run acceptance:install`, `npm audit`, and `npm pack --dry-run`. After installation and reconnection, `npm run acceptance:live` verifies the registered connector's stable handshake, eight-tool catalog, and live quota. `npm run acceptance:shared` is a maintainer-only Windows desktop probe that requires a real task ID and inherited scheduler capability.

Verification has three gates: core health, a fresh-thread handshake with eight tools, and a same-thread Guard tool call.

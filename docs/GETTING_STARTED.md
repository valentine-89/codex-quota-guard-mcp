# Getting started

1. Install Node.js 22.13+ and the current Codex application/CLI for the guest OS and CPU architecture.
2. Sign in to Codex with ChatGPT. API-key and Bedrock sessions are intentionally unsupported.
3. From the GitHub checkout, run `npm ci`, `npm run check`, then `node scripts/install.mjs`.
4. Restart or reconnect Codex and call `quota_status` once near the beginning of a long task.
5. Split work into bounded segments and call `job_preflight` once before each substantial segment.

The installer creates a new v0.6 private state; v0.5 state is not migrated. It preserves unrelated Codex configuration and writes a backup beside the new Guard runtime settings.

Windows plus WSL must be installed using Windows Node from PowerShell 7 so both use the Windows-hosted singleton. Native macOS and native Linux install separately on their own filesystems.

To remove the registration run `node scripts/uninstall.mjs`. Add `--purge` only when you also intend to delete the validated v0.6 Guard state.

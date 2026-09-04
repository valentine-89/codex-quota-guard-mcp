# Getting started

1. Install Node.js 22.13+ and the current Codex application/CLI for the guest OS and CPU architecture.
2. Sign in to Codex with ChatGPT. API-key and Bedrock sessions are intentionally unsupported.
3. Clone `https://github.com/valentine-89/codex-quota-guard-mcp.git`, enter the checkout, then run `npm ci`, `npm run check`, and `node scripts/install.mjs`.
4. Restart or reconnect Codex and call `quota_status` once near the beginning of a long task.
5. Split work into bounded segments and call `job_preflight` once before each substantial segment.

The installer creates managed private state; the retired v0.5 state is not migrated. It preserves unrelated Codex configuration and writes a backup beside the new Guard runtime settings.

Windows plus WSL must be installed using Windows Node from PowerShell 7 so both use the Windows-hosted singleton. Native macOS and native Linux install separately on their own filesystems.

Early automation recovery is optional and requires Codex to provide its local scheduler endpoint plus an absolute trusted `CODEX_QUOTA_GUARD_SCHEDULER_SERVER`. The installer forwards that environment variable on every supported host; Windows accepts a named pipe and Linux/macOS accept a Unix-domain socket. When the capability is absent, `quota_status.monitor.available` remains false without disabling quota or checkpoint tools.

To remove the registration run `node scripts/uninstall.mjs`. Add `--purge` only when you also intend to delete the validated Guard-owned state.

Portable verification consists of `npm run check`, `npm run acceptance:install`, `npm audit`, and `npm pack --dry-run`. After installation and reconnection, `npm run acceptance:live` verifies the registered connector's stable handshake, eight-tool catalog, and live quota. `npm run acceptance:shared` is a maintainer-only Windows desktop probe that requires a real task ID and inherited scheduler capability.

Treat verification as three separate gates: authenticated health means the core runs; the stable handshake and eight-tool catalog in a fresh thread mean Desktop loaded Guard; a same-thread tool-call record means the agent used Guard. An independent acceptance client cannot by itself prove the last two gates.

# Troubleshooting

## `CHATGPT_LOGIN_REQUIRED`

Codex is signed out, using API-key/Bedrock/another provider, or did not return a stable ChatGPT identity. Sign in through Codex itself and reconnect the MCP. Quota Guard deliberately provides no login flow or API-key fallback.

## `MANAGED_CORE_START_FAILED`

Confirm Node 22.13+, absolute paths in the private runtime settings, and that the selected loopback port is not occupied. A wrong listener is never terminated automatically. Rerun `npm run build` and `node scripts/install.mjs`.

## Connector unavailable after install

Restart or reconnect Codex so it reads the updated MCP registration. Verify the registration points to the current absolute Node executable and `dist/connector.js`, not `dist/main.js` or an old `http-connector.js`.

Connector diagnostics are emitted only on stderr and use a bounded phase label: `settings`, `core_startup`, `health`, `handshake`, or `forwarding`. Stdout is reserved for JSON-RPC. These messages never include the bearer, task content, or checkpoint data.

The installer sets `default_tools_approval_mode="approve"` only for the Guard server. This lets non-interactive Codex tasks use its quota/checkpoint lifecycle while leaving every unrelated MCP approval policy unchanged.

## Core remains briefly after Codex closes

A normal disconnect allows about five seconds for clean shutdown. A crashed connector can take up to 60 seconds for lease expiry, plus about five seconds of shutdown grace. A live connector or active request legitimately extends the lifetime; a pending defer alone does not.

## Windows permission error

Run with PowerShell 7 as the normal user. Do not elevate. The installer changes only the dedicated `core-<profile hash>` DACL. If corporate policy blocks user DACL changes, ask the administrator to permit a private user-owned directory rather than granting broad rights.

## WSL creates a second core

Use the Windows-side installation and Windows-hosted launcher for Windows Codex tasks. Do not mix Linux and Windows settings/SQLite for one profile.

## Safe diagnostics

Run `npm run check`, `npm run acceptance:install`, `npm audit`, and inspect only authenticated health/settings paths. Never paste runtime bearer values, auth files, full prompts, responses, or live checkpoints into an issue.

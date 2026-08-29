# Security

## Credential boundary

The quota guard never opens Codex `auth.json`, browser stores, cookies, keyrings, or OAuth endpoints. The installed official app-server owns authentication and refresh. Child environment inheritance includes the selected `CODEX_HOME` only so app-server uses the intended profile.

## Persistence

- No prompts, model responses, API keys, OAuth tokens, or browser data are intentionally stored.
- Account email is hashed before persistence.
- Checkpoint fields are length-bounded and redacted for common secret patterns.
- Runtime SQLite files live outside the repository and are excluded by `.gitignore`.

## Process and network behavior

The MCP server opens no listening socket and sends no telemetry. It communicates over stdio with Codex and starts the installed Codex app-server only when shared cache policy permits refresh. Any upstream account request is made by the official app-server.

## Reporting vulnerabilities

Do not include credentials, auth files, production checkpoints, or complete database files in an issue. Provide redacted doctor output, platform, Node/Codex versions, and reproduction steps.

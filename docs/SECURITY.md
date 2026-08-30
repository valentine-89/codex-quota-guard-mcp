# Security

## Credential boundary

The quota guard never opens Codex `auth.json`, browser stores, cookies, keyrings, or OAuth endpoints. The installed official app-server owns authentication and refresh. Child environment inheritance includes the selected `CODEX_HOME` only so app-server uses the intended profile.

## Persistence

- No full model conversations, model responses, API keys, OAuth tokens, or browser data are intentionally stored. The optional scheduler outbox stores the exact owned automation definition (including its bounded guard resume prompt) to detect user edits; do not put secrets in automation fields.
- Account email is hashed before persistence.
- Checkpoint fields are length-bounded and redacted for common secret patterns.
- Runtime SQLite files live outside the repository and are excluded by `.gitignore`.

## Process and network behavior

The direct stdio MCP server opens no listening socket and sends no telemetry. It
communicates over stdio with Codex and starts the installed Codex app-server only
when shared cache policy permits refresh. Any upstream account request is made by
the official app-server.

The [managed shared core](MANAGED_CORE.md) opens a loopback-only listener with a
required random local bearer secret, exact Host/Origin checks and bounded
requests/connections/body size. The installer stores that secret in a private
per-user directory and puts only the settings path in Codex configuration. The core
accepts neither desktop capability values nor executable-path registration over
HTTP. Its connector refuses redirects and does not retry unconfirmed mutations.

The monitor launches an explicitly configured trusted OpenAI desktop MCP server. It
forwards only the existing desktop capability in memory, never writes a pipe value to
configuration, and never implements private IPC. It reads only exact attached
automation records for ownership comparison; all scheduler mutations go through the
shipped tool and retain its authorization checks. The server path is executable
configuration and must not point to untrusted code.

## Reporting vulnerabilities

Do not include credentials, auth files, production checkpoints, or complete database files in an issue. Provide redacted doctor output, platform, Node/Codex versions, and reproduction steps.

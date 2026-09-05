# Security

The trust boundary is the user's existing Codex ChatGPT session. Quota Guard never reads `auth.json` or equivalent login files, never accepts credentials, never starts login/OAuth, and never stores tokens or cookies.

Before rate-limit IO, the app-server result must contain `account.type === "chatgpt"` and a stable non-empty identity. API-key, Bedrock, other providers, logout, and identity changes return `CHATGPT_LOGIN_REQUIRED` or `ACCOUNT_CHANGED_DURING_READ`. The old quota cache is deleted from admission state, so no bucket or percentage can authorize work after rejection.

Runtime settings contain only local paths, port, installation ID, and a random bearer. POSIX directories are `0700` and files `0600`. Windows applies a current-user-only DACL through non-elevated PowerShell 7. The bearer is not placed in command-line arguments or general documentation output.

Managed state is confined to the installed tool's `data/core-<profile hash>/`. Installer and uninstaller reject redirected paths, another installation's registration, and another profile's directory. `data/` is excluded from Git and npm packages. Do not share this directory: it contains the local bearer and user state. No legacy storage lookup, migration, or automatic configuration backup is performed.

Automatic weekly reset is an explicit local opt-in. The Guard stores only a hash of eligible reset-credit IDs plus a generated recommendation/idempotency key; it does not expose backend credit IDs, read auth files, purchase anything, or call the host reset tool. Stale, backoff, refreshing, unknown-account, unknown-plan, expired-credit, and malformed-credit states cannot authorize a recommendation.

HTTP is loopback-only and rejects weak tokens, hostile Host/Origin values, query paths, unsupported content types, oversized bodies and excess concurrency. Install and uninstall preserve unrelated Codex configuration; purge accepts only a resolved Guard-owned state path.

The tool requests no camera, microphone, browser, accessibility, administrator, service-control, network-change, process-inspection, or hypervisor permissions.

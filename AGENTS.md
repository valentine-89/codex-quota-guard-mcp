# Repository instructions

- Preserve the credential boundary: never read Codex auth files or add direct OAuth fallback.
- Keep quota refresh single-flight and adaptive; no public force-refresh input.
- Add regression tests for changes to window normalization, TTL, lease, backoff, or defer behavior.
- Use PowerShell 7 on Windows. Do not change Wi-Fi or require interactive Windows elevation.
- Run `npm run check` before commit. Never commit local SQLite state, auth material, or live checkpoint data.
- Use Conventional Commits and update documentation for public interface changes.
- Before pushing each update, increase the SemVer package version, synchronize package-lock/current docs and add a dated changelog entry. Runtime reads package.json; CI checks version consistency and advancement.

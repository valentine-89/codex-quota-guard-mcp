# Windows and WSL

Windows 10/11 uses Windows Node, Windows Codex, Windows state, and the same on-demand core whether the guest is physical or virtual. The code does not detect Parallels, VMware, UTM, Hyper-V, or a macOS host.

Install from PowerShell 7 with Windows Node:

```text
npm ci
npm run check
node scripts/install.mjs
```

The installer does not elevate. PowerShell is used only to replace inheritance on the dedicated Guard runtime directory with a current-user DACL.

For Windows-hosted WSL tasks, keep the registration on the Windows side. The connector launches the Windows Node/core through normal WSL interoperability and retains one Windows SQLite/profile. Do not install a second Linux state for the same Windows Codex profile. Convert the root once with `wslpath -w "$PWD"`; a Windows-hosted Guard rejects `/mnt/...` roots so they cannot be silently stored under the wrong Windows drive.

Linux-native Codex, including a Linux environment not hosted by Windows Codex, uses native Linux Node/state instead. Native macOS likewise uses its own Node, Codex login and state. The monitor accepts a local POSIX Unix-domain socket only after the inherited scheduler capability succeeds at same-task verification. If Codex does not provide both `CODEX_APP_TOOLS_PIPE_PATH` and the trusted scheduler server path, quota/checkpoint tools remain available and `quota_status.monitor.available` stays false.

Windows ARM64 should use matching ARM64 Node and Codex when available; Windows' own compatibility layer is acceptable. Quota Guard has no CPU-emulation branch.

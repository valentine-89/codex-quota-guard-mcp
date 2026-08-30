# Windows and WSL

Windows 10/11 uses Windows Node, Windows Codex, Windows state, and the same on-demand core whether the guest is physical or virtual. The code does not detect Parallels, VMware, UTM, Hyper-V, or a macOS host.

Install from PowerShell 7 with Windows Node:

```text
npm ci
npm run check
node scripts/install.mjs
```

The installer does not elevate. PowerShell is used only to replace inheritance on the dedicated Guard runtime directory with a current-user DACL.

For Windows-hosted WSL tasks, keep the registration on the Windows side. The connector launches the Windows Node/core through normal WSL interoperability and retains one Windows SQLite/profile. Do not install a second Linux state for the same Windows Codex profile. `workspaceRoot` passed to tools must remain the absolute Windows path established for that task.

Linux-native Codex, including a Linux environment not hosted by Windows Codex, uses native Linux Node/state instead. Native macOS likewise uses its own Node, Codex login and state.

Windows ARM64 should use matching ARM64 Node and Codex when available; Windows' own compatibility layer is acceptable. Quota Guard has no CPU-emulation branch.

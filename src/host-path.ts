import { posix, win32 } from "node:path";

/** Reject paths that are absolute only under the caller's OS, not the Guard host. */
export function isHostWorkspaceRoot(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!value || /[\r\n\0]/.test(value)) return false;
  if (platform === "win32") {
    const driveRoot = /^[a-zA-Z]:[\\/]/.test(value);
    const uncRoot = /^\\\\(?![.?]\\)[^\\/]+[\\/][^\\/]+/.test(value);
    return (driveRoot || uncRoot) && win32.isAbsolute(value);
  }
  return posix.isAbsolute(value);
}

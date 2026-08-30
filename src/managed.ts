import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ManagedSettings {
  revision: 1;
  installationId: string;
  port: number;
  token: string;
  nodeExecutable: string;
  coreEntrypoint: string;
  guardConfig: string;
}

/** Reads only Guard-owned settings, never Codex authentication material. */
export function readManagedSettings(path: string): ManagedSettings {
  if (!isAbsolute(path)) throw new Error("MANAGED_SETTINGS_PATH_INVALID");
  const info = lstatSync(path), directory = lstatSync(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || directory.isSymbolicLink() || info.size > 16_384) throw new Error("MANAGED_SETTINGS_UNSAFE");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0
    || info.uid !== process.getuid?.() || directory.uid !== process.getuid?.())) throw new Error("MANAGED_SETTINGS_NOT_PRIVATE");
  const value = JSON.parse(readFileSync(path, "utf8")) as ManagedSettings;
  if (value.revision !== 1 || !/^[a-f0-9-]{36}$/.test(value.installationId)
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
    || !/^[a-zA-Z0-9_-]{43,256}$/.test(value.token)
    || ![value.nodeExecutable, value.coreEntrypoint, value.guardConfig].every(p => typeof p === "string" && isAbsolute(p))) {
    throw new Error("MANAGED_SETTINGS_INVALID");
  }
  // Executable paths are trusted local installation configuration, never HTTP inputs.
  return value;
}

export function managedUrl(settings: ManagedSettings): string { return `http://127.0.0.1:${settings.port}/mcp`; }

export async function managedHealth(settings: ManagedSettings): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${settings.port}/health`, {
      headers: { Authorization: `Bearer ${settings.token}` }, redirect: "error", signal: AbortSignal.timeout(1_000),
    });
  } catch (error) {
    // Only an absent listener authorizes a start. A hung/wrong listener is not killed.
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
    throw new Error("MANAGED_CORE_UNREACHABLE", { cause: error });
  }
  if (!response.ok) throw new Error("MANAGED_CORE_AUTH_FAILED");
  const result = await response.json() as Record<string, unknown>;
  if (result.service !== "codex-quota-guard" || result.installationId !== settings.installationId) throw new Error("MANAGED_CORE_IDENTITY_MISMATCH");
  return result;
}

export async function ensureManagedCore(path: string): Promise<ManagedSettings> {
  const settings = readManagedSettings(path);
  if (await managedHealth(settings)) return settings;
  const child = spawn(settings.nodeExecutable, [settings.coreEntrypoint], {
    detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, CODEX_QUOTA_GUARD_CONFIG: settings.guardConfig,
      CODEX_QUOTA_GUARD_MANAGED_SETTINGS: realpathSync(path), CODEX_QUOTA_GUARD_HTTP_PORT: String(settings.port),
      CODEX_QUOTA_GUARD_HTTP_TOKEN: settings.token },
  });
  let failed = false;
  child.once("error", () => { failed = true; }); child.unref();
  // Core's exclusive DB lock elects one winner; losing startup contenders exit.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !failed) {
    await delay(100);
    if (await managedHealth(settings)) return settings;
  }
  throw new Error("MANAGED_CORE_START_FAILED");
}

/** Connector forwards only a capability it already received from desktop, in memory. */
export async function bindManagedDesktop(settings: ManagedSettings, taskId: string | undefined): Promise<boolean> {
  const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (!pipePath || !taskId) return false;
  const response = await fetch(`http://127.0.0.1:${settings.port}/desktop-session`, {
    method: "POST", redirect: "error", headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pipePath, taskId }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return false;
  return (await response.json() as { accepted?: boolean }).accepted === true;
}

export function managedFile(stateDir: string, key: string): string { return join(stateDir, `managed-${key}`, "runtime.json"); }

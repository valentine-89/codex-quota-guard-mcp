// Explicit local provisioning, not run merely by importing the MCP or installing npm packages.
import { execFileSync } from "node:child_process";
import { mkdirSync, lstatSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { profileKey } from "../dist/store.js";
import { managedFile, readManagedSettings } from "../dist/managed.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = loadConfig();
// Managed state must be visible both inside Codex and to the external user task.
// LocalAppData can be package-virtualized by the desktop app, while CODEX_HOME is shared.
const managedStateDir = resolve(process.env.CODEX_QUOTA_GUARD_MANAGED_STATE_DIR ?? join(config.codexHome, "quota-guard"));
const path = managedFile(managedStateDir, profileKey(config.codexHome));
const directory = dirname(path);
if (process.platform === "win32") execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "protect-managed-directory.ps1"), "-Path", directory], { windowsHide: true, stdio: "pipe" });
else {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw Error("Managed directory must already be private and user-owned");
}
if (existsSync(path)) {
  readManagedSettings(path);
  console.log(JSON.stringify({ provisioned: false, existing: true, settingsPath: path }));
} else {
  mkdirSync(managedStateDir, { recursive: true });
  let migratedState = false;
  let migrationConfig;
  const migrationSettingsPath = process.env.CODEX_QUOTA_GUARD_MIGRATE_FROM_SETTINGS;
  const destinationState = join(directory, "state.sqlite");
  if (migrationSettingsPath && existsSync(migrationSettingsPath) && !existsSync(destinationState)) {
    const previous = readManagedSettings(migrationSettingsPath);
    migrationConfig = JSON.parse(readFileSync(previous.guardConfig, "utf8"));
    const sourceState = join(resolve(migrationConfig.stateDir), "state.sqlite");
    if (existsSync(sourceState)) {
      const source = new DatabaseSync(sourceState, { readOnly: true });
      try { await backup(source, destinationState); migratedState = true; }
      finally { source.close(); }
    }
  }
  // Let Windows choose a usable port outside Hyper-V/WSL reserved ranges.
  const requestedPort = Number(process.env.CODEX_QUOTA_GUARD_HTTP_PORT ?? 0);
  if (!Number.isInteger(requestedPort) || (requestedPort !== 0 && requestedPort < 1024) || requestedPort > 65535) throw Error("Invalid managed port");
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(requestedPort, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const persisted = { ...(migrationConfig ?? config), stateDir: directory, codexHome: config.codexHome };
  delete persisted.stateFile;
  // Paths/options only. Never persist desktop pipe/session environment or login data.
  persisted.schedulerServerPath ??= process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER || undefined;
  const guardConfig = join(directory, "guard.json");
  writeFileSync(guardConfig, JSON.stringify(persisted), { flag: "wx", mode: 0o600 });
  const settings = { revision: 1, installationId: randomUUID(), port, token: randomBytes(32).toString("base64url"),
    nodeExecutable: process.execPath, coreEntrypoint: join(root, "dist", "http-main.js"), guardConfig };
  writeFileSync(path, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
  readManagedSettings(path);
  console.log(JSON.stringify({ provisioned: true, settingsPath: path, port, migratedState }));
}

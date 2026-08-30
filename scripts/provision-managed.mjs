// Explicit local provisioning, not run merely by importing the MCP or installing npm packages.
import { execFileSync } from "node:child_process";
import { mkdirSync, lstatSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { profileKey } from "../dist/store.js";
import { managedFile, readManagedSettings } from "../dist/managed.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = loadConfig();
const path = managedFile(config.stateDir, profileKey(config.codexHome));
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
  // Let Windows choose a usable port outside Hyper-V/WSL reserved ranges.
  const requestedPort = Number(process.env.CODEX_QUOTA_GUARD_HTTP_PORT ?? 0);
  if (!Number.isInteger(requestedPort) || (requestedPort !== 0 && requestedPort < 1024) || requestedPort > 65535) throw Error("Invalid managed port");
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(requestedPort, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const persisted = { ...config }; delete persisted.stateFile;
  // Paths/options only. Never persist desktop pipe/session environment or login data.
  persisted.schedulerServerPath ??= process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER || undefined;
  const guardConfig = join(directory, "guard.json");
  writeFileSync(guardConfig, JSON.stringify(persisted), { flag: "wx", mode: 0o600 });
  const settings = { revision: 1, installationId: randomUUID(), port, token: randomBytes(32).toString("base64url"),
    nodeExecutable: process.execPath, coreEntrypoint: join(root, "dist", "http-main.js"), guardConfig };
  writeFileSync(path, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
  readManagedSettings(path);
  console.log(JSON.stringify({ provisioned: true, settingsPath: path, port }));
}

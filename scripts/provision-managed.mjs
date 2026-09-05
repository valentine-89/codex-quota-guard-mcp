// Explicit local provisioning, not run merely by importing the MCP or installing npm packages.
import { execFileSync } from "node:child_process";
import { mkdirSync, lstatSync, existsSync, writeFileSync, chmodSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { readManagedSettings } from "../dist/managed.js";
import { dataRoot, installationSettingsPath } from "./install-paths.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = loadConfig();
const managedStateDir = dataRoot;
const path = installationSettingsPath(config.codexHome);
const directory = dirname(path);
const releaseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const coreEntrypoint = join(root, "dist", "core.js");
const allocatePort = async () => {
  const requestedPort = Number(process.env.CODEX_QUOTA_GUARD_HTTP_PORT ?? 0);
  if (!Number.isInteger(requestedPort) || (requestedPort !== 0 && requestedPort < 1024) || requestedPort > 65535) throw Error("Invalid managed port");
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(requestedPort, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
};
if (process.platform === "win32") execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "protect-managed-directory.ps1"), "-Path", directory], { windowsHide: true, stdio: "pipe" });
else {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) throw Error("Managed directory must already be private and user-owned");
}
if (existsSync(path)) {
  const previous = readManagedSettings(path);
  if (previous.releaseVersion === releaseVersion && previous.nodeExecutable === process.execPath
    && previous.coreEntrypoint === coreEntrypoint) {
    console.log(JSON.stringify({ provisioned: false, existing: true, settingsPath: path }));
  } else {
    // Rotate the private endpoint so new connectors cannot attach to an older
    // core. The Guard config and SQLite state remain in place.
    const settings = { ...previous, releaseVersion, installationId: randomUUID(), port: await allocatePort(),
      token: randomBytes(32).toString("base64url"), nodeExecutable: process.execPath, coreEntrypoint };
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) rmSync(temporary, { force: true }); }
    readManagedSettings(path);
    console.log(JSON.stringify({ provisioned: true, upgraded: true, settingsPath: path }));
  }
} else {
  mkdirSync(managedStateDir, { recursive: true });
  // Let Windows choose a usable port outside Hyper-V/WSL reserved ranges.
  const port = await allocatePort();
  const persisted = { ...config, stateDir: directory, codexHome: config.codexHome };
  delete persisted.stateFile;
  // Paths/options only. Never persist desktop pipe/session environment or login data.
  persisted.schedulerServerPath ??= process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER || undefined;
  const guardConfig = join(directory, "guard.json");
  writeFileSync(guardConfig, JSON.stringify(persisted), { flag: "wx", mode: 0o600 });
  const settings = { revision: 2, releaseVersion, installationId: randomUUID(), port,
    token: randomBytes(32).toString("base64url"), nodeExecutable: process.execPath, coreEntrypoint, guardConfig };
  writeFileSync(path, JSON.stringify(settings), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") { chmodSync(guardConfig, 0o600); chmodSync(path, 0o600); }
  readManagedSettings(path);
  console.log(JSON.stringify({ provisioned: true, settingsPath: path, port, migratedState: false }));
}

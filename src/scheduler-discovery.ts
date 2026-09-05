import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const suffix = ["plugins", "openai-bundled", "plugins", "codex-app-tools", "server.mjs"];
export function schedulerFromResources(roots: string[]): string | undefined {
  const files = [...new Set(roots.filter(isAbsolute).map(root => join(root, ...suffix)))]
    .filter(path => existsSync(path) && statSync(path).isFile());
  if (files.length > 1) throw Error("SCHEDULER_DISCOVERY_AMBIGUOUS");
  return files[0];
}

/** Bounded host discovery. Never enumerate login files or persist session pipes. */
export function discoverSchedulerServer(saved?: string): string {
  const explicit = process.env.CODEX_QUOTA_GUARD_SCHEDULER_SERVER;
  if (explicit) return explicit;
  const resources = process.env.CODEX_ELECTRON_RESOURCES_PATH;
  if (resources) {
    const found = schedulerFromResources([resources]);
    if (found) return found;
  }
  let roots: string[] = [];
  if (process.platform === "win32") {
    try {
      const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"] });
      roots = output.trim().split(/\r?\n/).filter(Boolean).map(path => join(path, "app", "resources"));
    } catch { /* Explicit configuration remains available outside packaged Desktop. */ }
  } else if (process.platform === "darwin") {
    roots = ["/Applications/Codex.app/Contents/Resources", "/Applications/ChatGPT.app/Contents/Resources"];
  }
  return schedulerFromResources(roots) ?? saved ?? "";
}

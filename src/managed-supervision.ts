import { loadConfig } from "./config.js";
import { ensureManagedCore, managedHealth, readManagedSettings } from "./managed.js";
import { profileKey, StateStore } from "./store.js";

/** A scheduled probe starts the persistent core only for an attached active defer. */
export async function pendingManagedRecovery(settingsPath: string): Promise<boolean> {
  const settings = readManagedSettings(settingsPath);
  const previous = process.env.CODEX_QUOTA_GUARD_CONFIG;
  process.env.CODEX_QUOTA_GUARD_CONFIG = settings.guardConfig;
  let store: StateStore | undefined;
  try {
    const config = loadConfig();
    store = new StateStore(config.stateFile);
    return store.monitor.list(profileKey(config.codexHome)).length > 0;
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.CODEX_QUOTA_GUARD_CONFIG;
    else process.env.CODEX_QUOTA_GUARD_CONFIG = previous;
  }
}

export async function superviseManagedCore(settingsPath: string): Promise<"running" | "idle" | "started"> {
  const settings = readManagedSettings(settingsPath);
  if (await managedHealth(settings)) return "running";
  if (!await pendingManagedRecovery(settingsPath)) return "idle";
  await ensureManagedCore(settingsPath);
  return "started";
}

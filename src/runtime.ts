import type { GuardConfig } from "./config.js";
import { StateStore } from "./store.js";
import { CodexAppServerClient } from "./app-server.js";
import { QuotaGuardService } from "./service.js";
import { DesktopSchedulerBridge, RenewableSchedulerRpc } from "./scheduler.js";
import { QuotaMonitor } from "./monitor.js";
import { discoverSchedulerServer } from "./scheduler-discovery.js";

export function createRuntime(config: GuardConfig) {
  const store = new StateStore(config.stateFile);
  const service = new QuotaGuardService(config, store, new CodexAppServerClient(config));
  const rpc = new RenewableSchedulerRpc("", undefined, process.platform, discoverSchedulerServer);
  const available = () => config.monitorEnabled !== false && rpc.available();
  const bridge = new DesktopSchedulerBridge(config.codexHome, rpc, available);
  const monitor = new QuotaMonitor(config.codexHome, store, service, bridge);
  service.setMonitorCapability(available, () => config.monitorEnabled === false ? "MONITOR_DISABLED" : rpc.unavailableReason());
  service.setAutomationCapture(defer => bridge.capture(defer)?.serialized ?? null);
  return { service, monitor, bindDesktop: (pipePath: string, taskId: string) => config.monitorEnabled === false
    ? Promise.resolve(false) : rpc.bind(pipePath, taskId), async close() { await monitor.stop(); store.close(); } };
}

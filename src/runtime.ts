import type { GuardConfig } from "./config.js";
import { StateStore } from "./store.js";
import { CodexAppServerClient } from "./app-server.js";
import { QuotaGuardService } from "./service.js";
import { DesktopSchedulerBridge, RenewableSchedulerRpc } from "./scheduler.js";
import { QuotaMonitor } from "./monitor.js";
import { discoverSchedulerServer } from "./scheduler-discovery.js";
import { IpcScheduler } from "./ipc-scheduler.js";
import { taskContext } from "./task-context.js";

export function createRuntime(config: GuardConfig) {
  const store = new StateStore(config.stateFile);
  const service = new QuotaGuardService(config, store, new CodexAppServerClient(config));
  const ipc = new IpcScheduler(config, store, service);
  service.setIpcScheduler(ipc);
  const rpc = new RenewableSchedulerRpc("", undefined, process.platform, discoverSchedulerServer);
  const available = () => config.monitorEnabled !== false && rpc.available();
  const bridge = new DesktopSchedulerBridge(config.codexHome, rpc, available);
  const monitor = new QuotaMonitor(config.codexHome, store, service, bridge);
  const taskAvailable = () => { const context = taskContext.getStore(); return available() && (!context || rpc.availableForTask(context.taskId)); };
  service.setMonitorCapability(taskAvailable, () => config.monitorEnabled === false ? "MONITOR_DISABLED"
    : taskAvailable() ? null : rpc.unavailableReason() ?? "SCHEDULER_NOT_BOUND");
  service.setAutomationCapture(defer => bridge.capture(defer)?.serialized ?? null);
  return { service, monitor, ipc, bindDesktop: (pipePath: string, taskId: string) => config.monitorEnabled === false
    ? Promise.resolve(false) : rpc.bind(pipePath, taskId), async close() { await ipc.stop(); await monitor.stop(); store.close(); } };
}

import type { EventEmitter } from "node:events";

export const PROTOCOL_READY_TIMEOUT_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 5_000;
export const PARENT_CHECK_MS = 10_000;

export type ExitReason = "stdin_end" | "stdin_close" | "stdin_error" | "stdout_close" | "stdout_error"
  | "transport_closed" | "parent_exited" | "protocol_ready_timeout" | "signal";

export interface LifetimeDependencies {
  input: EventEmitter;
  output: EventEmitter;
  parentAlive: () => boolean;
  cleanup: () => Promise<void>;
  exit: (code: number, reason: ExitReason) => void;
  protocolReadyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  parentCheckMs?: number;
}

/** Owns only this MCP process. Never kills another PID or expires a healthy idle session. */
export class ProcessLifetime {
  private stopping = false;
  private ready = false;
  private exited = false;
  private readonly listeners: Array<[EventEmitter, string, () => void]> = [];
  private readonly protocolReadyTimer: ReturnType<typeof setTimeout>;
  private readonly parentTimer: ReturnType<typeof setInterval>;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dependencies: LifetimeDependencies) {
    for (const [stream, prefix, events] of [
      [dependencies.input, "stdin", ["end", "close", "error"]],
      [dependencies.output, "stdout", ["close", "error"]],
    ] as const) {
      for (const event of events) {
        const handler = (): void => this.stop(`${prefix}_${event}` as ExitReason);
        stream.on(event, handler);
        this.listeners.push([stream, event, handler]);
      }
    }
    this.protocolReadyTimer = setTimeout(() => this.stop("protocol_ready_timeout"), dependencies.protocolReadyTimeoutMs ?? PROTOCOL_READY_TIMEOUT_MS);
    this.protocolReadyTimer.unref();
    this.parentTimer = setInterval(() => {
      if (!dependencies.parentAlive()) this.stop("parent_exited");
    }, dependencies.parentCheckMs ?? PARENT_CHECK_MS);
    this.parentTimer.unref();
  }

  markReady(): void {
    this.ready = true;
    clearTimeout(this.protocolReadyTimer);
  }
  status(): { ready: boolean; stopping: boolean } {
    return { ready: this.ready, stopping: this.stopping };
  }
  stop(reason: ExitReason): void {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.protocolReadyTimer);
    clearInterval(this.parentTimer);
    const finish = (code: number): void => {
      if (this.exited) return;
      this.exited = true;
      this.dispose();
      this.dependencies.exit(code, reason);
    };
    // Keep this deadline referenced so stuck child cleanup cannot keep the MCP alive indefinitely.
    this.shutdownTimer = setTimeout(() => finish(1), this.dependencies.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    void Promise.resolve().then(() => this.dependencies.cleanup()).then(() => finish(0), () => finish(1));
  }
  dispose(): void {
    clearTimeout(this.protocolReadyTimer);
    clearTimeout(this.shutdownTimer);
    clearInterval(this.parentTimer);
    for (const [emitter, event, handler] of this.listeners) emitter.off(event, handler);
  }
}

export function parentIsAlive(parentPid: number): boolean {
  if (parentPid <= 1) return true; // No meaningful parent was supplied at process start.
  if (process.ppid !== parentPid) return false;
  try { process.kill(parentPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

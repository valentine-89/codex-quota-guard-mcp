import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { parse } from "smol-toml";
import { RESUME_AUTOMATION_PROMPT, resumeAutomationName } from "./automation.js";
import type { SchedulerBridge, SchedulerDefinition } from "./monitor.js";
import type { StoredDefer } from "./types.js";

export const EARLY_RRULE = "FREQ=MINUTELY;INTERVAL=2";
const allowedFields = new Set(["version", "id", "kind", "name", "prompt", "status", "rrule",
  "target_thread_id", "created_at", "updated_at", "notification_policy", "destination"]);
function signature(record: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "updated_at").sort(([a], [b]) => a.localeCompare(b))));
}

export interface SchedulerRpc {
  ready(): Promise<void>;
  call(args: Record<string, unknown>, taskId: string): Promise<boolean>;
  close(): Promise<void>;
}

interface ContextSchedulerRpc extends SchedulerRpc { verifyContext(taskId: string): Promise<void>; }

export function validSchedulerEndpoint(value: string | undefined,
  platform: NodeJS.Platform = process.platform): value is string {
  if (!value || value.length > 1_024 || /[\r\n\0]/.test(value)) return false;
  if (platform === "win32") return value.startsWith("\\\\.\\pipe\\") && value.length > "\\\\.\\pipe\\".length;
  return posix.isAbsolute(value);
}

/** Delegates transport/authorization to the installed OpenAI server; no private IPC. */
export class DesktopSchedulerRpc implements SchedulerRpc {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  constructor(private readonly serverPath: string, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  async ready(): Promise<void> {
    if (this.client) return;
    const client = new Client({ name: "quota-guard-monitor", version: "2.0.3" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [this.serverPath],
      env: Object.fromEntries(Object.entries(this.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "pipe" });
    transport.stderr?.on("data", () => { /* Drain without persisting capability-bearing diagnostics. */ });
    this.transport = transport;
    const timeout = setTimeout(() => { void transport.close(); }, 15_000);
    try {
      await client.connect(transport);
      const inventory = await client.listTools({}, { timeout: 15_000 });
      const schema = inventory.tools.find(tool => tool.name === "automation_update")?.inputSchema;
      // Require the observed update contract, do not guess a fallback transport/schema.
      const encoded = JSON.stringify(schema ?? {});
      if (!["heartbeat", "update", "delete", "targetThreadId", "rrule"].every(field => encoded.includes(`"${field}"`))) {
        throw new Error("SCHEDULER_SCHEMA_UNSUPPORTED");
      }
      this.client = client;
    } catch (cause) { await transport.close(); this.transport = undefined; throw new Error("SCHEDULER_UNAVAILABLE", { cause }); }
    finally { clearTimeout(timeout); }
  }
  async call(args: Record<string, unknown>, taskId: string): Promise<boolean> {
    await this.ready();
    let response;
    try {
      response = await this.client!.callTool({ name: "automation_update", arguments: args,
        _meta: { threadId: taskId } }, { timeout: 15_000 });
    } catch { await this.close(); throw new Error("SCHEDULER_CALL_FAILED"); }
    if (response.isError) return false;
    const content = response.content as Array<{ type: string; text?: string }>;
    return content.some(item => {
      if (item.type !== "text" || !item.text) return false;
      try {
        const ack = JSON.parse(item.text) as Record<string, unknown>;
        return ack.automationId === args.id && ack.mode === args.mode;
      } catch { return false; }
    });
  }
  async close(): Promise<void> {
    await this.transport?.close(); this.client = undefined; this.transport = undefined;
  }
  async verifyContext(taskId: string): Promise<void> {
    await this.ready();
    if (this.client!.getServerVersion()?.name !== "codex-app-tools") throw new Error("SCHEDULER_IDENTITY_UNSUPPORTED");
    const result = await this.client!.callTool({ name: "list_threads", arguments: { limit: 1 },
      _meta: { threadId: taskId } }, { timeout: 15_000 });
    if (result.isError) throw new Error("SCHEDULER_CONTEXT_REJECTED");
  }
}

/** Serializes replacement with dispatch; a reconnect never closes an in-flight RPC. */
export class RenewableSchedulerRpc implements SchedulerRpc {
  private current: ContextSchedulerRpc;
  private verifiedPipe: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly serverPath: string,
    private readonly factory: (environment: NodeJS.ProcessEnv) => ContextSchedulerRpc = env => new DesktopSchedulerRpc(serverPath, env),
    private readonly hostPlatform: NodeJS.Platform = process.platform) {
    this.current = factory(process.env);
  }
  available(): boolean { return !!this.verifiedPipe && isAbsolute(this.serverPath) && existsSync(this.serverPath) && !this.stopped; }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action); this.tail = result.catch(() => undefined); return result;
  }
  ready(): Promise<void> { return this.serialize(() => { if (this.stopped) throw new Error("SCHEDULER_CLOSED"); return this.current.ready(); }); }
  call(args: Record<string, unknown>, taskId: string): Promise<boolean> {
    return this.serialize(() => { if (this.stopped) throw new Error("SCHEDULER_CLOSED"); return this.current.call(args, taskId); });
  }
  bind(pipePath: string, taskId: string): Promise<boolean> {
    // Accept only a local Windows named pipe or POSIX Unix-domain socket inherited from Codex.
    if (!validSchedulerEndpoint(pipePath, this.hostPlatform)
      || !/^[a-f0-9-]{36}$/i.test(taskId)) return Promise.resolve(false);
    return this.serialize(async () => {
      if (this.stopped) return false;
      if (pipePath === this.verifiedPipe) return true;
      const candidate = this.factory({ ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath });
      try { await candidate.verifyContext(taskId); }
      catch { await candidate.close(); return false; }
      await this.current.close(); this.current = candidate; this.verifiedPipe = pipePath;
      return true;
    });
  }
  close(): Promise<void> { this.stopped = true; return this.serialize(() => this.current.close()); }
}

/** Read only exact attached files. All writes go through the host's automation tool. */
export class DesktopSchedulerBridge implements SchedulerBridge {
  constructor(private readonly codexHome: string, private readonly rpc: SchedulerRpc,
    private readonly enabled: () => boolean) {}
  available(): boolean { return this.enabled(); }
  private record(defer: StoredDefer): Record<string, unknown> | null {
    if (!defer.automationId || !/^[a-zA-Z0-9_-]{1,256}$/.test(defer.automationId)) return null;
    const root = join(this.codexHome, "automations");
    const directory = join(root, defer.automationId);
    const path = join(directory, "automation.toml");
    if (!existsSync(path)) return null;
    if (lstatSync(directory).isSymbolicLink() || lstatSync(path).isSymbolicLink()) return null;
    const rel = relative(realpathSync(root), realpathSync(path));
    if (rel.startsWith("..") || isAbsolute(rel) || lstatSync(path).size > 128_000) return null;
    const record = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (Object.keys(record).some(key => !allowedFields.has(key)) || record.version !== 1
      || record.id !== defer.automationId || record.kind !== "heartbeat" || record.status !== "ACTIVE"
      || record.target_thread_id !== defer.taskId || record.prompt !== RESUME_AUTOMATION_PROMPT
      || record.name !== resumeAutomationName(defer.id) || typeof record.rrule !== "string"
      || typeof record.created_at !== "number"
      || (record.notification_policy !== undefined && record.notification_policy !== "failed_runs_only")
      || (record.destination !== undefined && !["local", "thread"].includes(String(record.destination)))) return null;
    return record;
  }
  async read(defer: StoredDefer): Promise<SchedulerDefinition | null> {
    return this.capture(defer);
  }
  capture(defer: StoredDefer): SchedulerDefinition | null {
    const record = this.record(defer);
    return record ? { serialized: signature(record) } : null;
  }
  expected(definition: SchedulerDefinition): string {
    return signature({ ...JSON.parse(definition.serialized) as Record<string, unknown>, rrule: EARLY_RRULE });
  }
  async advance(defer: StoredDefer, definition: SchedulerDefinition, authorize: () => boolean): Promise<boolean> {
    await this.rpc.ready();
    const record = this.record(defer);
    if (!record || signature(record) !== definition.serialized || !authorize()) return false;
    return this.rpc.call({ mode: "update", id: record.id, kind: "heartbeat", name: record.name,
      prompt: record.prompt, status: record.status, rrule: EARLY_RRULE, targetThreadId: record.target_thread_id,
      ...(record.notification_policy === undefined ? {} : { notificationPolicy: record.notification_policy }),
      ...(record.destination === undefined ? {} : { destination: record.destination }) }, defer.taskId);
  }
  async cancel(defer: StoredDefer, expected: string, authorize: () => boolean): Promise<boolean> {
    await this.rpc.ready();
    const record = this.record(defer);
    // Deleted/paused/edited by the user: relinquish ownership rather than touch it.
    if (!record || signature(record) !== expected) return true;
    if (!authorize()) return false;
    return this.rpc.call({ mode: "delete", id: record.id }, defer.taskId);
  }
  close(): Promise<void> { return this.rpc.close(); }
}

export function schedulerConfigured(serverPath: string | undefined): boolean {
  return !!serverPath && isAbsolute(serverPath) && existsSync(serverPath)
    && validSchedulerEndpoint(process.env.CODEX_APP_TOOLS_PIPE_PATH);
}

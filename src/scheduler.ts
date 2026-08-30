import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse } from "smol-toml";
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

/** Delegates transport/authorization to the installed OpenAI server; no private IPC. */
export class DesktopSchedulerRpc implements SchedulerRpc {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  constructor(private readonly serverPath: string) {}
  async ready(): Promise<void> {
    if (this.client) return;
    const client = new Client({ name: "quota-guard-monitor", version: "0.3.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [this.serverPath],
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "pipe" });
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
        _meta: { threadId: taskId } }, undefined, { timeout: 15_000 });
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
      || record.target_thread_id !== defer.taskId || typeof record.prompt !== "string"
      || !record.prompt.includes(defer.id) || !record.prompt.includes(defer.checkpointId)
      || typeof record.name !== "string" || typeof record.rrule !== "string"
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
  return !!serverPath && isAbsolute(serverPath) && existsSync(serverPath) && !!process.env.CODEX_APP_TOOLS_PIPE_PATH;
}

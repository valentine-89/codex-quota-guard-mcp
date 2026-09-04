#!/usr/bin/env node
// Intentionally no service/SQLite/MCP SDK imports. Each connection is only a wire adapter.
import { once } from "node:events";
import { ProcessLifetime, parentIsAlive } from "./lifetime.js";
import { bindManagedDesktop, ensureManagedCore, managedUrl, type ManagedSettings } from "./managed.js";

type FailurePhase = "settings" | "core_startup" | "health" | "handshake" | "forwarding";

const failureCodes = new Map<string, FailurePhase>([
  ["MANAGED_SETTINGS_PATH_INVALID", "settings"], ["MANAGED_SETTINGS_UNSAFE", "settings"],
  ["MANAGED_SETTINGS_NOT_PRIVATE", "settings"], ["MANAGED_SETTINGS_INVALID", "settings"],
  ["CONNECTOR_SETTINGS_MISSING", "settings"], ["INVALID_LOCAL_ENDPOINT", "settings"],
  ["MANAGED_CORE_START_FAILED", "core_startup"],
  ["MANAGED_CORE_UNAVAILABLE", "core_startup"], ["MANAGED_CORE_UNREACHABLE", "health"],
  ["MANAGED_CORE_AUTH_FAILED", "health"], ["MANAGED_CORE_IDENTITY_MISMATCH", "health"],
  ["CLIENT_LEASE_REGISTER_FAILED", "forwarding"], ["CORE_RESPONSE_INVALID", "forwarding"],
  ["CORE_UNAVAILABLE", "forwarding"], ["INVALID_ROUTING_NAME", "forwarding"],
]);

function diagnose(error: unknown, fallback: FailurePhase): void {
  const raw = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
  const code = failureCodes.has(raw) ? raw : "UNEXPECTED_FAILURE";
  process.stderr.write(`quota-guard[${failureCodes.get(raw) ?? fallback}]: ${code}\n`);
}

function decodeProtocolResponse(contentType: string | null, body: string): unknown[] {
  if (!body) return [];
  if (!contentType?.toLowerCase().startsWith("text/event-stream")) return [JSON.parse(body)];
  const messages: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (data) messages.push(JSON.parse(data));
  }
  return messages;
}

async function main() {
  const parent = process.ppid;
  const controller = new AbortController();
  let leaseId: string | undefined;
  const leaseTarget: { url?: URL } = {};
  let token = "";
  const updateLease = async (action: "register" | "renew" | "unregister"): Promise<boolean> => {
    if (!leaseTarget.url) return false;
    const body = action === "register" ? { action } : { action, clientId: leaseId };
    const response = await fetch(leaseTarget.url, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    if (action === "register") leaseId = (await response.json() as { clientId?: string }).clientId;
    return action === "register" ? typeof leaseId === "string" : true;
  };
  const settingsPath = process.env.CODEX_QUOTA_GUARD_MANAGED_SETTINGS;
  if (!settingsPath && (!process.env.CODEX_QUOTA_GUARD_HTTP_URL || !process.env.CODEX_QUOTA_GUARD_HTTP_TOKEN)) {
    throw new Error("CONNECTOR_SETTINGS_MISSING");
  }
  let managed: ManagedSettings | undefined;
  let lastHealth = 0;
  let lastBind = 0;
  let boundTask: string | undefined;
  let preparing: Promise<void> | undefined;
  const prepare = (taskId = process.env.CODEX_THREAD_ID, bindDesktop = false, forceHealth = false): Promise<void> => {
    if (!settingsPath) return Promise.resolve();
    // A task ID learned from a later tool call still needs a binding attempt.
    if (preparing) return preparing.then(() => prepare(taskId, bindDesktop, forceHealth));
    const checkHealth = forceHealth || !managed || Date.now() - lastHealth >= 10_000;
    const checkBinding = bindDesktop && taskId && (taskId !== boundTask || Date.now() - lastBind >= 60_000);
    if (!checkHealth && !checkBinding) return Promise.resolve();
    preparing = (async () => {
      if (checkHealth) {
        managed = await ensureManagedCore(settingsPath);
        lastHealth = Date.now();
      }
      if (!managed) throw new Error("MANAGED_CORE_UNAVAILABLE");
      process.env.CODEX_QUOTA_GUARD_HTTP_URL = managedUrl(managed);
      process.env.CODEX_QUOTA_GUARD_HTTP_TOKEN = managed.token;
      // Failure retains quota tools and the original automation schedule; no capability guessing.
      if (checkBinding) {
        await bindManagedDesktop(managed, taskId).catch(() => false);
        boundTask = taskId; lastBind = Date.now();
      }
    })().finally(() => { preparing = undefined; });
    return preparing;
  };
  await prepare();
  const url = new URL(process.env.CODEX_QUOTA_GUARD_HTTP_URL ?? "");
  token = process.env.CODEX_QUOTA_GUARD_HTTP_TOKEN ?? "";
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp"
    || url.username || url.password || url.search || url.hash || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) {
    throw new Error("INVALID_LOCAL_ENDPOINT");
  }
  leaseTarget.url = new URL("/client-lease", url);
  const leaseTimer = setInterval(() => {
    if (!leaseId) return;
    void updateLease("renew").then(async renewed => {
      if (!renewed) { leaseId = undefined; await updateLease("register"); }
    }).catch(() => undefined);
  }, 20_000);
  leaseTimer.unref();
  const lifetime = new ProcessLifetime({ input: process.stdin, output: process.stdout,
    parentAlive: () => parentIsAlive(parent), cleanup: async () => {
      clearInterval(leaseTimer);
      if (leaseId) await updateLease("unregister").catch(() => false);
      controller.abort();
    },
    exit: code => { process.exitCode = code; process.stdin.pause(); } });
  let protocolVersion = "2025-11-25";
  let active = 0, buffer = Buffer.alloc(0);
  let output = Promise.resolve(), queuedOutput = 0;
  const write = (message: unknown) => {
    if (++queuedOutput > 64) { lifetime.stop("stdout_error"); return Promise.resolve(); }
    output = output.then(async () => {
      try {
        if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
          process.stdin.pause();
          await once(process.stdout, "drain");
          process.stdin.resume();
        }
      } finally { queuedOutput--; }
    });
    return output;
  };
  const forward = async (message: Record<string, unknown>) => {
    const id = message.id;
    const method = message.method;
    if (typeof method !== "string" || !method || /[\r\n\0]/.test(method)) {
      if (id !== undefined) await write({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid MCP request" } });
      return;
    }
    if (active >= 32) {
      if (id !== undefined) await write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Shared connector is busy; retry this job with the same jobId" } });
      return;
    }
    active++;
    try {
      const params = message.params as { arguments?: { taskId?: string } } | undefined;
      const capabilityCall = method === "tools/call";
      await prepare(params?.arguments?.taskId ?? process.env.CODEX_THREAD_ID, capabilityCall, capabilityCall);
      // Discovery and the stable handshake must not count as a live Codex task
      // or delay shared-core shutdown. Acquire a lease only on a capability call.
      if (method !== "server/discover" && method !== "initialize"
        && method !== "notifications/initialized" && method !== "tools/list"
        && !leaseId && !await updateLease("register")) {
        throw new Error("CLIENT_LEASE_REGISTER_FAILED");
      }
      const requestParams = message.params as Record<string, unknown> | undefined;
      const requestMeta = requestParams?._meta as Record<string, unknown> | undefined;
      const claimedVersion = requestMeta?.["io.modelcontextprotocol/protocolVersion"];
      const requestProtocolVersion = method === "server/discover" ? "2026-07-28"
        : typeof claimedVersion === "string" ? claimedVersion : protocolVersion;
      const routedName = typeof requestParams?.name === "string" ? requestParams.name
        : typeof requestParams?.uri === "string" ? requestParams.uri
          : typeof requestParams?.taskId === "string" ? requestParams.taskId : undefined;
      if (routedName && /[\r\n\0]/.test(routedName)) throw new Error("INVALID_ROUTING_NAME");
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "MCP-Protocol-Version": requestProtocolVersion, "Mcp-Method": method };
      if (routedName) headers["Mcp-Name"] = routedName;
      const response = await fetch(url, { method: "POST", redirect: "error", headers,
        body: JSON.stringify(message), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      const responseText = await response.text();
      let results: unknown[];
      try { results = decodeProtocolResponse(response.headers.get("content-type"), responseText); }
      catch { throw new Error("CORE_RESPONSE_INVALID"); }
      if (!response.ok && results.length === 0) throw new Error("CORE_UNAVAILABLE");
      if (method === "initialize") {
        const responseMessage = results.find(item => item !== null && typeof item === "object") as
          { result?: { protocolVersion?: unknown } } | undefined;
        const negotiated = responseMessage?.result?.protocolVersion;
        if (typeof negotiated === "string") protocolVersion = negotiated;
      }
      for (const result of results) await write(result);
      if (method === "server/discover" || method === "notifications/initialized") lifetime.markReady();
    } catch (error) {
      lastHealth = 0;
      lastBind = 0;
      diagnose(error, method === "initialize" || method === "notifications/initialized" ? "handshake" : "forwarding");
      // Never retry mutating calls automatically: response loss is not proof of non-execution.
      if (!controller.signal.aborted && id !== undefined) await write({ jsonrpc: "2.0", id,
        error: { code: -32000, message: "Shared core unavailable or response unconfirmed; no fallback process was started" } });
    } finally { active--; }
  };
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      if (line.length > 1_048_576) { lifetime.stop("stdin_error"); return; }
      try {
        const message = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("INVALID_MESSAGE");
        void forward(message).catch(() => lifetime.stop("stdout_error"));
      } catch { lifetime.stop("stdin_error"); return; }
    }
    if (buffer.length > 1_048_576) lifetime.stop("stdin_error");
  });
  process.once("SIGINT", () => lifetime.stop("signal"));
  process.once("SIGTERM", () => lifetime.stop("signal"));
  if (process.stdin.destroyed || process.stdin.readableEnded) lifetime.stop("stdin_close");
}
main().catch(error => { diagnose(error, "settings"); process.exit(1); });

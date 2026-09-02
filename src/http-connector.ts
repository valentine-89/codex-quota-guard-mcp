#!/usr/bin/env node
// Intentionally no service/SQLite/MCP SDK imports. Each connection is only a wire adapter.
import { once } from "node:events";
import { ProcessLifetime, parentIsAlive } from "./lifetime.js";
import { bindManagedDesktop, ensureManagedCore, managedUrl, type ManagedSettings } from "./managed.js";

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
  let managed: ManagedSettings | undefined;
  let lastHealth = 0;
  let lastBind = 0;
  let boundTask: string | undefined;
  let preparing: Promise<void> | undefined;
  const prepare = (taskId = process.env.CODEX_THREAD_ID): Promise<void> => {
    if (!settingsPath) return Promise.resolve();
    // A task ID learned from a later tool call still needs a binding attempt.
    if (preparing) return preparing.then(() => prepare(taskId));
    const checkHealth = !managed || Date.now() - lastHealth >= 10_000;
    const checkBinding = taskId && (taskId !== boundTask || Date.now() - lastBind >= 60_000);
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
  const protocolVersion = "2026-07-28";
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
      if (id !== undefined) await write({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid modern MCP request" } });
      return;
    }
    if (active >= 32) {
      if (id !== undefined) await write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Shared connector is busy; retry this job with the same jobId" } });
      return;
    }
    active++;
    try {
      const params = message.params as { arguments?: { taskId?: string } } | undefined;
      await prepare(params?.arguments?.taskId ?? process.env.CODEX_THREAD_ID);
      // SDK v2 probes STDIO on a disposable sibling. Discovery alone must not
      // count as a live Codex task or delay shared-core shutdown for 60 seconds.
      if (method !== "server/discover" && !leaseId && !await updateLease("register")) {
        throw new Error("CLIENT_LEASE_REGISTER_FAILED");
      }
      const requestParams = message.params as Record<string, unknown> | undefined;
      const routedName = typeof requestParams?.name === "string" ? requestParams.name
        : typeof requestParams?.uri === "string" ? requestParams.uri
          : typeof requestParams?.taskId === "string" ? requestParams.taskId : undefined;
      if (routedName && /[\r\n\0]/.test(routedName)) throw new Error("INVALID_ROUTING_NAME");
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "MCP-Protocol-Version": protocolVersion, "Mcp-Method": method };
      if (routedName) headers["Mcp-Name"] = routedName;
      const response = await fetch(url, { method: "POST", redirect: "error", headers,
        body: JSON.stringify(message), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      const responseText = await response.text();
      let result: unknown;
      if (responseText) {
        try { result = JSON.parse(responseText); }
        catch { throw new Error("CORE_RESPONSE_INVALID"); }
      }
      if (!response.ok && result === undefined) throw new Error("CORE_UNAVAILABLE");
      if (result !== undefined) await write(result);
      if (response.ok || result !== undefined) lifetime.markReady();
    } catch {
      lastHealth = 0;
      lastBind = 0;
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
main().catch(() => { process.stderr.write("quota-guard: connector requires an authenticated loopback HTTP core\n"); process.exit(1); });

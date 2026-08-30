import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClientLeaseRegistry } from "./client-leases.js";

export interface HttpServerOptions {
  token: string;
  port?: number;
  maxConcurrentRequests?: number;
  maxConnections?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  diagnostics?: () => object;
  bindDesktop?: (pipePath: string, taskId: string) => Promise<boolean>;
  clientLeases?: ClientLeaseRegistry;
  onClientLeaseChange?: () => void;
  now?: () => number;
}

/** One shared backend, but request-scoped protocol objects: no unbounded session map. */
export async function startHttpServer(createProtocol: () => McpServer, options: HttpServerOptions) {
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.token)) throw new Error("HTTP_TOKEN_REQUIRED: use a random base64url secret of at least 32 characters");
  const expected = Buffer.from(`Bearer ${options.token}`);
  const maxRequests = options.maxConcurrentRequests ?? 32;
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const timeout = options.requestTimeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  let active = 0, closing = false, port = 0, lastActivityAtMs = now();
  const sockets = new Set<Socket>();
  const work = new Set<Promise<void>>();
  const reply = (res: ServerResponse, status: number, body: object = {}) => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    }
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const authority = `127.0.0.1:${port}`;
    // Authentication is not a substitute for DNS rebinding / browser-origin checks.
    if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`)) {
      reply(res, 403); return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(res, 401); return; }
    if (closing) { reply(res, 503); return; }
    if (req.url === "/health" && req.method === "GET") {
      reply(res, 200, { service: "codex-quota-guard", activeRequests: active,
        ...(options.clientLeases?.snapshot() ?? {}), ...options.diagnostics?.() }); return;
    }
    const clientLease = req.url === "/client-lease" && options.clientLeases !== undefined;
    const desktopBinding = req.url === "/desktop-session" && options.bindDesktop !== undefined;
    if (req.url !== "/mcp" && !desktopBinding && !clientLease) { reply(res, 404); return; }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); reply(res, 405); return; }
    if (active >= maxRequests) { res.setHeader("Retry-After", "1"); reply(res, 503); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) { reply(res, 415); return; }
    // Authenticated health probes do not keep an otherwise idle core alive.
    lastActivityAtMs = now();
    const bodyLimit = desktopBinding || clientLease ? Math.min(maxBody, 4096) : maxBody;
    if (Number(req.headers["content-length"] ?? 0) > bodyLimit) { reply(res, 413); return; }
    active++;
    let protocol: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    // A disconnected/timed-out response must not release its work slot early.
    const deadline = setTimeout(() => { reply(res, 504); req.destroy(); }, timeout);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const data of req) {
        const chunk = Buffer.from(data as Uint8Array);
        bytes += chunk.length;
        if (bytes > bodyLimit) { reply(res, 413); return; }
        chunks.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reply(res, 400); return; }
      if (res.destroyed || res.writableEnded) return;
      if (clientLease) {
        const input = body as Record<string, unknown> | null;
        if (!input || Array.isArray(input) || typeof input.action !== "string") { reply(res, 400); return; }
        if (input.action === "register" && Object.keys(input).length === 1) {
          const clientId = options.clientLeases!.register();
          options.onClientLeaseChange?.(); reply(res, 200, { clientId }); return;
        }
        if ((input.action === "renew" || input.action === "unregister")
          && Object.keys(input).sort().join(",") === "action,clientId" && typeof input.clientId === "string") {
          const accepted = input.action === "renew" ? options.clientLeases!.renew(input.clientId)
            : options.clientLeases!.unregister(input.clientId);
          options.onClientLeaseChange?.(); reply(res, accepted ? 200 : 410, { accepted }); return;
        }
        reply(res, 400); return;
      }
      if (desktopBinding) {
        const input = body as Record<string, unknown> | null;
        if (!input || Array.isArray(input) || Object.keys(input).sort().join(",") !== "pipePath,taskId"
          || typeof input.pipePath !== "string" || typeof input.taskId !== "string") { reply(res, 400); return; }
        const accepted = await options.bindDesktop!(input.pipePath, input.taskId);
        reply(res, accepted ? 200 : 403, { accepted }); return;
      }
      protocol = createProtocol();
      transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK HTTP callbacks explicitly include undefined, unlike its Transport interface.
      await protocol.connect(transport as Transport);
      await transport.handleRequest(req, res, body);
    } catch { reply(res, 500, { error: "HTTP_REQUEST_FAILED" }); }
    finally {
      clearTimeout(deadline);
      // Only protocol resources are closed here, never the shared service/store/monitor.
      await protocol?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      active--;
    }
  };
  const server = createServer((req, res) => {
    const pending = handle(req, res).catch(() => { reply(res, 500, { error: "HTTP_REQUEST_FAILED" }); });
    work.add(pending);
    void pending.finally(() => work.delete(pending));
  });
  server.maxConnections = options.maxConnections ?? 64;
  server.maxHeadersCount = 32;
  server.headersTimeout = Math.min(timeout, 10_000);
  server.requestTimeout = timeout;
  server.keepAliveTimeout = 5_000;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP_BIND_FAILED");
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    diagnostics: () => ({ activeRequests: active, connections: sockets.size, lastActivityAtMs }),
    async close(): Promise<void> {
      closing = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...work]);
      await closed;
    },
  };
}

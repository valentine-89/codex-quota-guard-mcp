import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHttpServer } from "../src/http-server.js";
import { ClientLeaseRegistry } from "../src/client-leases.js";
import { taskContext } from "../src/task-context.js";

test("authenticated task contexts stay request-local and require live leases", async () => {
  const leases = new ClientLeaseRegistry(), token = randomBytes(32).toString("base64url");
  const leaseA = leases.register(), leaseB = leases.register(), taskA = randomUUID(), taskB = randomUUID();
  const seen: string[] = [];
  const http = await startHttpServer(() => {
    const server = new McpServer({ name: "test", version: "1" });
    server.registerTool("context", { inputSchema: {} }, async () => {
      await new Promise(yes => setTimeout(yes, 5));
      const context = taskContext.getStore();
      return { content: [{ type: "text" as const, text: JSON.stringify(context ?? null) }] };
    }); return server;
  }, { token, clientLeases: leases, bindTask: async context => { seen.push(context.taskId); } });
  const clients: Client[] = [];
  async function connect(taskId: string, clientId: string, desktop: boolean) {
    const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: "legacy" } }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: {
      Authorization: `Bearer ${token}`, "X-Guard-Task": taskId, "X-Guard-Client": clientId, "X-Guard-Desktop": String(desktop),
    } } })); return client;
  }
  try {
    const a = await connect(taskA, leaseA, false), b = await connect(taskB, leaseB, true);
    const [one, two] = await Promise.all([a.callTool({ name: "context", arguments: {} }), b.callTool({ name: "context", arguments: {} })]);
    assert.match(JSON.stringify(one), new RegExp(taskA)); assert.doesNotMatch(JSON.stringify(one), new RegExp(taskB));
    assert.match(JSON.stringify(two), new RegExp(taskB)); assert.ok(seen.includes(taskA));
    leases.unregister(leaseA);
    const result = await a.callTool({ name: "context", arguments: {} }); assert.match(JSON.stringify(result), /null/);
  } finally { await Promise.all(clients.map(c => c.close())); await http.close(); }
});

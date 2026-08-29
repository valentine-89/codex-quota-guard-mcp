import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

test("MCP handshake exposes exactly the five public tools and returns structured quota", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-mcp-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const service = new QuotaGuardService(testConfig(join(directory, "state.sqlite")), store, {
    readQuota: async () => rawQuota(25),
  }, { now: () => 1_000 });
  const server = createMcpServer(service);
  const client = new Client({ name: "quota-guard-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "checkpoint_create",
      "checkpoint_get",
      "defer_until_reset",
      "job_preflight",
      "quota_status",
    ]);
    const response = await client.callTool({ name: "quota_status", arguments: {} });
    const structured = response.structuredContent as Record<string, unknown>;
    const fiveHour = structured.fiveHour as Record<string, unknown>;
    assert.equal(fiveHour.remainingPercent, 75);
    assert.equal(structured.source, "codex-app-server");
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, SERVER_INSTRUCTIONS } from "../src/mcp-server.js";
import { isHostWorkspaceRoot } from "../src/host-path.js";
import { QuotaGuardService } from "../src/service.js";
import { StateStore } from "../src/store.js";
import { rawQuota, testConfig } from "./helpers.js";

test("stable MCP discovery exposes instructions, adaptive profile, and defer lifecycle tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-mcp-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  let reads = 0;
  const service = new QuotaGuardService(testConfig(join(directory, "state.sqlite")), store, {
    readQuota: async () => { reads++; return rawQuota(25); },
  }, { now: () => 1_000 });
  const handler = createMcpHandler(() => createMcpServer(service), { legacy: "stateless" });
  const client = new Client({ name: "quota-guard-test", version: "2.0.1" }, {
    versionNegotiation: { mode: "legacy" },
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(client.getServerVersion()?.version, "2.0.1");
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(client.getInstructions() ?? "", /checkAgainBy/);
    assert.match(client.getInstructions() ?? "", /never interrupt an atomic or unsafe operation/);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "checkpoint_create",
      "checkpoint_get",
      "defer_automation_attach",
      "defer_until_reset",
      "job_preflight",
      "quota_profile",
      "quota_status",
      "resume_prepare",
    ]);
    const oldAgent = await client.callTool({ name: "quota_status", arguments: {} });
    assert.equal(oldAgent.isError, true);
    assert.match(JSON.stringify(oldAgent.content), /AUTO_RESET_AGENT_REQUIRED/);
    const oldPreflight = await client.callTool({ name: "job_preflight", arguments: {
      workspaceRoot: directory, taskId: "task", jobId: "old", jobClass: "small", description: "old agent",
    } });
    assert.equal(oldPreflight.isError, true);
    assert.match(JSON.stringify(oldPreflight.content), /AUTO_RESET_AGENT_REQUIRED/);
    const response = await client.callTool({ name: "quota_status", arguments: { agentProtocol: "auto-reset-v1", detail: "compact" } });
    const structured = response.structuredContent as Record<string, unknown>;
    const fiveHour = structured.fiveHour as Record<string, unknown>;
    assert.equal(fiveHour.remainingPercent, 75);
    assert.equal(structured.source, "codex-app-server");
    assert.equal((structured.profile as Record<string, unknown>).baselineRemainingPercent, 10);
    assert.equal(structured.format, "compact-v1");
    assert.equal(structured.activeBucket, undefined);
    const text = response.content.find(item => item.type === "text");
    assert.ok(text?.type === "text");
    assert.deepEqual(JSON.parse(text.text), structured);
    assert.equal(text.text.includes("\n"), false);
    const full = await client.callTool({ name: "quota_status", arguments: {
      agentProtocol: "auto-reset-v1", detail: "full",
    } });
    const fullData = full.structuredContent as Record<string, unknown>;
    assert.ok(fullData.activeBucket);
    assert.ok(fullData.buckets);
    assert.equal(reads, 1, "detail selection must not refresh quota");
    const summary = await client.callTool({ name: "quota_status", arguments: { agentProtocol: "auto-reset-v1" } });
    assert.equal((summary.structuredContent as Record<string, unknown>).format, "summary-v1");
    assert.ok(Buffer.byteLength(JSON.stringify(summary.structuredContent)) <= 1_024);
    assert.equal(reads, 1);
    const invalid = await client.callTool({ name: "quota_status", arguments: {
      agentProtocol: "auto-reset-v1", detail: "full", forceRefresh: true,
    } });
    assert.equal(invalid.isError, true);
    assert.equal(reads, 1);
    const missingId = await client.callTool({ name: "job_preflight", arguments: {
      agentProtocol: "auto-reset-v1", workspaceRoot: directory, taskId: "task", jobClass: "small", description: "missing job ID",
    } });
    assert.equal(missingId.isError, true);
    const relativePath = await client.callTool({ name: "job_preflight", arguments: {
      agentProtocol: "auto-reset-v1", workspaceRoot: "relative", taskId: "task", jobId: "one", jobClass: "small", description: "invalid path",
    } });
    assert.equal(relativePath.isError, true);
    const job = { agentProtocol: "auto-reset-v1", workspaceRoot: directory, taskId: "task", jobId: "one", jobClass: "small", description: "inspection" };
    const first = (await client.callTool({ name: "job_preflight", arguments: job })).structuredContent as Record<string, unknown>;
    const retry = (await client.callTool({ name: "job_preflight", arguments: job })).structuredContent as Record<string, unknown>;
    assert.equal(first.admissionRecorded, true);
    assert.equal(first.format, "summary-v1");
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1_024);
    const fullJob = (await client.callTool({ name: "job_preflight", arguments: { ...job, detail: "full" } }))
      .structuredContent as Record<string, unknown>;
    assert.ok((fullJob.quota as Record<string, unknown>).activeBucket);
    assert.equal(fullJob.admissionRecorded, false);
    assert.equal(retry.admissionRecorded, false);
    const adjustment = await client.callTool({ name: "quota_profile", arguments: { action: "adjust", deltaPercent: -3 } });
    assert.equal((adjustment.structuredContent as Record<string, unknown>).effectiveThresholdPercent, 7);
    const reset = (await client.callTool({ name: "quota_profile", arguments: { action: "reset" } })).structuredContent as Record<string, unknown>;
    assert.equal(reset.effectiveThresholdPercent, 10);
  } finally {
    await client.close();
    await handler.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace roots cannot be silently reinterpreted across Windows and Linux hosts", () => {
  assert.equal(isHostWorkspaceRoot("D:\\vsys\\project", "win32"), true);
  assert.equal(isHostWorkspaceRoot("\\\\server\\share\\project", "win32"), true);
  assert.equal(isHostWorkspaceRoot("/mnt/d/vsys/project", "win32"), false);
  assert.equal(isHostWorkspaceRoot("/home/user/project", "linux"), true);
  assert.equal(isHostWorkspaceRoot("D:\\vsys\\project", "linux"), false);
});

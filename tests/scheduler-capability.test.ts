import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { schedulerCapabilityReason, schedulerFailureReason } from "../src/scheduler-capability.js";
import { RenewableSchedulerRpc } from "../src/scheduler.js";

const fields = ["heartbeat", "update", "delete", "targetThreadId", "rrule"];
test("shared doctor/runtime discovery rejects missing tool, wrong identity and incomplete contract", () => {
  assert.equal(schedulerCapabilityReason("codex-app-tools", []), "SCHEDULER_TOOL_MISSING");
  assert.equal(schedulerCapabilityReason("other", []), "SCHEDULER_IDENTITY_UNSUPPORTED");
  for (const missing of fields) {
    assert.equal(schedulerCapabilityReason("codex-app-tools", [{ name: "automation_update",
      inputSchema: { enum: fields.filter(field => field !== missing) } }]), "SCHEDULER_SCHEMA_UNSUPPORTED");
  }
  assert.equal(schedulerCapabilityReason("codex-app-tools", [{ name: "automation_update",
    inputSchema: { enum: fields } }]), null);
});

test("scheduler diagnostics never expose arbitrary host errors", () => {
  assert.equal(schedulerFailureReason(new Error("private pipe path or credentials")), "SCHEDULER_DISCOVERY_FAILED");
  assert.equal(schedulerFailureReason(new Error("SCHEDULER_TOOL_MISSING")), "SCHEDULER_TOOL_MISSING");
});

test("simulated macOS binding reports failure and recovery without losing a verified binding", async () => {
  let failure: string | null = "SCHEDULER_TOOL_MISSING";
  const rpc = new RenewableSchedulerRpc(resolve("src/scheduler.ts"), () => ({
    ready: async () => {}, close: async () => {}, call: async () => true,
    verifyContext: async () => { if (failure) throw Error(failure); },
  }), "darwin");
  const task = randomUUID();
  try {
    assert.equal(rpc.unavailableReason(), "SCHEDULER_NOT_BOUND");
    assert.equal(await rpc.bind("relative.sock", task), false);
    assert.equal(rpc.unavailableReason(), "SCHEDULER_ENDPOINT_INVALID");
    assert.equal(await rpc.bind("/tmp/host.sock", "invalid"), false);
    assert.equal(rpc.unavailableReason(), "SCHEDULER_TASK_INVALID");
    for (const reason of ["SCHEDULER_TOOL_MISSING", "SCHEDULER_SCHEMA_UNSUPPORTED", "SCHEDULER_CONTEXT_REJECTED"]) {
      failure = reason;
      assert.equal(await rpc.bind("/tmp/host.sock", task), false);
      assert.equal(rpc.unavailableReason(), reason);
    }
    failure = null;
    assert.equal(await rpc.bind("/tmp/host.sock", task), true);
    assert.equal(rpc.unavailableReason(), null);
    failure = "private host error";
    assert.equal(await rpc.bind("/tmp/replacement.sock", task), false);
    assert.equal(rpc.available(), true);
    assert.equal(rpc.unavailableReason(), null);
  } finally { await rpc.close(); }
  assert.equal(rpc.unavailableReason(), "SCHEDULER_CLOSED");
});

test("missing and invalid server configuration have distinct diagnostics", async () => {
  const missing = new RenewableSchedulerRpc("");
  const invalid = new RenewableSchedulerRpc("relative.mjs");
  try {
    assert.equal(missing.unavailableReason(), "SCHEDULER_SERVER_UNCONFIGURED");
    assert.equal(invalid.unavailableReason(), "SCHEDULER_SERVER_INVALID");
  } finally { await missing.close(); await invalid.close(); }
});

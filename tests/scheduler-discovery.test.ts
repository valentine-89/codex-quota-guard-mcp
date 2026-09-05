import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerFromResources } from "../src/scheduler-discovery.js";
import { RenewableSchedulerRpc } from "../src/scheduler.js";

test("scheduler resolves on startup and repeats discovery on binding", async () => {
  let calls = 0;
  const rpc = new RenewableSchedulerRpc("stale-saved-path", undefined, "win32", () => { calls++; return ""; });
  assert.equal(calls, 1);
  assert.equal(rpc.available(), false);
  assert.equal(await rpc.bind("\\\\.\\pipe\\runtime-test", "01a06e49-2c2a-78c1-888d-d363531a0eb2"), false);
  assert.equal(calls, 2);
  await rpc.close();
});

test("discovery handles changed application resources without choosing ambiguous installs", () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-discovery-"));
  const roots = [join(dir, "old"), join(dir, "new")];
  const files = roots.map(root => join(root, "plugins/openai-bundled/plugins/codex-app-tools/server.mjs"));
  try {
    assert.equal(schedulerFromResources(["relative", ...roots]), undefined);
    for (const file of files) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, ""); }
    assert.equal(schedulerFromResources([roots[0]!, roots[0]!]), files[0]);
    assert.throws(() => schedulerFromResources(roots), /AMBIGUOUS/);
    rmSync(files[0]!);
    assert.equal(schedulerFromResources(roots), files[1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

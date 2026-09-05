import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerFromResources } from "../src/scheduler-discovery.js";

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

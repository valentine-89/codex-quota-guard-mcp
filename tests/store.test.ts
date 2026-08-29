import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/store.js";

test("refresh lease is shared and expired owners are recoverable", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-store-"));
  const path = join(directory, "state.sqlite");
  const first = new StateStore(path);
  const second = new StateStore(path);
  try {
    assert.equal(first.tryAcquireLease("profile", "owner-a", 1_000, 500), true);
    assert.equal(second.tryAcquireLease("profile", "owner-b", 1_100, 500), false);
    assert.equal(second.tryAcquireLease("profile", "owner-b", 1_501, 500), true);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint round-trips atomically and redacts likely secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-checkpoint-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  try {
    const checkpoint = store.createCheckpoint("profile", {
      workspaceRoot: directory,
      taskId: "task-1",
      objective: "Finish safely",
      completed: ["configured Authorization: Bearer secret-value-that-must-not-leak"],
      pending: ["run tests"],
    }, 2_000, 1_000);
    const loaded = store.getCheckpoint("profile", directory, "task-1");
    assert.equal(loaded?.id, checkpoint.id);
    assert.match(loaded?.completed[0] ?? "", /\[REDACTED\]/);
    assert.equal(loaded?.resumeAt, new Date(2_000).toISOString());
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backoff state is shared and grows with bounded jitter", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-backoff-"));
  const first = new StateStore(join(directory, "state.sqlite"));
  const second = new StateStore(join(directory, "state.sqlite"));
  try {
    const one = first.recordFailure("profile", "rate-limit", "429", 0, null, () => 0.5);
    const two = second.recordFailure("profile", "rate-limit", "429", one.untilMs, null, () => 0.5);
    assert.equal(one.untilMs, 60_000);
    assert.equal(two.untilMs, 180_000);
    assert.equal(first.getBackoff("profile")?.failureCount, 2);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

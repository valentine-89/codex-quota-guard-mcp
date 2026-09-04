import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { stableHash, StateStore } from "../src/store.js";

test("refresh lease is shared and expired owners are recoverable", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-store-"));
  const path = join(directory, "state.sqlite");
  const first = new StateStore(path);
  const second = new StateStore(path);
  try {
    assert.equal(first.tryAcquireLease("profile", "owner-a", 1_000, 500), true);
    assert.equal(first.tryAcquireLease("profile", "owner-a", 1_100, 500), false);
    assert.equal(second.tryAcquireLease("profile", "owner-b", 1_100, 500), false);
    assert.equal(second.tryAcquireLease("profile", "owner-b", 1_501, 500), true);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v3 upgrades to v4 without losing checkpoints", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-schema-"));
  const path = join(directory, "state.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, profile_key TEXT NOT NULL, workspace_hash TEXT NOT NULL,
    workspace_root TEXT NOT NULL, task_id TEXT, payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL, resume_at_ms INTEGER
  ); PRAGMA user_version=3;`);
  const payload = { workspaceRoot: directory, taskId: "task", objective: "preserve", completed: [], pending: [] };
  legacy.prepare("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?,?)").run(
    "checkpoint", "profile", stableHash(resolve(directory).toLocaleLowerCase()), directory, "task", JSON.stringify(payload), 1_000, null);
  legacy.close();
  const store = new StateStore(path);
  try {
    assert.equal(store.getCheckpoint("profile", directory, "task")?.objective, "preserve");
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    check.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("automatic reset recommendation is stable across store instances for one epoch", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-reset-store-"));
  const path = join(directory, "state.sqlite");
  const first = new StateStore(path);
  const second = new StateStore(path);
  const identity = { key: "profile", fingerprint: "account", planType: "plus", limitId: "codex" };
  try {
    const one = first.getOrCreateResetRecommendation(identity, "reset-a", 2, 2, "inventory", 1_000);
    const two = second.getOrCreateResetRecommendation(identity, "reset-a", 2, 2, "inventory", 1_001);
    assert.equal(two.id, one.id);
    assert.equal(two.idempotencyKey, one.idempotencyKey);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
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

test("passive learning is idempotent, rolls observations, and separates homogeneous job classes", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-learning-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const identity = { key: "profile", fingerprint: "account", planType: "plus", limitId: "codex" };
  try {
    store.observeFreshQuota(identity, 10, "reset-a", 1_000, 20);
    for (let index = 0; index < 3; index += 1) {
      const recorded = store.recordAdmission(identity, {
        jobId: `job-${index}`, taskId: "task", workspaceRoot: directory, jobClass: "long",
      }, 10 + index * 6, "reset-a", 2_000 + index * 2_000);
      assert.equal(recorded, true);
      assert.equal(store.recordAdmission(identity, {
        jobId: `job-${index}`, taskId: "task", workspaceRoot: directory, jobClass: "long",
      }, 10 + index * 6, "reset-a", 2_001 + index * 2_000), false);
      store.observeFreshQuota(identity, 16 + index * 6, "reset-a", 3_000 + index * 2_000, 20);
    }
    const learned = store.getLearning(identity, "long", 20, 3);
    assert.equal(learned.count, 3);
    assert.equal(learned.mean, 6);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mixed job classes update only the global passive mean and reset discards pending admissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-mixed-learning-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  const identity = { key: "profile", fingerprint: "account", planType: "plus", limitId: "codex" };
  try {
    store.observeFreshQuota(identity, 20, "reset-a", 1_000, 20);
    store.recordAdmission(identity, { jobId: "small", taskId: "task", workspaceRoot: directory, jobClass: "small" }, 20, "reset-a", 2_000);
    store.recordAdmission(identity, { jobId: "long", taskId: "task", workspaceRoot: directory, jobClass: "long" }, 20, "reset-a", 2_001);
    store.observeFreshQuota(identity, 30, "reset-a", 3_000, 20);
    assert.equal(store.getLearning(identity, null, 20, 1).mean, 5);
    assert.equal(store.getLearning(identity, "long", 20, 1).mean, 5);

    store.recordAdmission(identity, { jobId: "discard", taskId: "task", workspaceRoot: directory, jobClass: "long" }, 30, "reset-a", 4_000);
    store.observeFreshQuota(identity, 0, "reset-b", 5_000, 20);
    store.observeFreshQuota(identity, 8, "reset-b", 6_000, 20);
    assert.equal(store.getLearning(identity, null, 20, 1).count, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profile overrides persist and reset per account and plan", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-overrides-"));
  const path = join(directory, "state.sqlite");
  let store = new StateStore(path);
  try {
    assert.equal(store.adjustOverride("profile", "account", "plus", 4, 1_000), 4);
    store.close();
    store = new StateStore(path);
    assert.equal(store.getOverride("profile", "account", "plus"), 4);
    assert.equal(store.getOverride("profile", "other", "plus"), 0);
    store.resetOverride("profile", "account", "plus");
    assert.equal(store.getOverride("profile", "account", "plus"), 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual resume supersedes only matching quota-guard defers", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-defers-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  try {
    const firstCheckpoint = store.createCheckpoint("profile", {
      workspaceRoot: directory, taskId: "task-a", objective: "one", completed: [], pending: ["one"],
    }, 2_000, 1_000);
    const secondCheckpoint = store.createCheckpoint("profile", {
      workspaceRoot: directory, taskId: "task-b", objective: "two", completed: [], pending: ["two"],
    }, 2_000, 1_000);
    const first = store.createDefer("profile", firstCheckpoint, "task-a", 2_000, 1_000);
    const second = store.createDefer("profile", secondCheckpoint, "task-b", 2_000, 1_000);
    store.attachAutomation("profile", first.id, "owned-a", 1_100);
    store.attachAutomation("profile", second.id, "unrelated-b", 1_100);
    const prepared = store.prepareResume("profile", directory, "task-a", undefined, "manual", 1_200);
    assert.deepEqual(prepared.automationIdsToCancel, ["owned-a"]);
    assert.equal(store.getDefer("profile", first.id)?.state, "superseded");
    assert.equal(store.getDefer("profile", second.id)?.state, "active");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual resume is scoped to the selected quota role", () => {
  const directory = mkdtempSync(join(tmpdir(), "quota-guard-role-defers-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  try {
    const primaryCheckpoint = store.createCheckpoint("profile", {
      workspaceRoot: directory, taskId: "task", objective: "primary", completed: [], pending: ["main"], laneId: "primary",
    }, 2_000, 1_000);
    const secondaryCheckpoint = store.createCheckpoint("profile", {
      workspaceRoot: directory, taskId: "task", objective: "secondary", completed: [], pending: ["light"], laneId: "secondary",
    }, 2_000, 1_000);
    const primary = store.createDefer("profile", primaryCheckpoint, "task", 2_000, 1_000, "primary");
    const secondary = store.createDefer("profile", secondaryCheckpoint, "task", 2_000, 1_000, "secondary");
    store.attachAutomation("profile", primary.id, "primary-auto", 1_100);
    store.attachAutomation("profile", secondary.id, "secondary-auto", 1_100);
    const prepared = store.prepareResume("profile", directory, "task", undefined, "manual", 1_200, "secondary");
    assert.deepEqual(prepared.automationIdsToCancel, ["secondary-auto"]);
    assert.equal(store.getDefer("profile", secondary.id)?.state, "superseded");
    assert.equal(store.getDefer("profile", primary.id)?.state, "active");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify, parse } from "smol-toml";
import { DesktopSchedulerBridge, EARLY_RRULE, type SchedulerRpc } from "../src/scheduler.js";
import { StateStore } from "../src/store.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quota-scheduler-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  const checkpoint = store.createCheckpoint("p", { workspaceRoot: dir, taskId: "task", objective: "wait", completed: [], pending: [] }, 20_000, 1_000);
  const created = store.createDefer("p", checkpoint, "task", 20_000, 1_000);
  const defer = store.attachAutomation("p", created.id, "owned", 1_000)!;
  const parent = join(dir, "automations", "owned"); mkdirSync(parent, { recursive: true });
  const file = join(parent, "automation.toml");
  const initial = { version: 1, id: "owned", kind: "heartbeat", name: "test", status: "ACTIVE", rrule: "FREQ=MINUTELY;INTERVAL=115",
    prompt: `resume_prepare ${defer.id} ${checkpoint.id}`, target_thread_id: "task", created_at: 1_000, updated_at: 1_000,
    notification_policy: "failed_runs_only" };
  writeFileSync(file, stringify(initial));
  const calls: Record<string, unknown>[] = [];
  let onReady = (): void => {};
  const rpc: SchedulerRpc = { ready: async () => { onReady(); }, close: async () => {},
    call: async args => { calls.push(args); return true; } };
  return { dir, file, defer, initial, calls, bridge: new DesktopSchedulerBridge(dir, rpc, () => true),
    onReady: (fn: () => void) => { onReady = fn; },
    write: (patch: Record<string, unknown>) => writeFileSync(file, stringify({ ...initial, ...patch })),
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("scheduler updates only exact owned heartbeat and preserves prompt/notification", async () => {
  const f = fixture();
  try {
    const definition = (await f.bridge.read(f.defer))!;
    assert.ok(definition);
    assert.equal(await f.bridge.advance(f.defer, definition, () => true), true);
    assert.equal(f.calls[0]?.rrule, EARLY_RRULE);
    assert.equal(f.calls[0]?.prompt, f.initial.prompt);
    assert.equal(f.calls[0]?.notificationPolicy, "failed_runs_only");
    // Adapter never writes TOML itself.
    assert.equal(parse(readFileSync(f.file, "utf8")).rrule, f.initial.rrule);
    f.write({ rrule: EARLY_RRULE, updated_at: 9_000 });
    assert.equal(await f.bridge.cancel(f.defer, f.bridge.expected(definition), () => true), true);
    assert.equal(f.calls[1]?.mode, "delete");
  } finally { f.close(); }
});

test("paused, unrelated, unsafe path and unknown schema records cannot be advanced", async () => {
  const f = fixture();
  try {
    for (const patch of [{ status: "PAUSED" }, { target_thread_id: "other" }, { prompt: "unrelated" }, { future_field: true }]) {
      f.write(patch); assert.equal(await f.bridge.read(f.defer), null);
    }
    assert.equal(await f.bridge.read({ ...f.defer, automationId: "../owned" }), null);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test("user edits during connect or after advance are not overwritten/deleted", async () => {
  const f = fixture();
  try {
    const definition = (await f.bridge.read(f.defer))!;
    f.onReady(() => f.write({ name: "user edit" }));
    let claimed = false;
    assert.equal(await f.bridge.advance(f.defer, definition, () => { claimed = true; return true; }), false);
    assert.equal(claimed, false);
    assert.equal(await f.bridge.cancel(f.defer, f.bridge.expected(definition), () => true), true);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

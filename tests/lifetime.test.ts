import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ProcessLifetime, type ExitReason } from "../src/lifetime.js";

function fixture(options: { alive?: () => boolean; cleanup?: () => Promise<void> } = {}) {
  const input = new EventEmitter(), output = new EventEmitter();
  let cleanups = 0;
  const exits: Array<{ code: number; reason: ExitReason }> = [];
  const lifetime = new ProcessLifetime({ input, output, parentAlive: options.alive ?? (() => true),
    cleanup: async () => { cleanups++; await options.cleanup?.(); }, exit: (code, reason) => { exits.push({ code, reason }); },
    initializeTimeoutMs: 40, parentCheckMs: 10, shutdownTimeoutMs: 30 });
  return { input, output, lifetime, exits, cleanups: () => cleanups };
}

test("all broken stream signals clean up exactly once", async () => {
  for (const [which, event] of [["input", "end"], ["input", "close"], ["input", "error"], ["output", "close"], ["output", "error"]] as const) {
    const f = fixture();
    try {
      f.lifetime.markInitialized(); f[which].emit(event);
      f.lifetime.stop("signal"); f.lifetime.stop("transport_closed");
      await delay(0);
      assert.equal(f.cleanups(), 1); assert.equal(f.exits.length, 1);
      assert.equal(f.exits[0]?.code, 0);
    } finally { f.lifetime.dispose(); }
  }
});

test("uninitialized connection expires but a connected idle session does not", async () => {
  const abandoned = fixture(), connected = fixture();
  try {
    connected.lifetime.markInitialized();
    await delay(75);
    assert.equal(abandoned.exits[0]?.reason, "initialize_timeout");
    assert.equal(connected.exits.length, 0);
    assert.equal(connected.lifetime.status().initialized, true);
  } finally { abandoned.lifetime.dispose(); connected.lifetime.dispose(); }
});

test("missing parent self-terminates without touching other processes", async () => {
  let alive = true;
  const f = fixture({ alive: () => alive });
  try {
    f.lifetime.markInitialized(); alive = false;
    await delay(35);
    assert.equal(f.exits[0]?.reason, "parent_exited");
  } finally { f.lifetime.dispose(); }
});

test("hung cleanup has a bounded exit deadline", async () => {
  const f = fixture({ cleanup: () => new Promise(() => {}) });
  try {
    f.input.emit("end"); await delay(55);
    assert.deepEqual(f.exits, [{ code: 1, reason: "stdin_end" }]);
  } finally { f.lifetime.dispose(); }
});

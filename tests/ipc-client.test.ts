import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IpcClient } from "../src/ipc-client.js";

const task = "01a07567-0611-7fb0-b7e7-9c15cbfcff81";
async function fixture(mode = "ok") {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\guard-test-${randomUUID()}` : join(tmpdir(), `guard-${randomUUID()}.sock`);
  const sockets = new Set<Socket>(); let sends = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const send = (value: object) => { const b = Buffer.from(JSON.stringify(value)), h = Buffer.alloc(4); h.writeUInt32LE(b.length); socket.write(h); socket.write(b); };
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(); const m = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        if (m.type === "broadcast" && m.method === "thread-stream-following-changed") {
          send({ type: "broadcast", method: "thread-stream-state-changed", version: mode === "version" ? 12 : 11,
            sourceClientId: "owner", params: { hostId: "local", conversationId: task, change: { type: "snapshot",
              conversationState: { id: task, cwd: process.cwd(), rolloutPath: join(process.cwd(), "sessions", "test.jsonl"),
                threadRuntimeStatus: { type: mode === "busy" ? "active" : "idle" }, turns: [] } } } });
        }
        if (m.type !== "request") continue;
        if (mode === "frame") { const h = Buffer.alloc(4); h.writeUInt32LE(9_000_000); socket.write(h); continue; }
        let result: object = { clientId: "probe" };
        if (m.method === "thread-owner-discovery") result = { supportsUntrustedAppInput: mode !== "capability" };
        if (m.method === "thread-follower-start-turn") {
          sends++; assert.equal(m.targetClientId, "owner"); assert.equal(m.version, 2);
          assert.equal(m.params.turnStart.context.responseItems.length, 1);
          if (mode === "disconnect") { socket.destroy(); continue; }
          if (mode === "timeout") continue;
          result = { result: { turn: { id: "new-turn", status: "inProgress" } } };
        }
        send({ type: "response", requestId: m.requestId, method: m.method, resultType: "success",
          handledByClientId: mode === "wrong-owner" && m.method === "thread-follower-start-turn" ? "other" : "owner", result });
      }
    });
  });
  await new Promise<void>(yes => server.listen(endpoint, yes));
  const client = new IpcClient(endpoint, 150);
  return { client, sends: () => sends, close: async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(yes => server.close(() => yes())); } };
}
test("follower protocol reads state and dispatches only to verified owner", async () => {
  const f = await fixture(); try {
    await f.client.connect(); const snapshot = await f.client.inspect(task); assert.equal(snapshot.idle, true);
    assert.equal(await f.client.send(snapshot, process.cwd(), "test", () => true), "new-turn"); assert.equal(f.sends(), 1);
  } finally { await f.close(); }
});
for (const mode of ["busy", "version", "capability", "frame", "disconnect", "timeout", "wrong-owner"]) {
  test(`IPC fails closed for ${mode}`, async () => {
    const f = await fixture(mode); try {
      await assert.rejects(async () => { await f.client.connect(); const snapshot = await f.client.inspect(task);
        await f.client.send(snapshot, process.cwd(), "test", () => true); });
      assert.equal(f.sends(), ["disconnect", "timeout", "wrong-owner"].includes(mode) ? 1 : 0);
    } finally { await f.close(); }
  });
}
test("workspace mismatch or withdrawn authorization never writes a start request", async () => {
  const f = await fixture(); try {
    await f.client.connect(); const s = await f.client.inspect(task);
    await assert.rejects(f.client.send(s, join(process.cwd(), "other"), "test", () => true));
    await assert.rejects(f.client.send(s, process.cwd(), "test", () => false)); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

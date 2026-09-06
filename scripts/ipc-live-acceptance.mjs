// Explicit same-task transport acceptance. Does not read/write Guard quota or checkpoint state.
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcClient } from "../dist/ipc-client.js";

const { values } = parseArgs({ options: { "send-on-idle": { type: "boolean", default: false }, "parent-pid": { type: "string" } } });
const task = process.env.CODEX_THREAD_ID;
if (!task || process.platform !== "win32") throw Error("Run from a Windows Codex task.");
const parent = Number(values["parent-pid"]);
if (values["send-on-idle"] && (!Number.isInteger(parent) || parent < 1)) throw Error("Explicit app-server parent PID required for the one-shot send test.");
const client = new IpcClient();
const report = value => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
let ended = false, claimed = false;
const parentAlive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
const lifetime = values["send-on-idle"] ? setInterval(() => {
  if (!parentAlive()) { ended = true; client.close(); report({ state: "cancelled", reason: "app-server-exited" }); }
}, 1_000) : undefined;
try {
  await client.connect();
  const deadline = Date.now() + 300_000;
  do {
    const snapshot = await client.inspect(task);
    report({ state: "inspected", taskId: task, idle: snapshot.idle });
    if (!values["send-on-idle"]) break;
    if (snapshot.idle) {
      const prompt = `[Quota Guard 2.3.0 IPC acceptance] This single automatic input was authorized by the user as part of the implementation acceptance test. Confirm that input arrived in this same task through the new IPC adapter. Do not call Quota Guard for this transport test. Then inspect the acceptance log at ${JSON.stringify(join(tmpdir(), "guard-230-ipc-acceptance.log"))} and continue the already authorized implementation/release verification, reporting any remaining gates honestly. Do not schedule another acceptance input.`;
      const turnId = await client.send(snapshot, snapshot.cwd, prompt, () => {
        if (ended || claimed || !parentAlive()) return false;
        claimed = true; report({ state: "dispatching", taskId: task }); return true;
      });
      report({ state: "acknowledged", taskId: task, turnId }); break;
    }
    await delay(5_000);
  } while (!ended && Date.now() < deadline);
  if (values["send-on-idle"] && !claimed) report({ state: "no-dispatch", reason: "task-busy-or-app-closed" });
} catch (error) {
  report({ state: claimed ? "uncertain" : "failed", reason: error.message }); process.exitCode = 1;
} finally { if (lifetime) clearInterval(lifetime); client.close(); }

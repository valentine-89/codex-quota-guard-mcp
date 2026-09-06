import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

type Message = Record<string, unknown>;
const object = (value: unknown): Message => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Message : {};
export const IPC_ENDPOINT = "\\\\.\\pipe\\codex-ipc";
export interface IpcSnapshot { owner: string; taskId: string; cwd: string; rolloutPath: string; idle: boolean }
export function ipcPath(value: string): string {
  // Windows snapshots may use the extended-length spelling of the same local path.
  const ordinary = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");
  return resolve(ordinary).toLowerCase();
}

/** Versioned local follower protocol observed in OpenAI extension 26.901.22334.
 * No router creation, alternate endpoints, auth reads, or CLI resume. */
export class IpcClient {
  private socket: Socket | undefined;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private clientId = "initializing-client";
  private pending = new Map<string, { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private snapshotWaiter: ((message: Message) => void) | undefined;
  private snapshot: IpcSnapshot | undefined;
  private rejectSnapshot: (() => void) | undefined;
  constructor(private readonly endpoint = IPC_ENDPOINT, private readonly timeoutMs = 10_000) {}

  async connect(): Promise<void> {
    const socket = createConnection(this.endpoint);
    this.socket = socket;
    socket.on("data", chunk => this.receive(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => { this.close(); no(new Error("IPC_CONNECT_TIMEOUT")); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); yes(); });
      socket.once("error", () => { clearTimeout(timer); no(new Error("IPC_UNAVAILABLE")); });
    });
    const response = await this.request("initialize", { clientType: "quota-guard-ipc" }, 0);
    const id = object(response.result).clientId;
    if (typeof id !== "string" || !id) throw new Error("IPC_INITIALIZE_INVALID");
    this.clientId = id;
  }
  private write(message: Message): void {
    const body = Buffer.from(JSON.stringify(message));
    if (!this.socket || this.socket.destroyed || body.length > 65_536 || this.socket.writableLength > 131_072) throw new Error("IPC_CLOSED_OR_BUSY");
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8_388_608 || length === 0) { this.close(); return; }
      if (this.buffer.length < length + 4) return;
      let message: Message;
      try { message = object(JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"))); }
      catch { this.close(); return; }
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === "response") {
        const id = String(message.requestId); const waiter = this.pending.get(id);
        if (waiter) { clearTimeout(waiter.timer); this.pending.delete(id); waiter.resolve(message); }
      } else if (message.type === "client-discovery-request") {
        try { this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); } catch { this.close(); }
      } else if (message.type === "broadcast") {
        if (message.method === "thread-stream-state-changed") this.snapshotWaiter?.(message);
        // Any subsequent state update invalidates an idle observation; refresh before dispatch.
        if (this.snapshot && message.sourceClientId === this.snapshot.owner) this.snapshot.idle = false;
      }
    }
  }
  async request(method: string, params: Message, version: number, owner?: string): Promise<Message> {
    if (this.pending.size >= 4) throw new Error("IPC_BUSY");
    const requestId = randomUUID();
    const response = await new Promise<Message>((yes, no) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); no(new Error("IPC_ACK_UNCONFIRMED")); }, this.timeoutMs);
      this.pending.set(requestId, { resolve: yes, reject: no, timer });
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, method, params, version,
        ...(owner ? { targetClientId: owner } : {}), timeoutMs: this.timeoutMs - 500 }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); no(error); }
    });
    if (response.resultType !== "success" || response.method !== method || (owner && response.handledByClientId !== owner)) throw new Error("IPC_RESPONSE_REJECTED");
    return response;
  }
  async owner(taskId: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("IPC_TASK_INVALID");
    const response = await this.request("thread-owner-discovery", { hostId: "local", conversationId: taskId }, 1);
    if (object(response.result).supportsUntrustedAppInput !== true || typeof response.handledByClientId !== "string") throw new Error("IPC_CAPABILITY_UNSUPPORTED");
    return response.handledByClientId;
  }
  async inspect(taskId: string): Promise<IpcSnapshot> {
    const owner = await this.owner(taskId);
    const snapshot = await new Promise<IpcSnapshot>((yes, no) => {
      const timer = setTimeout(() => { this.snapshotWaiter = undefined; no(new Error("IPC_STATE_UNKNOWN")); }, this.timeoutMs);
      this.rejectSnapshot = () => { clearTimeout(timer); this.snapshotWaiter = undefined; no(new Error("IPC_DISCONNECTED")); };
      this.snapshotWaiter = message => {
        const params = object(message.params), change = object(params.change), state = object(change.conversationState);
        if (message.sourceClientId !== owner || params.conversationId !== taskId || params.hostId !== "local") return;
        if (message.version !== 11 || change.type !== "snapshot" || state.id !== taskId || typeof state.cwd !== "string" || typeof state.rolloutPath !== "string") return;
        clearTimeout(timer); this.snapshotWaiter = undefined;
        const turns = Array.isArray(state.turns) ? state.turns : [];
        this.rejectSnapshot = undefined;
        yes({ owner, taskId, cwd: state.cwd, rolloutPath: state.rolloutPath, idle: object(state.threadRuntimeStatus).type === "idle"
          && !turns.some(turn => object(turn).status === "inProgress") });
      };
      try { this.write({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
        sourceClientId: this.clientId, targetClientIds: [owner], params: { hostId: "local", conversationId: taskId, following: true } }); }
      catch (error) { clearTimeout(timer); this.snapshotWaiter = undefined; no(error); }
    });
    this.snapshot = snapshot;
    return snapshot;
  }
  async send(snapshot: IpcSnapshot, cwd: string, prompt: string, authorize: () => boolean): Promise<string> {
    if (await this.owner(snapshot.taskId) !== snapshot.owner || !snapshot.idle
      || ipcPath(snapshot.cwd) !== ipcPath(cwd)) throw new Error("IPC_TASK_NOT_IDLE_OR_CHANGED");
    if (!authorize()) throw new Error("IPC_DISPATCH_CANCELLED");
    const response = await this.request("thread-follower-start-turn", { conversationId: snapshot.taskId,
      turnStart: { request: { threadId: snapshot.taskId, input: [{ type: "text", text: prompt, text_elements: [] }] },
        context: { inheritThreadSettings: true,
          // The verified owner rejects app-context starts while active after asynchronous preparation.
          responseItems: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Scheduled Quota Guard resume; validate the owned defer before continuing." }] }] } } }, 2, snapshot.owner);
    const turn = object(object(object(response.result).result).turn);
    if (typeof turn.id !== "string" || !turn.id || turn.status !== "inProgress") throw new Error("IPC_TURN_UNCONFIRMED");
    return turn.id;
  }
  close(): void {
    const socket = this.socket; this.socket = undefined;
    if (socket && !socket.destroyed) socket.destroy();
    this.snapshot = undefined;
    this.rejectSnapshot?.(); this.rejectSnapshot = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("IPC_DISCONNECTED")); }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
  }
}

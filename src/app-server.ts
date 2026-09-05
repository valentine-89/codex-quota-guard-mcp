import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import type { GuardConfig } from "./config.js";
import { GuardError } from "./errors.js";
import { redactSensitiveText } from "./security.js";
import type { AppServerQuotaResult, RawAccountResponse, RawRateLimitsResponse } from "./types.js";

interface RpcErrorPayload {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: RpcErrorPayload;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatGptIdentity(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.account)
    || response.account.type !== "chatgpt"
    || typeof response.account.email !== "string" || response.account.email.trim() === "") {
    throw new GuardError("CHATGPT_LOGIN_REQUIRED",
      "Quota Guard requires the current stable ChatGPT login; API-key, Bedrock, other providers and signed-out sessions are unsupported.");
  }
  return JSON.stringify({ type: response.account.type, email: response.account.email,
    planType: typeof response.account.planType === "string" ? response.account.planType : null });
}

function parseRetryAfter(data: unknown): number | null {
  if (!isRecord(data)) return null;
  const raw = data.retryAfterMs ?? data.retry_after_ms;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

export function resolveCommand(command: string, envPath = process.env.PATH ?? ""): string {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  const directories = envPath.split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (extname(command) ? [""] : [".exe", ".cmd", ".bat", ""])
    : [""];
  for (const extension of extensions) {
    for (const directory of directories) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export class CodexAppServerClient {
  constructor(private readonly config: GuardConfig) {}

  async readQuota(): Promise<AppServerQuotaResult> {
    const child = this.start();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });

    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.once("close", (code, signal) => {
      const detail = stderr.trim() ? ` ${redactSensitiveText(stderr.trim(), 2_000)}` : "";
      const error = new GuardError("APP_SERVER_EXITED",
        `Codex app-server exited before completing the request (code ${code ?? "none"}, signal ${signal ?? "none"}).${detail}`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
    child.once("error", (error) => {
      const wrapped = new GuardError("CODEX_NOT_FOUND", `Unable to start Codex app-server: ${error.message}`);
      for (const request of pending.values()) request.reject(wrapped);
      pending.clear();
    });

    lines.on("line", (line) => {
      let message: RpcResponse;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) return;
        message = parsed;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        const errorMessage = typeof message.error.message === "string"
          ? message.error.message
          : "Codex app-server RPC failed";
        const codeValue = message.error.code;
        const unsupported = codeValue === -32601 || /method.*not found|unknown method/i.test(errorMessage);
        request.reject(new GuardError(
          unsupported ? "CODEX_UPGRADE_REQUIRED" : "APP_SERVER_RPC_ERROR",
          unsupported
            ? "The installed Codex app-server does not support account/rateLimits/read. Upgrade Codex."
            : errorMessage,
          parseRetryAfter(message.error.data),
        ));
      } else {
        request.resolve(message.result);
      }
    });

    const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (error) {
            pending.delete(id);
            reject(new GuardError("APP_SERVER_WRITE_FAILED", error.message));
          }
        });
      });
    };

    const timer = setTimeout(() => {
      const error = new GuardError("APP_SERVER_TIMEOUT", `Codex app-server did not respond within ${this.config.appServerTimeoutMs} ms.`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      child.kill();
    }, this.config.appServerTimeoutMs);

    try {
      await call("initialize", {
        clientInfo: { name: "codex-quota-guard-mcp", version: "1.0.1" },
        capabilities: { experimentalApi: false },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const account = await call("account/read", { refreshToken: false });
      const identity = chatGptIdentity(account);
      const rateLimits = await call("account/rateLimits/read");
      const verifiedAccount = await call("account/read", { refreshToken: false });
      if (identity !== chatGptIdentity(verifiedAccount)) {
        throw new GuardError("ACCOUNT_CHANGED_DURING_READ", "Account changed while reading quota; wait for shared revalidation.");
      }
      if (!isRecord(account) || !isRecord(rateLimits)) {
        throw new GuardError("APP_SERVER_INVALID_RESPONSE", "Codex app-server returned an invalid account or rate-limit response.");
      }
      return {
        account: account as RawAccountResponse,
        rateLimits: rateLimits as RawRateLimitsResponse,
      };
    } catch (error) {
      if (error instanceof GuardError) throw error;
      const detail = stderr.trim() ? ` ${redactSensitiveText(stderr.trim(), 2_000)}` : "";
      throw new GuardError("APP_SERVER_FAILED", `Unable to read Codex quota.${detail}`);
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      for (const request of pending.values()) {
        request.reject(new GuardError("APP_SERVER_CLOSED", "Codex app-server closed before completing the request."));
      }
      pending.clear();
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    try {
      const resolved = resolveCommand(this.config.codexCommand);
      const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
      const executable = isWindowsScript ? process.env.ComSpec ?? "cmd.exe" : resolved;
      const args = isWindowsScript
        ? ["/d", "/s", "/v:off", "/c", '""%CODEX_QUOTA_GUARD_LAUNCH_COMMAND%" app-server --stdio"']
        : ["app-server", "--stdio"];
      return spawn(executable, args, {
        env: { ...process.env, CODEX_HOME: this.config.codexHome,
          ...(isWindowsScript ? { CODEX_QUOTA_GUARD_LAUNCH_COMMAND: resolved } : {}) },
        // cmd.exe uses its own quoting grammar, not the C runtime argv grammar.
        windowsVerbatimArguments: isWindowsScript,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GuardError("CODEX_NOT_FOUND", `Unable to start Codex app-server: ${message}`);
    }
  }
}

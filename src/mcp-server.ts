import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { QuotaGuardService } from "./service.js";
import { toGuardError } from "./errors.js";
import type { CheckpointPayload } from "./types.js";

const workspaceRoot = z.string().min(1).max(4_096).describe("Absolute workspace root path.");
const taskId = z.string().min(1).max(256).optional().describe("Codex task/thread identifier when available.");
const checkpointFields = {
  workspaceRoot,
  taskId,
  objective: z.string().min(1).max(4_000),
  completed: z.array(z.string().max(2_000)).max(200),
  pending: z.array(z.string().max(2_000)).max(200),
  gitStatus: z.string().max(8_000).optional(),
  lastTest: z.string().max(4_000).optional(),
  pendingCommand: z.string().max(2_000).optional(),
  resumeNotes: z.string().max(4_000).optional(),
};

function payloadFrom(input: z.infer<z.ZodObject<typeof checkpointFields>>): CheckpointPayload {
  return {
    workspaceRoot: input.workspaceRoot,
    objective: input.objective,
    completed: input.completed,
    pending: input.pending,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.gitStatus ? { gitStatus: input.gitStatus } : {}),
    ...(input.lastTest ? { lastTest: input.lastTest } : {}),
    ...(input.pendingCommand ? { pendingCommand: input.pendingCommand } : {}),
    ...(input.resumeNotes ? { resumeNotes: input.resumeNotes } : {}),
  };
}

function result(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const guardError = toGuardError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code: guardError.code, message: guardError.message } }, null, 2) }],
  };
}

export function createMcpServer(service: QuotaGuardService): McpServer {
  const server = new McpServer({ name: "codex-quota-guard-mcp", version: "0.1.0" });

  server.registerTool("quota_status", {
    description: "Read the shared adaptive Codex quota snapshot. The server enforces cache TTL, lease, and backoff; callers cannot force refresh.",
    inputSchema: {},
  }, async () => {
    try { return result(await service.quotaStatus()); } catch (error) { return failure(error); }
  });

  server.registerTool("job_preflight", {
    description: "Call before a costly boundary such as a long build, test, deploy, migration, training, or packaging job. Obey defer decisions.",
    inputSchema: {
      workspaceRoot,
      jobClass: z.enum(["small", "medium", "long"]),
      estimatedMinutes: z.number().min(0).max(10_080).optional(),
      description: z.string().min(1).max(2_000),
    },
  }, async ({ jobClass }) => {
    try { return result(await service.jobPreflight(jobClass)); } catch (error) { return failure(error); }
  });

  server.registerTool("checkpoint_create", {
    description: "Persist a redacted, resumable checkpoint in shared local state. Do not include credentials, full prompts, or full responses.",
    inputSchema: checkpointFields,
  }, async (input) => {
    try { return result(service.createCheckpoint(payloadFrom(input))); } catch (error) { return failure(error); }
  });

  server.registerTool("checkpoint_get", {
    description: "Read a specific checkpoint or the latest checkpoint for a workspace/task.",
    inputSchema: {
      workspaceRoot,
      taskId,
      checkpointId: z.string().uuid().optional(),
    },
  }, async ({ workspaceRoot: root, taskId: currentTaskId, checkpointId }) => {
    try {
      const checkpoint = service.getCheckpoint(root, currentTaskId, checkpointId);
      return result({ checkpoint, found: checkpoint !== null });
    } catch (error) { return failure(error); }
  });

  server.registerTool("defer_until_reset", {
    description: "Create a checkpoint and prepare a same-task Codex heartbeat automation prompt for the five-hour reset. The caller must create the automation.",
    inputSchema: checkpointFields,
  }, async (input) => {
    try { return result(await service.deferUntilReset(payloadFrom(input))); } catch (error) { return failure(error); }
  });

  return server;
}

export async function runStdioServer(service: QuotaGuardService): Promise<McpServer> {
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
  return server;
}

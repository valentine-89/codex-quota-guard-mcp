import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import type { QuotaGuardService } from "./service.js";
import { toGuardError } from "./errors.js";
import type { CheckpointPayload } from "./types.js";

const workspaceRoot = z.string().min(1).max(4_096).refine(isAbsolute, "workspaceRoot must be absolute on this host")
  .describe("Absolute workspace root path.");
const taskId = z.string().min(1).max(256).describe("Codex task/thread identifier.");
const laneId = z.enum(["primary", "secondary", "unknown"]).optional()
  .describe("Quota role, not a model name. Use secondary only when quota_status reports it.");
const checkpointFields = {
  workspaceRoot,
  taskId: taskId.optional(),
  objective: z.string().min(1).max(4_000),
  completed: z.array(z.string().max(2_000)).max(200),
  pending: z.array(z.string().max(2_000)).max(200),
  gitStatus: z.string().max(8_000).optional(),
  lastTest: z.string().max(4_000).optional(),
  pendingCommand: z.string().max(2_000).optional(),
  resumeNotes: z.string().max(4_000).optional(),
  laneId,
  jobClass: z.enum(["small", "medium", "long"]).optional(),
};

function payloadFrom(input: z.infer<z.ZodObject<typeof checkpointFields>>): CheckpointPayload {
  return {
    workspaceRoot: input.workspaceRoot, objective: input.objective, completed: input.completed, pending: input.pending,
    ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.gitStatus ? { gitStatus: input.gitStatus } : {}),
    ...(input.lastTest ? { lastTest: input.lastTest } : {}), ...(input.pendingCommand ? { pendingCommand: input.pendingCommand } : {}),
    ...(input.resumeNotes ? { resumeNotes: input.resumeNotes } : {}),
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(input.jobClass ? { jobClass: input.jobClass } : {}),
  };
}

function result(value: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}
function failure(error: unknown) {
  const guardError = toGuardError(error);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: {
    code: guardError.code, message: guardError.message,
  } }, null, 2) }] };
}

export function createMcpServer(service: QuotaGuardService): McpServer {
  const server = new McpServer({ name: "codex-quota-guard-mcp", version: "0.4.0" });

  server.registerTool("quota_status", {
    description: "Read the shared adaptive Codex quota, detected plan profile, learned part-job cost, and runtime allowance capability. Callers cannot force refresh.",
    inputSchema: {},
  }, async () => { try { return result({ ...await service.quotaStatus(), monitor: service.monitorStatus() }); } catch (error) { return failure(error); } });

  server.registerTool("job_preflight", {
    description: "Call exactly once with a stable jobId before a costly boundary. Any non-defer result records one passive part-job admission. Use primary for the main task; use secondary only when quota_status reports an explicit secondary lane.",
    inputSchema: {
      jobId: z.string().min(1).max(256).describe("Stable idempotency identifier for this part-job."),
      taskId, workspaceRoot, jobClass: z.enum(["small", "medium", "long"]),
      estimatedMinutes: z.number().min(0).max(10_080).optional(), description: z.string().min(1).max(2_000), laneId,
      sessionRole: z.enum(["main", "lightweight"]).optional().describe("Convenience alias: lightweight selects secondary; main selects primary."),
    },
  }, async (input) => {
    try {
      return result(await service.jobPreflight({
        jobId: input.jobId, taskId: input.taskId, workspaceRoot: input.workspaceRoot,
        jobClass: input.jobClass, description: input.description,
        ...(input.laneId ? { laneId: input.laneId } : {}), ...(input.sessionRole ? { sessionRole: input.sessionRole } : {}),
        ...(input.estimatedMinutes === undefined ? {} : { estimatedMinutes: input.estimatedMinutes }),
      }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("quota_profile", {
    description: "Inspect, adjust, or reset the persistent learned admission threshold for the current account and plan. A positive delta limits earlier; a negative delta limits later.",
    inputSchema: {
      action: z.enum(["get", "adjust", "reset"]),
      deltaPercent: z.number().min(-49).max(49).optional().describe("Required and non-zero for adjust; omitted otherwise."),
    },
  }, async ({ action, deltaPercent }) => {
    try {
      if (action === "adjust" && (!deltaPercent || deltaPercent === 0)) throw new Error("deltaPercent must be non-zero for adjust");
      if (action !== "adjust" && deltaPercent !== undefined) throw new Error("deltaPercent is only valid for adjust");
      return result(await service.quotaProfile(action, deltaPercent));
    } catch (error) { return failure(error); }
  });

  server.registerTool("checkpoint_create", {
    description: "Persist a bounded, redacted resumable checkpoint. Do not include credentials, full prompts, or full responses.",
    inputSchema: checkpointFields,
  }, async (input) => { try { return result(service.createCheckpoint(payloadFrom(input))); } catch (error) { return failure(error); } });

  server.registerTool("checkpoint_get", {
    description: "Read a specific checkpoint or the latest checkpoint for a workspace/task.",
    inputSchema: { workspaceRoot, taskId: taskId.optional(), checkpointId: z.string().uuid().optional() },
  }, async ({ workspaceRoot: root, taskId: currentTaskId, checkpointId }) => {
    try { const checkpoint = service.getCheckpoint(root, currentTaskId, checkpointId); return result({ checkpoint, found: checkpoint !== null }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("defer_until_reset", {
    description: "Always checkpoint a blocked task and create a quota-guard-owned defer record. Schedule the returned heartbeat only when canSchedule is true, then attach its automation ID.",
    inputSchema: { ...checkpointFields, taskId },
  }, async (input) => { try { return result(await service.deferUntilReset(payloadFrom(input))); } catch (error) { return failure(error); } });

  server.registerTool("defer_automation_attach", {
    description: "Attach the Codex heartbeat automation ID created for one active quota-guard defer. Never attach unrelated automations.",
    inputSchema: { deferId: z.string().uuid(), automationId: z.string().min(1).max(256) },
  }, async ({ deferId, automationId }) => { try { return result(service.attachAutomation(deferId, automationId)); } catch (error) { return failure(error); } });

  server.registerTool("resume_prepare", {
    description: "Call before manually resuming a deferred task or as the first heartbeat action. Manual resume supersedes matching quota-guard defers before quota revalidation and returns only owned automation IDs for best-effort deletion.",
    inputSchema: { workspaceRoot, taskId, deferId: z.string().uuid().optional(), trigger: z.enum(["manual", "automation"]), laneId },
  }, async (input) => {
    try {
      return result(await service.resumePrepare({ workspaceRoot: input.workspaceRoot, taskId: input.taskId,
        trigger: input.trigger, ...(input.deferId === undefined ? {} : { deferId: input.deferId }), ...(input.laneId ? { laneId: input.laneId } : {}) }));
    } catch (error) { return failure(error); }
  });

  return server;
}

export async function runStdioServer(service: QuotaGuardService): Promise<McpServer> {
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
  return server;
}

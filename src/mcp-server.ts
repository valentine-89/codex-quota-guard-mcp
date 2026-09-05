import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { QuotaGuardService } from "./service.js";
import { GuardError, toGuardError } from "./errors.js";
import { isHostWorkspaceRoot } from "./host-path.js";
import type { CheckpointPayload } from "./types.js";
import { compactQuota, summaryPreflight, summaryQuota } from "./quota-output.js";

export const SERVER_INSTRUCTIONS = [
  "Use this server for substantial or long-running work, not for every command or small read.",
  "Use workspace paths in the Guard host format; Windows-hosted WSL callers must use the wslpath -w result.",
  "For a schedulable defer, pass automationRequest unchanged to the host automation_update tool; do not inspect automations, browse scheduling docs, or rewrite its fixed prompt, then attach only the returned automation ID.",
  "Call quota_status near the start, then call job_preflight with a stable jobId before each bounded substantial segment. A timely job_preflight also counts as a quota check; avoid redundant paired calls.",
  "During active work, recheck quota by checkAgainBy at the next tool boundary; do not wait for a major checkpoint. Never begin an unsplittable model operation beyond the deadline. A running model generation cannot be interrupted by this MCP; never interrupt an atomic or unsafe operation solely to check quota.",
  "Keep main work on the primary lane; use secondary only when quota_status explicitly reports it available.",
  "Honor canStartSegment, validUntil and maxSegmentMinutes even on allow/caution. If canStartSegment=false, split and preflight a shorter segment or wait until checkAgainBy; do not execute the oversized segment. Save a checkpoint when checkpointRequired=true. Treat allow and caution as time-limited admission, not a reservation. On caution, checkpoint before more substantial work unless quotaPath is weekly_advisory, and disclose mayConsumeCredits when true.",
  "On defer, immediately call defer_until_reset with bounded state. Never schedule when canSchedule is false.",
  "Before manual or automated resume, call resume_prepare first; stop when shouldExit is true or canResume is false.",
  "Do not idle-poll or force quota refresh, or store credentials, complete prompts, or complete model responses in checkpoints.",
  "Pass agentProtocol=auto-reset-v1 to quota_status and job_preflight. When quota_status returns a resetCredit recommendation, its enabled local policy is standing user authorization: call the host consume_usage_reset tool immediately with the exact idempotencyKey and without asking again; never buy a reset or credits. Retry an uncertain host response only with the same key, then report the exact outcome through quota_status.resetFollowup. Never invent a recommendation or key.",
].join(" ");

const agentProtocol = z.string().optional().describe("Required breaking contract marker: auto-reset-v1.");
const detail = z.enum(["summary", "compact", "full"]).default("summary")
  .describe("Summary returns action fields (~1KB normally); full returns diagnostics. Compact keeps the v2 status layout. Does not change freshness.");
function requireAgentProtocol(value: string | undefined): asserts value is "auto-reset-v1" {
  if (value !== "auto-reset-v1") throw new GuardError("AUTO_RESET_AGENT_REQUIRED",
    "This Quota Guard release requires agentProtocol=auto-reset-v1 and an agent that supports the banked-reset workflow.");
}
const resetFollowup = z.object({
  recommendationId: z.string().uuid(), idempotencyKey: z.string().uuid(),
  outcome: z.enum(["reset", "alreadyRedeemed", "noCredit", "nothingToReset", "uncertain"]),
}).strict();

const workspaceRoot = z.string().min(1).max(4_096)
  .refine(value => isHostWorkspaceRoot(value), "workspaceRoot must use an absolute path in the Guard host format")
  .describe("Absolute workspace root in the Guard host format. Windows-hosted WSL callers must pass the wslpath -w result.");
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
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}
function failure(error: unknown) {
  const guardError = toGuardError(error);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: {
    code: guardError.code, message: guardError.message,
  } }, null, 2) }] };
}

export function createMcpServer(service: QuotaGuardService): McpServer {
  const server = new McpServer(
    { name: "codex-quota-guard-mcp", version: "2.0.2" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool("quota_status", {
    description: "Requires agentProtocol=auto-reset-v1. Read current shared Codex quota near the start of long work and by checkAgainBy at tool boundaries while active. If resetCredit.recommendation is present, call host consume_usage_reset with its exact idempotencyKey without asking again, then report the outcome in resetFollowup. The proof-bound follow-up may recheck after 3/5/10 seconds; there is no generic force refresh.",
    inputSchema: z.object({ agentProtocol, resetFollowup: resetFollowup.optional(),
      detail,
    }).strict(),
  }, async (input) => { try {
    requireAgentProtocol(input.agentProtocol);
    const snapshot = await service.quotaStatusForRequest(input.resetFollowup);
    const monitor = service.monitorStatus() as Record<string, unknown>;
    return result({ ...(input.detail === "full" ? snapshot : input.detail === "compact" ? compactQuota(snapshot) : summaryQuota(snapshot)),
      monitor: input.detail === "summary" ? { available: monitor.available,
        ...(monitor.lastError ? { lastError: monitor.lastError } : {}),
        ...(monitor.pendingRecords ? { pendingRecords: monitor.pendingRecords } : {}),
      } : monitor });
  } catch (error) { return failure(error); } });

  server.registerTool("job_preflight", {
    description: "Requires agentProtocol=auto-reset-v1. Call once with a stable jobId before each substantial token-consuming work segment, not before individual commands or small reads. Honor canStartSegment=false by splitting and preflighting again; admission expires at validUntil. Save progress when checkpointRequired. Use primary for main work; secondary only when quota_status reports it.",
    inputSchema: z.object({
      agentProtocol, detail,
      jobId: z.string().min(1).max(256).describe("Stable idempotency identifier for this part-job."),
      taskId, workspaceRoot, jobClass: z.enum(["small", "medium", "long"]),
      estimatedMinutes: z.number().min(0).max(10_080).optional().describe("Active Codex work duration for this segment, excluding detached GPU/process waiting time."), description: z.string().min(1).max(2_000), laneId,
      sessionRole: z.enum(["main", "lightweight"]).optional().describe("Convenience alias: lightweight selects secondary; main selects primary."),
    }),
  }, async (input) => {
    try {
      requireAgentProtocol(input.agentProtocol);
      const preflight = await service.jobPreflight({
        agentProtocol: input.agentProtocol,
        jobId: input.jobId, taskId: input.taskId, workspaceRoot: input.workspaceRoot,
        jobClass: input.jobClass, description: input.description,
        ...(input.laneId ? { laneId: input.laneId } : {}), ...(input.sessionRole ? { sessionRole: input.sessionRole } : {}),
        ...(input.estimatedMinutes === undefined ? {} : { estimatedMinutes: input.estimatedMinutes }),
      });
      return result(input.detail === "full" ? preflight : input.detail === "compact"
        ? { ...preflight, quota: compactQuota(preflight.quota) } : summaryPreflight(preflight));
    } catch (error) { return failure(error); }
  });

  server.registerTool("quota_profile", {
    description: "Inspect, adjust, or reset the persistent learned admission threshold for the current account and plan. A positive delta limits earlier; a negative delta limits later.",
    inputSchema: z.object({
      action: z.enum(["get", "adjust", "reset"]),
      deltaPercent: z.number().min(-49).max(49).optional().describe("Required and non-zero for adjust; omitted otherwise."),
    }),
  }, async ({ action, deltaPercent }) => {
    try {
      if (action === "adjust" && (!deltaPercent || deltaPercent === 0)) throw new Error("deltaPercent must be non-zero for adjust");
      if (action !== "adjust" && deltaPercent !== undefined) throw new Error("deltaPercent is only valid for adjust");
      return result(await service.quotaProfile(action, deltaPercent));
    } catch (error) { return failure(error); }
  });

  server.registerTool("checkpoint_create", {
    description: "Persist a bounded, redacted resumable checkpoint. Do not include credentials, full prompts, or full responses.",
    inputSchema: z.object(checkpointFields),
  }, async (input) => { try { return result(service.createCheckpoint(payloadFrom(input))); } catch (error) { return failure(error); } });

  server.registerTool("checkpoint_get", {
    description: "Read a specific checkpoint or the latest checkpoint for a workspace/task.",
    inputSchema: z.object({ workspaceRoot, taskId: taskId.optional(), checkpointId: z.string().uuid().optional() }),
  }, async ({ workspaceRoot: root, taskId: currentTaskId, checkpointId }) => {
    try { const checkpoint = service.getCheckpoint(root, currentTaskId, checkpointId); return result({ checkpoint, found: checkpoint !== null }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("defer_until_reset", {
    description: "Checkpoint a blocked task and create an owned defer. When canSchedule is true, immediately pass automationRequest unchanged to host automation_update without inspecting automations, reading scheduler docs, or rewriting prompt; then attach its returned ID.",
    inputSchema: z.object({ ...checkpointFields, taskId }),
  }, async (input) => { try { return result(await service.deferUntilReset(payloadFrom(input))); } catch (error) { return failure(error); } });

  server.registerTool("defer_automation_attach", {
    description: "Attach only the automation ID returned by the immediately preceding automation_update create call for this defer. Do not list or inspect automations; never attach an unrelated ID.",
    inputSchema: z.object({ deferId: z.string().uuid(), automationId: z.string().min(1).max(256) }),
  }, async ({ deferId, automationId }) => { try { return result(service.attachAutomation(deferId, automationId)); } catch (error) { return failure(error); } });

  server.registerTool("resume_prepare", {
    description: "Call before manually resuming a deferred task or as the first heartbeat action. Manual resume supersedes matching quota-guard defers before quota revalidation and returns only owned automation IDs for best-effort deletion.",
    inputSchema: z.object({ workspaceRoot, taskId, deferId: z.string().uuid().optional(), trigger: z.enum(["manual", "automation"]), laneId }),
  }, async (input) => {
    try {
      return result(await service.resumePrepare({ workspaceRoot: input.workspaceRoot, taskId: input.taskId,
        trigger: input.trigger, ...(input.deferId === undefined ? {} : { deferId: input.deferId }), ...(input.laneId ? { laneId: input.laneId } : {}) }));
    } catch (error) { return failure(error); }
  });

  return server;
}

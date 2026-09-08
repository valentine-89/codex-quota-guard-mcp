import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { QuotaGuardService } from "./service.js";
import { GuardError, toGuardError } from "./errors.js";
import { isHostWorkspaceRoot } from "./host-path.js";
import type { CheckpointPayload } from "./types.js";
import { compactQuota, summaryPreflight, summaryQuota, summaryResume } from "./quota-output.js";

export const SERVER_INSTRUCTIONS = [
  "Use agentProtocol=auto-reset-v1. Preflight substantial work once per admission; batch small steps, avoid paired status/preflight calls and idle polling. Use actual taskId, stable jobId and absolute Guard-host paths (wslpath -w for Windows-hosted WSL).",
  "Obey canStartSegment, validUntil, checkAgainBy, checkpointRequired and requiredAction. Recheck at tool boundaries when due. Admitted jobs in every quota mode may span checks; maxSegmentMinutes bounds unchecked work, not total job duration. Atomic operations must fit admission; never interrupt unsafe work solely to check.",
  "Use primary unless secondary is explicitly available. Disclose mayConsumeCredits. On defer call defer_until_reset immediately; before resuming call resume_prepare and obey action (continue/wait/exit). Follow each tool's scheduling/reset instructions. Never bypass unavailable quota, force refresh, read auth files, buy resets or create polling heartbeats.",
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
    { name: "codex-quota-guard-mcp", version: "2.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool("quota_status", {
    description: "Read shared quota when due or for status-only work; preflight already checks it. Requires agentProtocol=auto-reset-v1. A resetCredit.recommendation is policy-authorized: call host consume_usage_reset with its exact idempotencyKey without asking again, then report the exact outcome via resetFollowup. Retry uncertain outcomes only with the same key; never invent a recommendation.",
    inputSchema: z.object({ agentProtocol, resetFollowup: resetFollowup.optional(),
      detail,
    }).strict(),
  }, async (input) => { try {
    requireAgentProtocol(input.agentProtocol);
    const snapshot = await service.quotaStatusForRequest(input.resetFollowup);
    const monitor = service.monitorStatus() as Record<string, unknown>;
    return result({ ...(input.detail === "full" ? snapshot : input.detail === "compact" ? compactQuota(snapshot) : summaryQuota(snapshot)),
      monitor: input.detail === "summary" ? { available: monitor.available, unavailableReason: monitor.unavailableReason,
        ...(monitor.scheduling ? { scheduling: monitor.scheduling } : {}),
        ...(monitor.lastError ? { lastError: monitor.lastError } : {}),
        ...(monitor.pendingRecords ? { pendingRecords: monitor.pendingRecords } : {}),
      } : monitor });
  } catch (error) { return failure(error); } });

  server.registerTool("job_preflight", {
    description: "Admit substantial work with agentProtocol=auto-reset-v1 and a stable jobId. Reuse valid admission for small steps. Follow action fields; job estimates can exceed routine check intervals; only near-reserve forecasts require shorter segments. On resetCredit.recommendation, follow quota_status reset instructions before more work.",
    inputSchema: z.object({
      agentProtocol, detail,
      jobId: z.string().min(1).max(256).describe("Stable idempotency identifier for this part-job."),
      taskId, workspaceRoot, jobClass: z.enum(["small", "medium", "long"]),
      estimatedMinutes: z.number().min(0).max(10_080).optional().describe("Estimated active Codex work, excluding external-process waits. Jobs may span periodic checks; this is not an atomic unchecked-operation duration."), description: z.string().min(1).max(2_000), laneId,
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
    description: "Checkpoint a blocked task and create an owned defer. IPC scheduling.state=scheduled confirms an internal wake: no Desktop automation. Otherwise pass a non-null automationRequest unchanged to host automation_update and attach its returned ID. Never schedule if canSchedule=false, invent or switch mechanisms. Claim early wake only when earlyRecovery.ready; if false, follow its diagnostic (scheduler-bridge-doctor), then recheck readiness.",
    inputSchema: z.object({ ...checkpointFields, taskId }),
  }, async (input) => { try { return result(await service.deferUntilReset(payloadFrom(input))); } catch (error) { return failure(error); } });

  server.registerTool("defer_automation_attach", {
    description: "Attach only the automation ID returned by the immediately preceding automation_update create call for this defer. Do not list or inspect automations; never attach an unrelated ID.",
    inputSchema: z.object({ deferId: z.string().uuid(), automationId: z.string().min(1).max(256) }),
  }, async ({ deferId, automationId }) => { try { return result(service.attachAutomation(deferId, automationId)); } catch (error) { return failure(error); } });

  server.registerTool("resume_prepare", {
    description: "Call before resumed work. Ordinary schedules: trigger=automation without deferId checks quota without changing Guard wakes. Guard recovery schedules must pass their exact deferId; never omit it to bypass an invalid/early/replayed wake. Manual resume supersedes matching Guard defers. Only action=continue permits job_preflight; wait means quota-blocked, exit means invalid/consumed wake. Cancellation IDs are best-effort.",
    inputSchema: z.object({ workspaceRoot, taskId, deferId: z.string().uuid().optional(), trigger: z.enum(["manual", "automation"]), laneId }),
  }, async (input) => {
    try {
      return result(summaryResume(await service.resumePrepare({ workspaceRoot: input.workspaceRoot, taskId: input.taskId,
        trigger: input.trigger, ...(input.deferId === undefined ? {} : { deferId: input.deferId }), ...(input.laneId ? { laneId: input.laneId } : {}) })));
    } catch (error) { return failure(error); }
  });

  return server;
}

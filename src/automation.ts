export const RESUME_AUTOMATION_PROMPT = "Continue the work.";

export interface ResumeAutomationRequest {
  mode: "create";
  kind: "heartbeat";
  name: string;
  prompt: typeof RESUME_AUTOMATION_PROMPT;
  rrule: string;
  status: "ACTIVE";
  destination: "thread";
  targetThreadId: string;
}

export function resumeAutomationName(deferId: string): string {
  return `Quota Guard resume ${deferId}`;
}

/** Codex heartbeat RRULEs use the host's local wall clock; round up so the wake never precedes resumeAt. */
export function oneShotRrule(resumeAtMs: number): string {
  const scheduled = new Date(Math.ceil(resumeAtMs / 60_000) * 60_000);
  return `RRULE:FREQ=DAILY;COUNT=1;BYHOUR=${scheduled.getHours()};BYMINUTE=${scheduled.getMinutes()}`;
}

export function resumeAutomationRequest(deferId: string, taskId: string, resumeAtMs: number): ResumeAutomationRequest {
  return {
    mode: "create",
    kind: "heartbeat",
    name: resumeAutomationName(deferId),
    prompt: RESUME_AUTOMATION_PROMPT,
    rrule: oneShotRrule(resumeAtMs),
    status: "ACTIVE",
    destination: "thread",
    targetThreadId: taskId,
  };
}

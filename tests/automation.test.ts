import assert from "node:assert/strict";
import test from "node:test";
import { oneShotRrule, RESUME_AUTOMATION_PROMPT, resumeAutomationRequest } from "../src/automation.js";

test("resume automation is fixed, same-task and rounded after the safe resume time", () => {
  const resumeAt = new Date(2026, 8, 3, 10, 37, 12, 345).getTime();
  const request = resumeAutomationRequest("defer-id", "task-id", resumeAt);
  assert.equal(request.prompt, RESUME_AUTOMATION_PROMPT);
  assert.equal(request.prompt, "Tiếp tục công việc.");
  assert.equal(request.name, "Quota Guard resume defer-id");
  assert.equal(request.targetThreadId, "task-id");
  assert.equal(request.destination, "thread");
  assert.equal(request.rrule, "RRULE:FREQ=DAILY;COUNT=1;BYHOUR=10;BYMINUTE=38");
  assert.equal(oneShotRrule(new Date(2026, 8, 3, 23, 59, 59, 999).getTime()),
    "RRULE:FREQ=DAILY;COUNT=1;BYHOUR=0;BYMINUTE=0");
});

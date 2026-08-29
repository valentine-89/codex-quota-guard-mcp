## Codex quota guard

- Call `quota_status` near the beginning of long-running work. Shared caching makes this inexpensive across concurrent tasks.
- Call `job_preflight` immediately before a long build, test, deploy, migration, training, packaging, or other hard-to-interrupt job.
- Obey a `defer` decision. Call `defer_until_reset`, then create a same-task Codex heartbeat automation using the returned `resumeAt` and `automationPrompt`.
- On wake, call `quota_status` first and `checkpoint_get` second. Do not continue if quota is still exhausted or unavailable.
- Never place credentials, complete prompts, or complete model responses in checkpoint fields.

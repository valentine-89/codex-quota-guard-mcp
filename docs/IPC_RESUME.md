# Windows extension quota resume

Version 2.3.0 adds quota-only scheduling through the existing Codex IPC owner. The protocol was inspected and probed with extension 26.901.22334. It is an internal interface, not a supported OpenAI scheduler API.

## Ownership and lifetime

A connector registers a live lease and forwards its inherited CODEX_THREAD_ID. Desktop capability continues to select the existing Desktop heartbeat contract. Without Desktop capability, a Windows task can bind IPC after owner discovery and a snapshot verify its task ID, profile rollout directory, and workspace. No arbitrary endpoint, prompt, or external task ID is exposed by an MCP tool.

The existing core holds an unreferenced timer. Waiting schedules never keep it alive. Close the app and its connectors stop; the core exits under its existing lease/grace rules. SQLite preserves waiting schedules. Reopen the same task and use a Guard capability to rebind; no OS scheduler or independent helper restarts the core.

## Dispatch

A schedulable quota defer stores an IPC wake atomically and supersedes older IPC defers for the same workspace/task/lane. Existing Desktop defers are never adopted. Normal due wakes and optional five-minute early checks use the shared adaptive cache, single-flight refresh and backoff. Unknown identity, insufficient quota, busy task, mismatched workspace/profile, or missing owner prevents dispatch.

The sender re-discovers the owner and reads an idle snapshot before sending only to that owner. A fixed app-context item uses the owner's busy-turn check during turn preparation. SQLite records an attempt as uncertain before external I/O. Success requires the matching response and a new turn ID. A timeout/disconnect/crash after claim never causes automatic replay. This chooses possible missed delivery over duplicated work.

The fixed prompt instructs resume_prepare with the saved defer ID, task, workspace, lane and automation trigger. That final gate revalidates current quota. Manual resume supersedes the selected lane's defer and makes its wake cancelled. Other lanes and tasks remain untouched.

## Boundaries

IPC does not add a generic automation tool or banked-reset consumption API. Desktop reset tools, thresholds and admission remain unchanged. Non-Windows clients retain their Desktop/manual behavior. Discovery-only clients cannot keep the core alive. No auth files, direct OAuth, global keyboard controls, VS Code extension modifications, or thread lock bypasses are used.

Schema 6 retains existing state and adds ipc_wakes. Older Guard builds cannot open schema 6; do not downgrade the installed runtime after the new core has migrated it. Stop and reconnect normally for version changes; do not terminate user work.

## Release verification

On 2026-09-06, `npm run check` passed 156 tests and the isolated Windows installation acceptance passed. A live same-task extension test waited for idle, dispatched once through this adapter, received the matching turn acknowledgement, and displayed the new input in the task. The temporary test was bound to the existing VS Code app-server lifetime and did not modify quota or defer state. Regression coverage includes Windows extended-length paths returned by live snapshots.

Separate Desktop acceptance on 26.901.6511.0 verified capability/task context, created an owned heartbeat, captured its definition, advanced its schedule, and cancelled it with removal confirmed. This verifies the scheduler bridge; natural quota recovery remains covered by regression tests, not a fabricated live quota event. Verify the newly installed registered runtime after reconnect before declaring deployment complete.

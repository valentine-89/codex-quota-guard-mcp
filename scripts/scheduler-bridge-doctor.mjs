// Read-only capability probe. Never calls a tool, starts a turn, or edits an automation.
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({ options: { server: { type: "string" } } });
const report = (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!values.server || !isAbsolute(values.server)) {
  report({ ok: false, reason: "Provide --server with the absolute installed codex-app-tools server.mjs path." });
  process.exitCode = 2;
} else if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  report({ ok: false, reason: "Desktop app-tools capability is absent from this process environment." });
  process.exitCode = 2;
} else {
  const client = new Client({ name: "quota-guard-scheduler-bridge-doctor", version: "1.1.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  // Use the shipped server; do not reimplement its pipe protocol or peer authorization.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [values.server],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const deadline = setTimeout(() => { void client.close(); }, 15_000);
  try {
    await client.connect(transport, { timeout: 10_000 });
    const { tools } = await client.listTools({}, { timeout: 10_000 });
    const scheduler = tools.find((tool) => tool.name === "automation_update");
    const ok = client.getServerVersion()?.name === "codex-app-tools" && scheduler !== undefined;
    report({ ok, server: client.getServerVersion(), toolCount: tools.length,
      schedulerAdvertised: scheduler !== undefined,
      schedulerInputSchema: scheduler?.inputSchema,
      mutationVerified: false,
      monitorEnabled: false,
    });
    process.exitCode = ok ? 0 : 2;
  } catch {
    // Do not log pipe paths or arbitrary host errors into shareable diagnostics.
    report({ ok: false, reason: "Desktop MCP discovery or tool inventory failed; no scheduler operation attempted." });
    process.exitCode = 2;
  } finally {
    clearTimeout(deadline);
    await client.close();
  }
}

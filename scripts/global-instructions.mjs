import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const start = '<!-- codex-quota-guard:begin -->';
const end = '<!-- codex-quota-guard:end -->';
const block = `${start}
## Quota Guard (managed by its installer)

For every new task in every project, discover the codex_quota_guard MCP tools and call quota_status with agentProtocol="auto-reset-v1" near the start. Before each substantial implementation, research, review or build segment, call job_preflight with the actual task ID, absolute workspaceRoot and a stable jobId. Follow the Guard server instructions and returned schema; honor canStartSegment, validUntil, checkAgainBy and checkpointRequired. Briefly report the initial Guard decision, and later only meaningful quota changes or blockers.
If Guard is unavailable, report the error and stop substantial work instead of silently bypassing it or substituting get_usage_limits. Do not read authentication files or force refresh.
On defer, save progress with defer_until_reset and follow its returned scheduling mechanism. For Desktop, create the returned automationRequest unchanged and attach its ID; require earlyRecovery.ready before claiming early wake. On manual or scheduled resume, call resume_prepare first and obey shouldExit/canResume. Never create an extra polling heartbeat. Follow reset-credit instructions only when Guard returns a policy-authorized recommendation; never buy credits or resets.
${end}
`;

function read(path) {
  if (!existsSync(path)) return '';
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('Unsafe global instructions path');
  return readFileSync(path, 'utf8');
}

export function updateGlobalInstructions(home, install = true) {
  const paths = ['AGENTS.md', 'AGENTS.override.md'].map(name => join(home, name));
  const originals = paths.map(read);
  const target = originals[1].trim() ? 1 : 0;
  const changes = paths.map((path, index) => {
    const original = originals[index];
    const first = original.indexOf(start), last = original.indexOf(end);
    if ((first < 0) !== (last < 0) || (first >= 0 && (last < first || original.indexOf(start, first + 1) >= 0 || original.indexOf(end, last + 1) >= 0))) {
      throw Error('Malformed Quota Guard instructions markers; repair before setup/removal');
    }
    const clean = first < 0 ? original : original.slice(0, first) + original.slice(last + end.length).replace(/^\r?\n/, '');
    // Prepend to avoid truncating Guard guidance behind a large personal file.
    const updated = install && index === target ? block + clean : clean;
    return { path, original, updated };
  });
  for (const { path, original, updated } of changes) {
    if (original === updated) continue;
    const temporary = `${path}.quota-guard-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, updated, { flag: 'wx', mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600 });
      if (read(path) !== original) throw Error('Global instructions changed during setup/removal');
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) rmSync(temporary); }
  }
  return { path: paths[target], installed: install };
}

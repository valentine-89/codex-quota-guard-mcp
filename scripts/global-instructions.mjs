import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const start = '<!-- codex-quota-guard:begin -->';
const end = '<!-- codex-quota-guard:end -->';
const block = `${start}
## Quota Guard

At task start, discover codex_quota_guard. Use job_preflight before substantial work (actual taskId, absolute workspaceRoot, stable jobId, agentProtocol="auto-reset-v1"); quota_status only for status-only work. On deferred resume, call resume_prepare first. Follow returned decisions/actions and recheck deadlines; batch small steps, reuse valid admission, never idle-poll. Report only the initial decision and meaningful changes/blockers. If Guard is unavailable, stop substantial work; never bypass it, read auth files, force refresh, buy resets or create extra polling heartbeats.
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

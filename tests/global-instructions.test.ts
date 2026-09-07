import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Installer modules are JavaScript, outside the runtime build.
import { updateGlobalInstructions } from '../scripts/global-instructions.mjs';

test('global guidance install/update/remove preserves personal text and follows override precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'guard-instructions-'));
  const path = join(home, 'AGENTS.md');
  const override = join(home, 'AGENTS.override.md');
  const personal = 'User guidance\r\nKeep my files.\r\n';
  try {
    writeFileSync(path, personal);
    updateGlobalInstructions(home);
    const installed = readFileSync(path, 'utf8');
    assert.ok(installed.length - personal.length < 850, 'personalization must remain a compact bootstrap');
    assert.ok(installed.includes('resume_prepare'));
    assert.ok(installed.includes('stop substantial work'));
    assert.ok(installed.includes('job_preflight'));
    assert.ok(installed.endsWith(personal));
    writeFileSync(path, '<!-- codex-quota-guard:begin -->\n' + 'Old detailed guidance. '.repeat(100) + '\n<!-- codex-quota-guard:end -->\n' + personal);
    updateGlobalInstructions(home);
    assert.equal(readFileSync(path, 'utf8'), installed);
    writeFileSync(override, 'Override user text');
    updateGlobalInstructions(home);
    assert.equal(readFileSync(path, 'utf8'), personal);
    assert.ok(readFileSync(override, 'utf8').includes('quota_status'));
    updateGlobalInstructions(home, false);
    updateGlobalInstructions(home, false);
    assert.equal(readFileSync(override, 'utf8'), 'Override user text');
    assert.equal(readFileSync(path, 'utf8'), personal);
    writeFileSync(path, '<!-- codex-quota-guard:begin -->broken');
    assert.throws(() => updateGlobalInstructions(home), /Malformed/);
    assert.equal(readFileSync(override, 'utf8'), 'Override user text');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

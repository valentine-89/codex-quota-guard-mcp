import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const parts = value => {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return value.split('.').map(BigInt);
};
const current = parts(version);
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.version, version);
assert.equal(lock.packages[''].version, version);
assert.ok(read('README.md').startsWith(`# Codex Quota Guard MCP ${version}\n`)
  || read('README.md').startsWith(`# Codex Quota Guard MCP ${version}\r\n`));
assert.ok(read('docs/MCP_API.md').startsWith(`# MCP API ${version}`));
assert.ok(read('CHANGELOG.md').includes(`## [${version}] - `));
const base = process.env.VERSION_BASE_REVISION;
if (base && !/^0+$/.test(base)) {
  assert.match(base, /^[a-f0-9]{40}$/i);
  const previous = parts(JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { encoding: 'utf8' })).version);
  const changed = current.findIndex((part, i) => part !== previous[i]);
  assert.ok(changed >= 0 && current[changed] > previous[changed], 'Increase package version before pushing an update');
}
console.log(`Version ${version}: metadata/docs${base ? ' and advancement' : ''} verified`);

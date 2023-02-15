import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessReadiness, LIMITS, parseStrictJson } from '../src/index.mjs';

const d = (state = 'pass', observedAt = '2026-09-26T00:00:00Z') => ({ schemaVersion: '1', complete: true, asOf: '2026-09-26T00:00:00Z', maxAgeHours: 24, prerequisites: [{ id: 'storage', state, observedAt, dependsOn: [] }, { id: 'database', state: 'pass', observedAt, dependsOn: ['storage'] }], paths: [{ id: 'recovery', requires: ['database'] }] });
const run = (root, input) => spawnSync(process.execPath, ['bin/failover-readiness-probe.mjs', '--root', root, '--input', input], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--import=/Users/km/Desktop/web/open-source/migration-plan-template/support/deny-network.mjs' } });

test('complete fresh prerequisite chain is ready without performing failover', () => {
  const r = assessReadiness(d()); assert.equal(r.status, 'pass'); assert.equal(r.summary.checked, 1); assert.deepEqual(r.findings, []);
});
test('failed transitive prerequisite blocks readiness with ordinal provenance', () => {
  const r = assessReadiness(d('fail')); assert.equal(r.status, 'fail'); assert.equal(r.findings[0].ruleId, 'path-blocked'); assert.equal(r.findings[0].location.pointer, '/paths/0');
});
test('evidence exactly 24 hours old is current, one millisecond older is unknown', () => {
  const x = d('pass', '2026-09-25T00:00:00Z'); assert.equal(assessReadiness(x).status, 'pass');
  x.prerequisites[0].observedAt = '2026-09-24T23:59:59.999Z';
  assert.equal(assessReadiness(x).status, 'incomplete'); assert.equal(assessReadiness(x).findings[0].ruleId, 'evidence-stale');
});
test('unknown, incomplete, missing dependency and cycle never pass', () => {
  assert.equal(assessReadiness(d('unknown')).status, 'incomplete');
  assert.equal(assessReadiness({ ...d(), complete: false }).status, 'incomplete');
  const missing = d(); missing.paths[0].requires = ['missing']; assert.equal(assessReadiness(missing).status, 'incomplete');
  const cycle = d(); cycle.prerequisites[0].dependsOn = ['database']; assert.equal(assessReadiness(cycle).status, 'incomplete');
  const overflow = d(); overflow.maxAgeHours = Number.MAX_SAFE_INTEGER; assert.equal(assessReadiness(overflow).status, 'incomplete');
});
test('prerequisite, path and dependency bounds allow N and reject N+1', () => {
  const x = d(); x.prerequisites = Array.from({ length: LIMITS.prerequisites }, (_, i) => ({ id: `p${i}`, state: 'pass', observedAt: x.asOf, dependsOn: [] })); x.paths = [{ id: 'r', requires: ['p0'] }];
  assert.equal(assessReadiness(x).status, 'pass'); x.prerequisites.push({ id: 'extra', state: 'pass', observedAt: x.asOf, dependsOn: [] }); assert.equal(assessReadiness(x).findings[0].ruleId, 'record-limit');
  x.prerequisites.pop(); x.paths = Array.from({ length: LIMITS.paths }, (_, i) => ({ id: `r${i}`, requires: ['p0'] })); assert.equal(assessReadiness(x).status, 'pass'); x.paths.push({ id: 'extra', requires: ['p0'] }); assert.equal(assessReadiness(x).findings[0].ruleId, 'record-limit');
  x.paths.pop(); x.paths = [{ id: 'r', requires: Array.from({ length: LIMITS.dependencies }, (_, i) => `p${i % LIMITS.prerequisites}`) }];
  assert.equal(assessReadiness(x).status, 'pass'); x.paths[0].requires.push('p0'); assert.equal(assessReadiness(x).findings[0].ruleId, 'record-limit');
});
test('byte, JSON depth and injected time bounds allow N and reject N+1', () => {
  const x = d(); x.prerequisites[0].note = ''; const overhead = Buffer.byteLength(JSON.stringify(x)); x.prerequisites[0].note = 'x'.repeat(LIMITS.bytes - overhead);
  assert.equal(assessReadiness(x).status, 'pass'); x.prerequisites[0].note += 'x'; assert.equal(assessReadiness(x).findings[0].ruleId, 'byte-limit');
  const deep = d(); assert.equal(assessReadiness(deep).status, 'pass'); deep.prerequisites[0].state = { nested: { deep: 'pass' } }; assert.equal(assessReadiness(deep).findings[0].ruleId, 'depth-limit');
  assert.equal(assessReadiness(d(), { now: (() => { let n=0; return () => n++ ? LIMITS.milliseconds : 0; })() }).status, 'pass');
  assert.equal(assessReadiness(d(), { now: (() => { let n=0; return () => n++ ? LIMITS.milliseconds + 1 : 0; })() }).findings[0].ruleId, 'time-limit');
});
test('duplicate JSON keys including escaped spellings are refused', () => assert.throws(() => parseStrictJson('{"complete":false,"complet\\u0065":true}'), /duplicate-key/));
test('CLI confines reads, requires strict UTF-8, and keeps usage stdout empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'failover-')); await writeFile(join(root, 'good.json'), JSON.stringify(d())); assert.equal(run(root, 'good.json').status, 0);
  await writeFile(join(root, 'bad.json'), Buffer.from([0xff])); assert.equal(JSON.parse(run(root, 'bad.json').stdout).status, 'incomplete');
  await symlink(tmpdir(), join(root, 'escape')); const escaped = run(root, 'escape/nonexistent.json'); assert.equal(escaped.status, 2); assert.equal(JSON.parse(escaped.stdout).status, 'incomplete');
  const usage = spawnSync(process.execPath, ['bin/failover-readiness-probe.mjs', '--root', root, '--input', 'good.json', '--unknown'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }); assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
});

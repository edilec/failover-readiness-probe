export const TOOL_ID = 'failover-readiness-probe';
export const LIMITS = Object.freeze({ bytes: 1_048_576, prerequisites: 100, paths: 20, dependencies: 500, depth: 4, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'input-invalid': 'error', 'duplicate-key': 'error', 'byte-limit': 'error', 'depth-limit': 'error', 'record-limit': 'error', 'time-limit': 'error', 'export-incomplete': 'error',
  'prerequisite-invalid': 'error', 'path-invalid': 'error', 'id-duplicate': 'error', 'no-paths': 'error', 'dependency-unknown': 'error', 'dependency-cycle': 'error',
  'evidence-stale': 'error', 'evidence-future': 'error', 'evidence-unknown': 'error', 'path-blocked': 'error'
});
const UNKNOWN = new Set(['input-unreadable', 'input-invalid', 'duplicate-key', 'byte-limit', 'depth-limit', 'record-limit', 'time-limit', 'export-incomplete', 'prerequisite-invalid', 'path-invalid', 'id-duplicate', 'no-paths', 'dependency-unknown', 'dependency-cycle', 'evidence-stale', 'evidence-future', 'evidence-unknown']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(v);
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
function finding(ruleId, pointer = '') {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  return { ruleId, severity: RULE_SEVERITY[ruleId], message: {
    'path-blocked': 'At least one required prerequisite failed; recovery readiness is blocked.',
    'evidence-stale': 'Required recovery evidence is older than the declared freshness limit.',
    'evidence-future': 'Required recovery evidence is dated after the declared as-of time.',
    'evidence-unknown': 'A required prerequisite has no conclusive pass/fail evidence.',
    'dependency-unknown': 'A required dependency is absent from the complete export.',
    'dependency-cycle': 'The required dependency graph contains a cycle.'
  }[ruleId] ?? 'Recovery readiness evidence cannot be evaluated safely.', location: { file: '@export', pointer } };
}
function report(findings, checked = 0) {
  findings.sort((a, b) => order(a.location.file, b.location.file) || order(a.location.pointer, b.location.pointer) || order(a.ruleId, b.ruleId));
  const errors = findings.filter(f => f.severity === 'error').length;
  return { schemaVersion: '1', tool: TOOL_ID, status: findings.some(f => UNKNOWN.has(f.ruleId)) ? 'incomplete' : errors ? 'fail' : 'pass', summary: { checked, errors, warnings: 0 }, findings };
}
export const incomplete = ruleId => report([finding(ruleId)]);
export function parseStrictJson(raw) {
  const value = JSON.parse(raw); let i = 0;
  const space = () => { while (/\s/u.test(raw[i] ?? '')) i++; };
  const token = () => { const start = i++; while (i < raw.length) { if (raw[i] === '\\') { i += 2; continue; } if (raw[i++] === '"') return JSON.parse(raw.slice(start, i)); } throw new Error('input-invalid'); };
  const walk = depth => { if (depth > LIMITS.depth) throw new Error('depth-limit'); space(); if (raw[i] === '{') { i++; space(); const keys = new Set(); while (raw[i] !== '}') { const key = token(); if (keys.has(key)) throw new Error('duplicate-key'); keys.add(key); space(); i++; walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '[') { i++; space(); while (raw[i] !== ']') { walk(depth + 1); space(); if (raw[i] !== ',') break; i++; space(); } i++; return; } if (raw[i] === '"') { token(); return; } while (i < raw.length && !/[\s,}\]]/u.test(raw[i])) i++; };
  walk(0); return value;
}
function tooDeep(v, depth = 0) { return depth > LIMITS.depth || (v !== null && typeof v === 'object' && Object.values(v).some(child => tooDeep(child, depth + 1))); }
export function assessReadiness(document, { now = Date.now } = {}) {
  const start = now(), expired = () => now() - start > LIMITS.milliseconds;
  if (!object(document)) return incomplete('input-invalid');
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(document)); } catch { return incomplete('input-invalid'); }
  if (bytes > LIMITS.bytes) return incomplete('byte-limit');
  if (tooDeep(document)) return incomplete('depth-limit');
  if (expired()) return incomplete('time-limit');
  if (document.schemaVersion !== '1' || !date(document.asOf) || !Number.isSafeInteger(document.maxAgeHours) || document.maxAgeHours < 0 || !Number.isSafeInteger(document.maxAgeHours * 3600000) || !Array.isArray(document.prerequisites) || !Array.isArray(document.paths) || Object.keys(document).some(k => !['schemaVersion', 'complete', 'asOf', 'maxAgeHours', 'prerequisites', 'paths'].includes(k))) return incomplete('input-invalid');
  if (document.complete !== true) return incomplete('export-incomplete');
  const dependencies = [...document.prerequisites, ...document.paths].reduce((n, x) => n + (Array.isArray(x?.dependsOn) ? x.dependsOn.length : 0) + (Array.isArray(x?.requires) ? x.requires.length : 0), 0);
  if (document.prerequisites.length > LIMITS.prerequisites || document.paths.length > LIMITS.paths || dependencies > LIMITS.dependencies) return incomplete('record-limit');
  if (!document.prerequisites.length || !document.paths.length) return incomplete('no-paths');
  const nodes = new Map(), pathIds = new Set();
  for (const [i, node] of document.prerequisites.entries()) {
    if (expired()) return incomplete('time-limit');
    if (!object(node) || !id(node.id) || !['pass', 'fail', 'unknown'].includes(node.state) || !date(node.observedAt) || !Array.isArray(node.dependsOn) || node.dependsOn.some(x => !id(x)) || (node.note !== undefined && typeof node.note !== 'string') || Object.keys(node).some(k => !['id', 'state', 'observedAt', 'dependsOn', 'note'].includes(k))) return report([finding('prerequisite-invalid', `/prerequisites/${i}`)]);
    if (nodes.has(node.id)) return report([finding('id-duplicate', `/prerequisites/${i}/id`)]);
    nodes.set(node.id, { node, ordinal: i });
  }
  for (const [i, path] of document.paths.entries()) {
    if (!object(path) || !id(path.id) || !Array.isArray(path.requires) || !path.requires.length || path.requires.some(x => !id(x)) || Object.keys(path).some(k => !['id', 'requires'].includes(k))) return report([finding('path-invalid', `/paths/${i}`)]);
    if (pathIds.has(path.id)) return report([finding('id-duplicate', `/paths/${i}/id`)]);
    pathIds.add(path.id);
  }
  const asOf = Date.parse(document.asOf), maxAge = document.maxAgeHours * 3600000;
  const findings = [], emitted = new Set();
  const emitOnce = (rule, pointer) => { const key = `${rule}:${pointer}`; if (!emitted.has(key)) { emitted.add(key); findings.push(finding(rule, pointer)); } };
  const evaluate = (name, visiting, pathOrdinal) => {
    if (!nodes.has(name)) { emitOnce('dependency-unknown', `/paths/${pathOrdinal}`); return 'unknown'; }
    const { node, ordinal } = nodes.get(name);
    if (visiting.has(name)) { emitOnce('dependency-cycle', `/prerequisites/${ordinal}/dependsOn`); return 'unknown'; }
    const observed = Date.parse(node.observedAt);
    if (observed > asOf) { emitOnce('evidence-future', `/prerequisites/${ordinal}/observedAt`); return 'unknown'; }
    if (asOf - observed > maxAge) { emitOnce('evidence-stale', `/prerequisites/${ordinal}/observedAt`); return 'unknown'; }
    if (node.state === 'unknown') { emitOnce('evidence-unknown', `/prerequisites/${ordinal}/state`); return 'unknown'; }
    const next = new Set(visiting); next.add(name);
    let result = node.state;
    for (const dep of node.dependsOn) { const depResult = evaluate(dep, next, pathOrdinal); if (depResult === 'unknown') result = 'unknown'; else if (depResult === 'fail' && result !== 'unknown') result = 'fail'; }
    return result;
  };
  for (const [i, path] of document.paths.entries()) {
    if (expired()) return incomplete('time-limit');
    const states = path.requires.map(name => evaluate(name, new Set(), i));
    if (states.includes('fail')) emitOnce('path-blocked', `/paths/${i}`);
  }
  if (expired()) return incomplete('time-limit');
  return report(findings, document.paths.length);
}

// Measured facts.
//
// A source of truth that someone typed by hand goes stale the day after it
// is written: the README says 3,541 tests while the suite has 4,664, and the
// gate happily verifies the stale number. Under-claiming is invisible to any
// rule. The fix is to stop typing the truth and start measuring it.
//
// Any value in a facts file may be a measurement instead of a literal:
//
//   { "counts": {
//       "tests":  { "cmd": "node --test 2>&1", "pattern": "# pass (\\d+)" },
//       "cases":  { "json": "evals/cases.json", "path": "cases.length" },
//       "tools":  { "file": "README.md", "pattern": "(\\d+) tools" }
//   } }
//
// `resolveFacts` runs each one and returns plain facts plus a record of what
// was measured, so a report can say "tests = 39 (measured via node --test)"
// and nobody has to trust a number they cannot re-derive. A measurement that
// fails is an error, never a silent skip: a gate that quietly loses part of
// its truth is worse than no gate.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const MEASURED_KEYS = ['cmd', 'file', 'json'];

/** Is this value a measurement spec rather than a literal? */
export function isMeasurement(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && MEASURED_KEYS.some(k => k in v);
}

function pickPattern(text, spec, what) {
  if (!spec.pattern) return text.trim();
  let re;
  try { re = new RegExp(spec.pattern, spec.flags || ''); }
  catch (e) { throw new Error(`${what}: invalid pattern ${JSON.stringify(spec.pattern)}: ${e.message}`); }
  const m = re.exec(text);
  if (!m) throw new Error(`${what}: pattern ${JSON.stringify(spec.pattern)} matched nothing`);
  const group = spec.group ?? (m.length > 1 ? 1 : 0);
  if (m[group] == null) throw new Error(`${what}: pattern has no group ${group}`);
  return m[group].trim();
}

function jsonPath(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (seg === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue; }
    if (seg === 'keys' && typeof cur === 'object') { cur = Object.keys(cur); continue; }
    cur = cur[seg];
  }
  return cur;
}

/**
 * Resolve one measurement spec to a string value.
 * @param {object} spec  {cmd|file|json, pattern?, group?, path?}
 * @param {object} ctx   {cwd, timeout, env, exec}
 */
export class CommandNotAllowed extends Error {
  constructor(cmd) { super(`command measurement not allowed here: ${JSON.stringify(cmd)}`); this.cmd = cmd; }
}

export function measure(spec, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const what = spec.cmd ? `cmd ${JSON.stringify(spec.cmd)}` : spec.file ? `file ${JSON.stringify(spec.file)}` : `json ${JSON.stringify(spec.json)}`;
  if (spec.cmd) {
    if (ctx.allowCmd === false) throw new CommandNotAllowed(spec.cmd);
    const exec = ctx.exec || ((cmd) => execSync(cmd, { cwd, encoding: 'utf8', timeout: ctx.timeout ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(ctx.env || {}) }, windowsHide: true }));
    let out;
    try { out = exec(spec.cmd); }
    catch (e) {
      // A non-zero exit with output is still a measurement ("# pass 39" comes
      // after a failing test too); only an empty result is a failure.
      out = (e.stdout || '') + (e.stderr || '');
      if (!String(out).trim()) throw new Error(`${what}: exited ${e.status ?? '?'} with no output: ${e.message}`);
    }
    return { value: pickPattern(String(out), spec, what), via: what };
  }
  if (spec.file) {
    const text = readFileSync(resolvePath(cwd, spec.file), 'utf8');
    return { value: pickPattern(text, spec, what), via: what };
  }
  if (spec.json) {
    const obj = JSON.parse(readFileSync(resolvePath(cwd, spec.json), 'utf8'));
    const v = jsonPath(obj, spec.path ?? '');
    if (v === undefined) throw new Error(`${what}: path ${JSON.stringify(spec.path)} not found`);
    return { value: Array.isArray(v) ? v.map(String) : String(v), via: `${what} path ${JSON.stringify(spec.path)}` };
  }
  throw new Error('measurement needs one of cmd, file, json');
}

/**
 * Replace every measurement spec in a facts object with its measured value.
 *
 * @param {object} facts
 * @param {object} [ctx]  {cwd, timeout, env, exec, allowCmd}
 *   allowCmd=false: `cmd` specs are not run; they are dropped from the facts and
 *   listed in `skipped` so the caller can say why (the Claude Code hook does this
 *   for untrusted configs).
 * @returns {{facts: object, measurements: Array<{key: string, value: string|string[], via: string}>, skipped: Array<{key: string, cmd: string}>}}
 */
export function resolveFacts(facts, ctx = {}) {
  if (!facts || typeof facts !== 'object') return { facts, measurements: [], skipped: [] };
  const measurements = [];
  const skipped = [];
  const out = {};
  const SKIP = Symbol('skip');
  const one = (key, v) => {
    if (!isMeasurement(v)) return v;
    let m;
    try { m = measure(v, ctx); }
    catch (e) { if (e instanceof CommandNotAllowed) { skipped.push({ key, cmd: e.cmd }); return SKIP; } throw e; }
    measurements.push({ key, value: m.value, via: m.via });
    return m.value;
  };
  for (const [k, v] of Object.entries(facts)) {
    if (k === 'counts' && v && typeof v === 'object') {
      out.counts = {};
      for (const [ck, cv] of Object.entries(v)) { const r = one(`counts.${ck}`, cv); if (r !== SKIP) out.counts[ck] = r; }
    } else if (Array.isArray(v)) {
      out[k] = v.flatMap((item, i) => { const r = one(`${k}[${i}]`, item); return r === SKIP ? [] : Array.isArray(r) ? r : [r]; });
    } else {
      const r = one(k, v); if (r !== SKIP) out[k] = r;
    }
  }
  return { facts: out, measurements, skipped };
}

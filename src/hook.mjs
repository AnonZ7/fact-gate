// Claude Code hook.
//
// PreToolUse on Write / Edit / MultiEdit: before the agent saves a document,
// verify what it is about to write against the repository's facts. On a
// contradiction the write is denied and the reasons go back to the agent as
// the denial message, which is exactly the "CORRECT THESE" loop the library
// runs in code, now enforced on every file the agent touches.
//
// Configuration is a `.fact-gate.json` found by walking up from the file
// being written (or FACT_GATE_CONFIG):
//
//   {
//     "facts":   "facts.json",            // path (may contain measurements) or inline object
//     "source":  "docs/truth.md",         // optional prose source
//     "config":  { "allow_metrics": [] }, // optional gate config
//     "nouns":   ["sku"],                 // optional domain nouns
//     "ignoreCode": true,                 // code blocks are examples, not claims (default)
//     "include": [".md", ".mdx", ".txt", ".rst", ".adoc"],
//     "exclude": ["CHANGELOG.md", "node_modules/"]
//   }
//
// Contract: this hook must never break a session. Every failure path exits 0
// with no output (set FACT_GATE_DEBUG=1 to see why on stderr). No config
// found means the hook is inert for that file.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath, join, basename, extname, isAbsolute } from 'node:path';
import { verifyFacts, formatReport } from './index.mjs';
import { resolveFacts } from './facts.mjs';
import { isTrusted } from './trust.mjs';

export const CONFIG_NAME = '.fact-gate.json';
const DEFAULT_INCLUDE = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function debug(msg) { if (process.env.FACT_GATE_DEBUG) process.stderr.write(`fact-gate hook: ${msg}\n`); }

/** Walk up from `dir` looking for the config file. */
export function findConfig(dir, name = CONFIG_NAME) {
  let cur = resolvePath(dir);
  for (;;) {
    const candidate = join(cur, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Compute the file content the tool call would produce. */
export function projectedContent(toolName, input, readExisting) {
  if (toolName === 'Write') return String(input.content ?? '');
  const current = (() => { try { return readExisting(); } catch { return null; } })();
  if (toolName === 'Edit') {
    const oldS = String(input.old_string ?? ''), newS = String(input.new_string ?? '');
    if (current == null) return newS;
    if (!oldS) return current + newS;
    if (!current.includes(oldS)) return null; // the edit cannot apply; there is nothing to project
    return input.replace_all ? current.split(oldS).join(newS) : current.replace(oldS, () => newS);
  }
  if (toolName === 'MultiEdit') {
    let text = current ?? '';
    for (const e of input.edits || []) {
      const oldS = String(e.old_string ?? ''), newS = String(e.new_string ?? '');
      if (!oldS) { text += newS; continue; }
      text = e.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    }
    return text;
  }
  if (toolName === 'NotebookEdit') return String(input.new_source ?? '');
  return null;
}

/** Does this JSON look like a project config rather than a bare facts object? */
export function isProjectConfig(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return 'facts' in obj || 'include' in obj || 'exclude' in obj || 'source' in obj || 'ignoreCode' in obj;
}

/**
 * Load a `.fact-gate.json` (or any project config) into verifyFacts options.
 * Paths inside it resolve relative to the config file. Measurements are
 * resolved here, so callers get plain facts plus the audit trail.
 */
export function readConfig(cfgPath) {
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
}

/**
 * Turn a loaded config into verifyFacts options. Measurements run here.
 * @param {object} [opts] {allowCmd} — false skips `cmd` measurements (untrusted hook mode)
 */
export function loadConfig(cfgPath, { allowCmd = true } = {}) {
  const cfgDir = dirname(cfgPath);
  const cfg = readConfig(cfgPath);
  const options = { config: cfg.config || {}, nouns: cfg.nouns || [], synonyms: cfg.synonyms || {}, ignoreCode: cfg.ignoreCode !== false };
  let measurements = [], skipped = [];
  if (cfg.source) options.source = readFileSync(resolvePath(cfgDir, cfg.source), 'utf8');
  if (cfg.jd) options.jd = readFileSync(resolvePath(cfgDir, cfg.jd), 'utf8');
  if (cfg.facts) {
    const raw = typeof cfg.facts === 'string' ? JSON.parse(readFileSync(resolvePath(cfgDir, cfg.facts), 'utf8')) : cfg.facts;
    const r = resolveFacts(raw, { cwd: cfgDir, allowCmd });
    options.facts = r.facts; measurements = r.measurements; skipped = r.skipped;
  }
  return { cfg, options, measurements, skipped, dir: cfgDir };
}

function matches(filePath, cfg) {
  const inc = Array.isArray(cfg.include) && cfg.include.length ? cfg.include : DEFAULT_INCLUDE;
  const exc = Array.isArray(cfg.exclude) ? cfg.exclude : [];
  const norm = filePath.replace(/\\/g, '/');
  const base = basename(norm);
  const ext = extname(norm).toLowerCase();
  const hit = (pat) => {
    const p = String(pat).replace(/\\/g, '/');
    if (p.startsWith('.') && !p.includes('/')) return ext === p.toLowerCase();
    if (p.endsWith('/')) return norm.includes('/' + p) || norm.startsWith(p);
    return base === p || norm.endsWith('/' + p) || norm === p;
  };
  if (exc.some(hit)) return false;
  return inc.some(hit);
}

/**
 * Run the hook on a parsed hook payload.
 * @returns {{decision: 'allow'|'deny'|'skip', output: object|null, result?: object, reason?: string}}
 */
export function runHook(payload, { cwd = process.cwd(), configPath = process.env.FACT_GATE_CONFIG } = {}) {
  const toolName = payload?.tool_name;
  const input = payload?.tool_input || {};
  if (!WRITE_TOOLS.has(toolName)) return { decision: 'skip', output: null, reason: `tool ${toolName} is not a write` };
  const rawPath = input.file_path || input.notebook_path;
  if (!rawPath) return { decision: 'skip', output: null, reason: 'no file_path' };
  const filePath = isAbsolute(rawPath) ? rawPath : resolvePath(payload?.cwd || cwd, rawPath);

  const cfgPath = configPath ? resolvePath(cwd, configPath) : findConfig(dirname(filePath));
  if (!cfgPath) return { decision: 'skip', output: null, reason: `no ${CONFIG_NAME} above ${filePath}` };
  // Filter FIRST. Nothing in the config — least of all a command — runs for
  // a file the config does not cover.
  const cfgRaw = readConfig(cfgPath);
  if (!matches(filePath, cfgRaw)) return { decision: 'skip', output: null, reason: `${filePath} not included by ${cfgPath}` };

  const text = projectedContent(toolName, input, () => readFileSync(filePath, 'utf8'));
  if (text == null) return { decision: 'skip', output: null, reason: 'nothing to check' };

  // A cloned repository's config may not run commands on this machine until
  // `fact-gate trust` has been run for it (or FACT_GATE_ALLOW_CMD=1).
  const trusted = isTrusted(cfgPath);
  const { cfg, options: loaded, skipped } = loadConfig(cfgPath, { allowCmd: trusted });
  const options = { ...loaded, label: basename(filePath) };
  const hasTruth = (options.source && options.source.trim()) || (options.facts && Object.keys(options.facts).length);
  if (!hasTruth) {
    const why = skipped.length ? `its only facts are ${skipped.length} command measurement(s) and ${basename(cfgPath)} is not trusted — run \`fact-gate trust ${cfgPath}\` once to enable them` : 'it has no facts or source';
    return { decision: 'allow', output: { systemMessage: `fact-gate: ${basename(filePath)} was not checked — ${why}.` }, reason: why };
  }
  const result = verifyFacts(text, options);
  const skipNote = skipped.length ? `\n  (${skipped.length} command measurement(s) skipped: ${basename(cfgPath)} is not trusted — run \`fact-gate trust ${cfgPath}\`)` : '';
  if (result.verdict === 'block') {
    const reason = `fact-gate blocked this write to ${basename(filePath)} — it contradicts ${cfg.facts ? 'the measured facts' : 'the source of truth'} in ${basename(cfgPath)}:\n  ${formatReport(result)}${skipNote}\nCorrect the figures above (do not remove the check; the facts file is the truth).`;
    return {
      decision: 'deny', result,
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } },
    };
  }
  if (result.verdict === 'warn' && cfg.warnUnsupported !== false && result.unsupported.length) {
    return {
      decision: 'allow', result,
      output: { systemMessage: `fact-gate: ${result.unsupported.length} claim(s) in ${basename(filePath)} are not backed by the facts file (allowed, not verified):\n  ${formatReport(result)}${skipNote}` },
    };
  }
  if (skipped.length) return { decision: 'allow', result, output: { systemMessage: `fact-gate: ${basename(filePath)} checked against literal facts only.${skipNote}` } };
  return { decision: 'allow', result, output: null };
}

/** Read stdin, run, print, always exit 0. */
export async function hookMain(stdin = process.stdin) {
  let raw = '';
  try {
    raw = await new Promise((res) => { let s = ''; stdin.setEncoding('utf8'); stdin.on('data', d => s += d); stdin.on('end', () => res(s)); stdin.on('error', () => res(s)); });
    const payload = JSON.parse(raw || '{}');
    const r = runHook(payload);
    if (r.decision === 'skip') debug(r.reason);
    if (r.output) process.stdout.write(JSON.stringify(r.output) + '\n');
  } catch (e) {
    debug(`inert: ${e.message}`);
  }
  return 0;
}

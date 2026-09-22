// Git pre-commit mode.
//
// `fact-gate pre-commit` checks the STAGED content of every file the nearest
// `.fact-gate.json` covers, against that config. Staged content, not the
// working tree: `git show :path` is what will actually be committed. Exit 1
// on any block so the commit is refused; the report tells the author what to
// fix. Editor-agnostic: it works for Cursor, Codex, Copilot and humans alike.
//
// Wiring (any one of):
//   husky:     echo "npx fact-gate pre-commit" > .husky/pre-commit
//   lefthook:  see README
//   pre-commit framework: see .pre-commit-hooks.yaml in this repo

import { execFileSync } from 'node:child_process';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { verifyFacts, formatReport } from './core.mjs';
import { findConfig, loadConfig, readConfig, matchesConfig } from './hook.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Paths staged for commit (added, copied, modified, renamed), relative to the repo root. */
export function stagedPaths(cwd = process.cwd()) {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd);
  return out.split('\0').filter(Boolean);
}

/** The staged content of a path (what `git commit` will write). */
export function stagedContent(path, cwd = process.cwd()) {
  // The index holds whatever core.autocrlf produced at `git add` time.
  return git(['show', `:${path}`], cwd).replace(/\r\n/g, '\n');
}

/**
 * Check every staged file the config covers.
 * @param {object} [opts] {cwd, files (override the staged list), allowCmd}
 * @returns {{results: Array<{path: string, result: object}>, skipped: string[], verdict: 'pass'|'warn'|'block'}}
 */
export function checkStaged({ cwd = process.cwd(), files, allowCmd = true } = {}) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const paths = files ?? stagedPaths(root);
  const results = [];
  const skipped = [];
  const configs = new Map();
  for (const rel of paths) {
    const abs = resolvePath(root, rel);
    const cfgPath = findConfig(dirname(abs));
    if (!cfgPath) { skipped.push(rel); continue; }
    if (!configs.has(cfgPath)) configs.set(cfgPath, { raw: readConfig(cfgPath), loaded: null });
    const entry = configs.get(cfgPath);
    if (!matchesConfig(abs, entry.raw)) { skipped.push(rel); continue; }
    if (!entry.loaded) entry.loaded = loadConfig(cfgPath, { allowCmd });
    const text = stagedContent(rel, root);
    results.push({ path: rel, result: verifyFacts(text, { ...entry.loaded.options, label: rel }) });
  }
  const verdict = results.some(r => r.result.verdict === 'block') ? 'block'
    : results.some(r => r.result.verdict === 'warn') ? 'warn' : 'pass';
  return { results, skipped, verdict };
}

/** CLI entry: print a report per checked file; exit 1 on block. */
export function precommitMain({ strict = false, quiet = false, paint = (_, s) => s } = {}) {
  let out;
  try { out = checkStaged(); }
  catch (e) { console.error(`fact-gate pre-commit: ${e.message.split('\n')[0]}`); return 2; }
  if (!out.results.length) { if (!quiet) console.log('fact-gate: no staged files covered by a .fact-gate.json'); return 0; }
  for (const { path, result } of out.results) {
    if (quiet && result.verdict === 'pass') continue;
    const n = result.counts;
    const tag = { pass: paint(32, 'PASS '), warn: paint(33, 'WARN '), block: paint(31, 'BLOCK') }[result.verdict];
    console.log(`${tag}  ${basename(path) === path ? path : path} — ${n.total} claims: ${n.verified} verified, ${n.unsupported} unsupported, ${n.fabricated} fabricated`);
    if (result.verdict !== 'pass') console.log('  ' + formatReport(result));
  }
  if (out.verdict === 'block') { console.error('fact-gate: commit refused — the staged text contradicts the facts. Fix the figures (or the facts) and commit again.'); return 1; }
  if (out.verdict === 'warn' && strict) return 1;
  return 0;
}

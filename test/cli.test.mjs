import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, formatMarkdown } from '../src/cli.mjs';
import { verifyFacts } from '../src/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NO_COLOR: '1', ...(opts.env || {}) }, input: opts.input });

test('parseArgs handles flags, --k=v, and bool negation', () => {
  const a = parseArgs(['check', '--target', 'x.md', '--format=json', '--strict', '--no-measure', 'extra']);
  assert.deepEqual(a._, ['check', 'extra']);
  assert.equal(a.target, 'x.md');
  assert.equal(a.format, 'json');
  assert.equal(a.strict, true);
  assert.equal(a['no-measure'], true);
});

test('exit codes: 0 pass, 1 block, 2 usage', () => {
  assert.equal(run(['--target', 'examples/pr-body.md', '--diff', 'examples/pr.diff']).status, 0);
  assert.equal(run(['--target', 'examples/pr-body-inflated.md', '--diff', 'examples/pr.diff']).status, 1);
  assert.equal(run(['--target', 'examples/pr-body.md']).status, 2, 'no source of truth');
  assert.equal(run(['--target', 'nope.md', '--diff', 'examples/pr.diff']).status, 2);
  assert.equal(run(['bogus']).status, 2);
});

test('--strict turns a warn into exit 1', () => {
  assert.equal(run(['--target', 'examples/pr-body.md', '--diff', 'examples/pr.diff', '--strict']).status, 1);
});

test('stdin target and --target-env', () => {
  assert.equal(run(['--diff', 'examples/pr.diff'], { input: 'Adds 4 tests.' }).status, 0);
  assert.equal(run(['--diff', 'examples/pr.diff', '--target-env', 'PR_BODY'], { env: { PR_BODY: 'Adds 40 tests.' } }).status, 1);
  assert.equal(run(['--diff', 'examples/pr.diff', '--target-env', 'MISSING_VAR_X']).status, 2);
});

test('--format json includes measurements; --format markdown renders a table', () => {
  const j = run(['--target', 'examples/pr-body-inflated.md', '--diff', 'examples/pr.diff', '--format', 'json']);
  const r = JSON.parse(j.stdout);
  assert.equal(r.verdict, 'block');
  assert.ok(Array.isArray(r.measurements));
  const m = run(['--target', 'examples/pr-body-inflated.md', '--diff', 'examples/pr.diff', '--format', 'markdown']);
  assert.match(m.stdout, /### ⛔ fact-gate: BLOCK/);
  assert.match(m.stdout, /\| ⛔ fabricated \| count \| 40 tests \|/);
});

test('--format github emits annotations, a step summary and outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-gh-'));
  const summary = join(dir, 'summary.md'), output = join(dir, 'output.txt');
  writeFileSync(summary, ''); writeFileSync(output, '');
  const p = run(['--target', 'examples/pr-body-inflated.md', '--diff', 'examples/pr.diff', '--format', 'github'], { env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output } });
  assert.equal(p.status, 1);
  assert.match(p.stdout, /::error title=fact-gate fabricated count::"40 tests"/);
  assert.match(readFileSync(summary, 'utf8'), /fact-gate: BLOCK/);
  assert.match(readFileSync(output, 'utf8'), /^verdict=block$/m);
  assert.match(readFileSync(output, 'utf8'), /^fabricated=4$/m);
});

test('measure resolves specs and prints plain facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-measure-'));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ counts: { cases: { json: join(root, 'evals/cases.json').replace(/\\/g, '/'), path: 'suites.length' } } }));
  const p = run(['measure', '--facts', join(dir, 'facts.json'), '--format', 'json']);
  assert.equal(p.status, 0, p.stderr);
  const facts = JSON.parse(p.stdout);
  assert.match(String(facts.counts.cases), /^\d+$/);
});

test('--no-measure refuses unresolved specs rather than comparing against an object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-nm-'));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ counts: { tests: { cmd: 'echo 1' } } }));
  const p = run(['--facts', join(dir, 'facts.json'), '--no-measure'], { input: 'Ships 1 tests.' });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /unresolved measurement/);
});

test('init writes a config and prints the hook snippet without overwriting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-init-'));
  const p = run(['init', dir]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /PreToolUse/);
  const cfg = JSON.parse(readFileSync(join(dir, '.fact-gate.json'), 'utf8'));
  assert.ok(cfg.facts.counts.tests.cmd);
  const again = run(['init', dir]);
  assert.match(again.stdout, /already exists/);
});

test('formatMarkdown escapes pipes and lists measurements', () => {
  const r = verifyFacts('Ships 2 tests.', { facts: { counts: { tests: 1 } }, label: 'a|b' });
  const md = formatMarkdown(r, { measurements: [{ key: 'counts.tests', value: '1', via: 'json x' }] });
  assert.match(md, /measured facts/);
  assert.match(md, /`counts.tests` = \*\*1\*\*/);
});

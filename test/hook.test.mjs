import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook, findConfig, projectedContent } from '../src/hook.mjs';

const root = mkdtempSync(join(tmpdir(), 'fact-gate-hook-'));
const docs = join(root, 'docs');
mkdirSync(docs);
writeFileSync(join(root, '.fact-gate.json'), JSON.stringify({
  facts: { counts: { tests: 846, 'n8n workflows': 85 }, tools: ['n8n'] },
  include: ['.md'],
  exclude: ['CHANGELOG.md'],
}));
writeFileSync(join(docs, 'README.md'), '# app\n\nShips 846 tests.\n');

const cli = new URL('../src/cli.mjs', import.meta.url);

test('findConfig walks up from the file directory', () => {
  assert.equal(findConfig(docs), join(root, '.fact-gate.json'));
  assert.equal(findConfig(tmpdir()), null);
});

test('projectedContent applies Write, Edit (first/all) and MultiEdit', () => {
  assert.equal(projectedContent('Write', { content: 'x' }, () => 'old'), 'x');
  assert.equal(projectedContent('Edit', { old_string: 'a', new_string: 'b' }, () => 'a a'), 'b a');
  assert.equal(projectedContent('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, () => 'a a'), 'b b');
  assert.equal(projectedContent('MultiEdit', { edits: [{ old_string: '1', new_string: '2' }, { old_string: '2', new_string: '3' }] }, () => '1'), '3');
  assert.equal(projectedContent('Edit', { old_string: 'a', new_string: 'b' }, () => { throw new Error('missing'); }), 'b');
});

test('a Write that contradicts the facts is denied with the reasons', () => {
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(docs, 'README.md'), content: '# app\n\nShips 1,200 tests.\n' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /846 tests, not 1200/);
});

test('an Edit is judged on the projected file, not the fragment', () => {
  const r = runHook({ tool_name: 'Edit', tool_input: { file_path: join(docs, 'README.md'), old_string: '846', new_string: '900' } });
  assert.equal(r.decision, 'deny');
  const ok = runHook({ tool_name: 'Edit', tool_input: { file_path: join(docs, 'README.md'), old_string: 'app', new_string: 'application' } });
  assert.equal(ok.decision, 'allow');
  assert.equal(ok.output, null);
});

test('unsupported claims are allowed with a system message, not denied', () => {
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(docs, 'notes.md'), content: 'Handles 50k users.' } });
  assert.equal(r.decision, 'allow');
  assert.match(r.output.systemMessage, /not backed by the facts/);
});

test('excluded and non-matching files are skipped', () => {
  assert.equal(runHook({ tool_name: 'Write', tool_input: { file_path: join(root, 'CHANGELOG.md'), content: '1,200 tests' } }).decision, 'skip');
  assert.equal(runHook({ tool_name: 'Write', tool_input: { file_path: join(root, 'index.js'), content: '// 1,200 tests' } }).decision, 'skip');
  assert.equal(runHook({ tool_name: 'Read', tool_input: { file_path: join(docs, 'README.md') } }).decision, 'skip');
});

test('no config above the file means the hook is inert', () => {
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'x.md'), content: '1,200 tests' } });
  assert.equal(r.decision, 'skip');
});

test('end to end: `fact-gate hook` reads stdin, prints a deny, exits 0', () => {
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(docs, 'README.md'), content: 'Ships 999 tests.' } });
  const p = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'hook'], { input: payload, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const out = JSON.parse(p.stdout.trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('end to end: garbage on stdin never breaks the session', () => {
  const p = spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'hook'], { input: '{not json', encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.equal(p.stdout.trim(), '');
});

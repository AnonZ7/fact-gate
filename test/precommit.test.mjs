import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStaged, stagedPaths } from '../src/precommit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const repo = mkdtempSync(join(tmpdir(), 'fact-gate-precommit-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

git('init', '-q');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
writeFileSync(join(repo, '.fact-gate.json'), JSON.stringify({ facts: { counts: { tests: 12 } }, include: ['.md'], exclude: ['CHANGELOG.md'] }));
mkdirSync(join(repo, 'docs'));
writeFileSync(join(repo, 'docs', 'README.md'), 'Ships 12 tests.\n');
writeFileSync(join(repo, 'CHANGELOG.md'), 'Ships 999 tests.\n');
writeFileSync(join(repo, 'index.js'), '// 999 tests\n');
git('add', '-A'); git('commit', '-q', '-m', 'init');

test('nothing staged: pass, nothing checked', () => {
  const r = checkStaged({ cwd: repo });
  assert.equal(r.results.length, 0);
  assert.equal(r.verdict, 'pass');
});

test('a staged lie is blocked; the working tree is irrelevant', () => {
  writeFileSync(join(repo, 'docs', 'README.md'), 'Ships 999 tests.\n');
  git('add', 'docs/README.md');
  writeFileSync(join(repo, 'docs', 'README.md'), 'Ships 12 tests.\n'); // working tree fixed, index still wrong
  assert.deepEqual(stagedPaths(repo), ['docs/README.md']);
  const r = checkStaged({ cwd: repo });
  assert.equal(r.verdict, 'block');
  assert.equal(r.results[0].path, 'docs/README.md');
  const p = spawnSync(process.execPath, [CLI, 'pre-commit'], { cwd: repo, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stdout, /BLOCK/);
  assert.match(p.stderr, /commit refused/);
});

test('excluded and non-matching staged files are skipped', () => {
  git('add', 'docs/README.md'); // stage the corrected working tree
  writeFileSync(join(repo, 'CHANGELOG.md'), 'Ships 1,000 tests.\n');
  writeFileSync(join(repo, 'index.js'), '// 1,000 tests\n');
  git('add', '-A');
  const r = checkStaged({ cwd: repo });
  assert.deepEqual(r.skipped.sort(), ['CHANGELOG.md', 'index.js']);
  assert.equal(r.verdict, 'pass');
  const p = spawnSync(process.execPath, [CLI, 'pre-commit'], { cwd: repo, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
});

test('outside a git repository: usage error, not a crash', () => {
  const p = spawnSync(process.execPath, [CLI, 'pre-commit'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(p.status, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFacts, measure, isMeasurement } from '../src/facts.mjs';
import { verifyFacts } from '../src/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'fact-gate-'));
writeFileSync(join(dir, 'stats.json'), JSON.stringify({ tests: 846, tools: ['a', 'b', 'c'], nested: { workflows: 85 } }));
writeFileSync(join(dir, 'README.md'), '# demo\n\nShips 846 tests across 3 packages.\n');

test('isMeasurement recognises specs, not literals', () => {
  assert.equal(isMeasurement({ cmd: 'x' }), true);
  assert.equal(isMeasurement({ json: 'x', path: 'a' }), true);
  assert.equal(isMeasurement(846), false);
  assert.equal(isMeasurement('846'), false);
  assert.equal(isMeasurement(['a']), false);
  assert.equal(isMeasurement(null), false);
});

test('json measurement follows a dotted path, with .length and .keys', () => {
  assert.equal(measure({ json: 'stats.json', path: 'tests' }, { cwd: dir }).value, '846');
  assert.equal(measure({ json: 'stats.json', path: 'nested.workflows' }, { cwd: dir }).value, '85');
  assert.equal(measure({ json: 'stats.json', path: 'tools.length' }, { cwd: dir }).value, '3');
  assert.deepEqual(measure({ json: 'stats.json', path: 'tools' }, { cwd: dir }).value, ['a', 'b', 'c']);
});

test('file measurement applies a pattern and a capture group', () => {
  assert.equal(measure({ file: 'README.md', pattern: 'Ships (\\d+) tests' }, { cwd: dir }).value, '846');
  assert.equal(measure({ file: 'README.md', pattern: '(\\d+) tests across (\\d+)', group: 2 }, { cwd: dir }).value, '3');
});

test('cmd measurement runs a command and captures from its output', () => {
  const r = measure({ cmd: 'node -e "console.log(\'# pass 39\')"', pattern: '# pass (\\d+)' }, { cwd: dir });
  assert.equal(r.value, '39');
  assert.match(r.via, /^cmd /);
});

test('a non-zero exit with output is still a measurement; no output is an error', () => {
  const r = measure({ cmd: 'node -e "console.log(\'# pass 12\'); process.exit(1)"', pattern: '# pass (\\d+)' }, { cwd: dir });
  assert.equal(r.value, '12');
  assert.throws(() => measure({ cmd: 'node -e "process.exit(3)"' }, { cwd: dir }), /no output/);
});

test('a pattern that matches nothing is an error, never a silent skip', () => {
  assert.throws(() => measure({ file: 'README.md', pattern: 'nope (\\d+)' }, { cwd: dir }), /matched nothing/);
  assert.throws(() => measure({ json: 'stats.json', path: 'missing.key' }, { cwd: dir }), /not found/);
});

test('resolveFacts replaces specs everywhere and records what it measured', () => {
  const raw = {
    counts: { tests: { json: 'stats.json', path: 'tests' }, packages: 3, 'n8n workflows': { json: 'stats.json', path: 'nested.workflows' } },
    tools: [{ json: 'stats.json', path: 'tools' }, 'n8n'],
    years: [2019],
  };
  const { facts, measurements } = resolveFacts(raw, { cwd: dir });
  assert.deepEqual(facts.counts, { tests: '846', packages: 3, 'n8n workflows': '85' });
  assert.deepEqual(facts.tools, ['a', 'b', 'c', 'n8n']);
  assert.deepEqual(facts.years, [2019]);
  assert.equal(measurements.length, 3);
  assert.deepEqual(measurements.map(m => m.key).sort(), ['counts.n8n workflows', 'counts.tests', 'tools[0]']);
});

test('measured facts gate a document like typed facts do', () => {
  const { facts } = resolveFacts({ counts: { tests: { json: 'stats.json', path: 'tests' } } }, { cwd: dir });
  assert.equal(verifyFacts('Ships with 846 tests.', { facts }).verdict, 'pass');
  assert.equal(verifyFacts('Ships with 1,200 tests.', { facts }).verdict, 'block');
});

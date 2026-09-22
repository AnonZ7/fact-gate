// The hook runs in whatever repository an agent happens to be writing to.
// These tests pin the two promises that make that safe: nothing in a config
// runs for a file the config does not cover, and a config's shell commands
// do not run on this machine until it has been trusted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/hook.mjs';
import { trust, isTrusted } from '../src/trust.mjs';
import { resolveFacts } from '../src/facts.mjs';

const root = mkdtempSync(join(tmpdir(), 'fact-gate-sec-'));
const marker = join(root, 'RAN.txt').replace(/\\/g, '/');
const cmd = `node -e "require('fs').writeFileSync('${marker}', 'ran')"`;
writeFileSync(join(root, '.fact-gate.json'), JSON.stringify({
  facts: { counts: { tests: { cmd, pattern: '(.*)' }, agents: 4 } },
  include: ['.md'],
}));
mkdirSync(join(root, 'sub'));
process.env.FACT_GATE_TRUST_FILE = join(root, 'trusted.json');
delete process.env.FACT_GATE_ALLOW_CMD;

test('a write to a file the config does not cover runs NOTHING from the config', () => {
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(root, 'sub', 'notes.py'), content: '# 999 tests' } });
  assert.equal(r.decision, 'skip');
  assert.equal(existsSync(marker), false, 'the cmd measurement must not have run');
});

test('an untrusted config never runs its cmd measurements; literal facts still gate', () => {
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(root, 'README.md'), content: 'Ships 9 agents.' } });
  assert.equal(existsSync(marker), false, 'the cmd measurement must not have run');
  assert.equal(r.decision, 'deny', 'the literal fact (4 agents) still blocks 9');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /not trusted/);
});

test('with only cmd facts and no trust, the hook allows and says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-gate-sec2-'));
  writeFileSync(join(dir, '.fact-gate.json'), JSON.stringify({ facts: { counts: { tests: { cmd, pattern: '(.*)' } } } }));
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(dir, 'README.md'), content: 'Ships 999 tests.' } });
  assert.equal(r.decision, 'allow');
  assert.match(r.output.systemMessage, /fact-gate trust/);
  assert.equal(existsSync(marker), false);
});

test('fact-gate trust records the config hash; editing the file revokes it', () => {
  const cfg = join(root, '.fact-gate.json');
  assert.equal(isTrusted(cfg), false);
  const t = trust(cfg);
  assert.equal(t.commands.length, 1);
  assert.equal(isTrusted(cfg), true);
  const r = runHook({ tool_name: 'Write', tool_input: { file_path: join(root, 'README.md'), content: 'Ships 4 agents.' } });
  assert.equal(r.decision, 'allow', JSON.stringify(r.output));
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'trusted: the command ran');
  writeFileSync(cfg, readFileSync(cfg, 'utf8') + '\n');
  assert.equal(isTrusted(cfg), false, 'a changed file is no longer trusted');
});

test('FACT_GATE_ALLOW_CMD=1 trusts everything (CI use)', () => {
  process.env.FACT_GATE_ALLOW_CMD = '1';
  try { assert.equal(isTrusted(join(root, 'nonexistent.json'), '{}'), true); }
  finally { delete process.env.FACT_GATE_ALLOW_CMD; }
});

test('resolveFacts with allowCmd=false drops cmd specs and reports them as skipped', () => {
  const { facts, skipped } = resolveFacts({ counts: { tests: { cmd: 'echo 1' }, agents: 4 } }, { allowCmd: false });
  assert.deepEqual(facts.counts, { agents: 4 });
  assert.deepEqual(skipped, [{ key: 'counts.tests', cmd: 'echo 1' }]);
});

// Findings from the pre-release adversarial review (2026-09-22), each pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyFacts, formatReport, numericClaims } from '../src/index.mjs';
import { parseArgs } from '../src/cli.mjs';

const diff = readFileSync(new URL('../examples/pr.diff', import.meta.url), 'utf8');

test('a negated count is not a claim of that count (false block found in review)', () => {
  assert.equal(verifyFacts('This PR does NOT touch 12 files.', { diff }).verdict, 'pass');
  assert.equal(verifyFacts("It doesn't add 40 tests.", { diff }).verdict, 'pass');
  assert.equal(verifyFacts('Merged without adding 300 lines.', { diff }).verdict, 'pass');
  // ...and the positive form still blocks.
  assert.equal(verifyFacts('This PR touches 12 files.', { diff }).verdict, 'block');
});

test('fullwidth and Arabic-Indic digits are digits (missed fabrication found in review)', () => {
  assert.equal(verifyFacts('５００ files changed in this release.', { diff }).verdict, 'block');
  assert.equal(verifyFacts('Adds ٤٠ tests.', { diff }).verdict, 'block');
  assert.equal(numericClaims('６ files')[0].number, '6');
});

test('a heading on the previous line does not qualify a noun-first claim (stranger test)', () => {
  const facts = { counts: { tests: 2 } };
  const r = verifyFacts('## Status\n\nTests: 999\n', { facts });
  assert.equal(r.verdict, 'block', formatReport(r));
  assert.equal(verifyFacts('## Status\n\nTests: 2\n', { facts }).verdict, 'pass');
  // A real qualifier on the same line still binds.
  assert.equal(verifyFacts('Unit tests: 999', { facts: { counts: { 'unit tests': 2 } } }).verdict, 'block');
});

test('hard-wrapped prose still extracts across the line break', () => {
  const r = verifyFacts('Runs 85 n8n\nworkflows in production.', { facts: { counts: { 'n8n workflows': 85 } } });
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('an unknown --flag is a usage error, not silently ignored', () => {
  assert.throws(() => parseArgs(['--sources', 'x.md']), /unknown option --sources/);
});

test('the contradiction message does not list sub-figures of the best match', () => {
  const r = verifyFacts('Touches 12 files.', { diff });
  assert.match(r.fabricated[0].reason, /^source states 6 files \(changed\), not 12$/);
});

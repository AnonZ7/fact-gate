// Regression tests. Each case is a defect that reached production in the
// original job-hunt gate (2026-09-19 → 2026-09-22) and was reproduced against
// the pre-1.0 code before being fixed. They are numbered B1–B5 in CHANGELOG.md.
//
// The source is synthetic. Numbers mirror the shapes that broke, not any
// real person's data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFacts, numericClaims, formatReport } from '../src/index.mjs';

const SOURCE = `
Acme Robotics (client since Jul 2024): 85 n8n workflows built, 32 in daily production.
Festival project: 18 active n8n workflows + 3 custom apps.
Storefront app: 846 tests (Playwright 461 + Flutter 242 + Vitest 61 + Jest 82).
Platform: 580+ MCP tools, 160 sub-agents, 4,600+ automated tests.
`;
const check = (t, o = {}) => verifyFacts(t, { source: SOURCE, ...o });

test('B1 (2026-09-21): a trailing sub-count "…, 32 in daily production" is extracted from the source', () => {
  // Pre-fix: "32 workflows" was BLOCKED as fabricated — "source states 85 / 18 workflows, not 32".
  // A true sentence rejected outright, the worst failure mode a gate can have.
  const src = numericClaims(SOURCE).find(c => c.kind === 'count' && c.number === '32');
  assert.ok(src, 'source must yield a 32-workflows claim');
  assert.equal(src.noun, 'workflows');
  assert.equal(src.derivedFrom, 'subcount');
  assert.ok(src.modifiers.includes('daily') && src.modifiers.includes('production'));

  const r = check('I keep 32 n8n workflows in daily production.');
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('B2 (2026-09-19): a lower-bound claim is judged against the best-matching figure, not the smallest', () => {
  // Pre-fix: "30+ n8n workflows" → "source states 18 workflows, which is less than the claimed 30+".
  // 18 was the festival's count; the shared-qualifier match (85 / 32, both n8n) was ignored
  // and the smallest comparable entry was reported instead.
  const r = check('Runs 30+ n8n workflows in production.');
  assert.equal(r.verdict, 'pass', formatReport(r));
  const c = r.verified.find(x => x.claim === '30+ workflows');
  assert.ok(c);
  assert.match(c.reason, /confirms 32 workflows/);
});

test('B3 (2026-09-22): a number token never spans a sentence boundary', () => {
  // Pre-fix: "since 2024. 32 n8n workflows" produced the claim "2024. 32 workflows".
  const claims = numericClaims('since 2024. 32 n8n workflows').map(c => c.claim);
  assert.ok(claims.includes('2024'));
  assert.ok(claims.includes('32 workflows'));
  assert.ok(!claims.some(c => c.includes('2024. 32')), JSON.stringify(claims));

  const r = check('Shipping integrated systems since 2024. 32 n8n workflows run in production.');
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('B4 (2026-09-19): a parenthetical breakdown "(Playwright 461 + Flutter 242)" is extracted', () => {
  // Pre-fix: "461 Playwright tests" was unsupported — "source counts tests only in another
  // context (846)". The 461 was right there, in "Noun Number" order inside the parentheses.
  const src = numericClaims(SOURCE).filter(c => c.derivedFrom === 'breakdown').map(c => `${c.number}:${c.modifiers.join(',')}`);
  assert.deepEqual(src.sort(), ['242:flutter', '461:playwright', '61:vitest', '82:jest']);

  const r = check('The storefront runs 461 Playwright tests.');
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('B5 (2026-09-22): a bare claim is confirmed by a qualified source figure', () => {
  // Pre-fix: "580 tools" vs source "580+ MCP tools" → "not comparable" → unsupported.
  // A bare claim is the least specific claim there is; extra words in the source
  // are not a contradiction.
  const r = check('The platform exposes 580 tools.');
  assert.equal(r.verdict, 'pass', formatReport(r));
  assert.match(r.verified[0].reason, /source states 580\+ tools \(mcp\)/);
});

test('B5 does not weaken contradiction: a different bare number is still a block', () => {
  const r = check('The platform exposes 900 tools.');
  assert.equal(r.verdict, 'warn', 'disjoint qualifiers → unsupported, not block (tools vs MCP tools)');
  // …but with a bare source figure it IS a block:
  const r2 = verifyFacts('The storefront ships 1,200 tests.', { source: 'Storefront app: 846 tests.' });
  assert.equal(r2.verdict, 'block');
  assert.match(r2.fabricated[0].reason, /846 tests, not 1200/);
});

test('allowlist audit (2026-09-21): entries that rescue nothing are reported as unused', () => {
  // A stale "4 hours" whitelist had been added to push a FALSE claim past the gate.
  // The gate now says which allow_metrics entries actually did any work.
  const r = check('Runs 85 n8n workflows.', { config: { allow_metrics: ['4 hours', '85 workflows'] } });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.allowlist.unused, ['4 hours']);
  assert.match(formatReport(r), /ALLOWLIST_UNUSED: "4 hours"/);
});

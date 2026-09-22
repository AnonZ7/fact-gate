// The NEGATIVE cases are the point. A gate that only ever passes proves
// nothing, so every fabrication class this exists to stop has a test that
// asserts it BLOCKS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyFacts, assertFacts, formatReport } from '../src/index.mjs';

const SOURCE = readFileSync(new URL('../examples/source.md', import.meta.url), 'utf8');
const check = (t, o = {}) => verifyFacts(t, { source: SOURCE, ...o });
const NOW = Date.UTC(2026, 8, 22);

// ------------------------------------------------------------ truth passes
test('a text built only from real source facts passes clean', () => {
  const honest = [
    'Designed and run 85 n8n workflows unifying the CRM, telephony and payments.',
    'Pipeline holds 183,444 call records and 2,622 live deals with automated dedup.',
    'QR code check-in system serving 200+ attendees.',
    'The platform exposes 580+ tools with 4,600+ automated tests.',
    'The storefront ships with 846 tests and 109 products live on Google Play.',
  ].join('\n');
  const r = check(honest, { now: NOW });
  assert.equal(r.verdict, 'pass', formatReport(r));
  assert.equal(r.counts.fabricated, 0);
  assert.ok(r.counts.verified >= 7);
  assert.doesNotThrow(() => assertFacts(honest, { source: SOURCE }));
});

// -------------------------------------------- fabrication is caught and BLOCKS
test('an INFLATED COUNT blocks', () => {
  const r = check('The storefront ships with 1,200 tests across the stack.');
  assert.equal(r.verdict, 'block');
  assert.equal(r.fabricated[0].claim, '1200 tests');
  assert.match(r.fabricated[0].reason, /846 tests, not 1200/);
  assert.match(formatReport(r), /\[CRITICAL\] FABRICATED_COUNT: "1200 tests"/);
  assert.throws(() => assertFacts('ships with 1,200 tests.', { source: SOURCE }), /Fact check failed/);
});

test('an inflated count survives paraphrase — a qualifier does not launder it', () => {
  const r = check('Built and run 400 production n8n workflows.');
  assert.equal(r.verdict, 'block');
  assert.match(r.fabricated[0].reason, /\b85\b/);
});

test('an inflated FLOOR blocks; an understated floor blocks too', () => {
  assert.equal(check('Runs 900+ n8n workflows.').verdict, 'block', 'floor above the real figure');
  // 10+ passes: the source also states 18 festival n8n workflows, and 10 is a fair floor
  // for 18. The gate reads a floor generously against EVERY comparable figure.
  assert.equal(check('Runs 10+ n8n workflows.').verdict, 'pass');
  const low = check('Runs 5+ n8n workflows.');
  assert.equal(low.verdict, 'block', 'floor below 50% of every comparable figure is an understatement');
  assert.match(low.fabricated[0].reason, /understates/);
});

test('an INFLATED PERCENTAGE blocks', () => {
  const r = check('Cut manual reconciliation effort by 87%.');
  assert.equal(r.verdict, 'block');
  assert.deepEqual(r.fabricated.map(c => c.claim), ['87%']);
});

test('an INVENTED AMOUNT and MULTIPLIER block', () => {
  assert.equal(check('Recovered $250,000 in lost revenue.').fabricated[0].kind, 'amount');
  assert.equal(check('Delivered a 12x throughput improvement.').fabricated[0].kind, 'multiplier');
  assert.equal(check('Caught revenue reported 8x too high.').verdict, 'pass', 'the real 8x passes');
});

test('a YEAR absent from the source blocks; a real one passes', () => {
  const r = check('Leading integration delivery since 2015.');
  assert.equal(r.verdict, 'block');
  assert.equal(r.fabricated[0].kind, 'year');
  assert.equal(check('Joined Acme Robotics in 2024.').counts.fabricated, 0);
});

test('an EMPLOYER never worked for blocks; a real one passes', () => {
  const r = check('Worked at Initech as an Integration Engineer.');
  assert.equal(r.fabricated.find(c => c.kind === 'employer')?.value, 'initech');
  assert.equal(check('Worked at Contoso Digital on e-commerce delivery.').counts.fabricated, 0);
});

test('a TITLE never held blocks; a real one passes', () => {
  const r = check('Served as Chief Technology Officer for a training group.');
  assert.match(r.fabricated.find(c => c.kind === 'title')?.value, /chief technology officer/);
  assert.equal(check('Worked as Lead Full-Stack Developer at Northwind Group.').counts.fabricated, 0);
});

test('a spelled-out TENURE over-claim blocks; a fair one passes', () => {
  // Earliest role starts Feb 2019 → ~7.6 years at NOW.
  assert.equal(check('twelve years shipping production code', { now: NOW }).verdict, 'block');
  assert.equal(check('six years shipping production code', { now: NOW }).verdict, 'pass');
  assert.equal(check('over a decade in ops', { now: NOW }).verdict, 'block');
});

test('several fabrications in one text are ALL reported', () => {
  const r = check(['Worked at Initech as a Staff Engineer.', 'Cut costs by 87% since 2015.', 'Shipped 1,200 tests.'].join('\n'));
  const kinds = new Set(r.fabricated.map(c => c.kind));
  for (const k of ['employer', 'percentage', 'year', 'count']) assert.ok(kinds.has(k), `missing ${k}`);
});

// --------------------------------------------------- three-way classification
test('an unrelated count is unsupported, not fabricated — and never dropped', () => {
  const r = check('Built 2 custom automation tools from scratch for a client.');
  assert.equal(r.verdict, 'warn');
  assert.equal(r.counts.fabricated, 0);
  assert.match(formatReport(r), /\[WARNING\] UNSUPPORTED_COUNT: "2 tools"/);
});

test('a tool named only in the reference text warns rather than blocking', () => {
  const r = check('Delivered the integration using Snowflake.');
  assert.equal(r.verdict, 'warn');
  assert.equal(r.unsupported[0].value, 'snowflake');
});

test('a figure quoted verbatim from the reference text is an echo, not a self-claim', () => {
  const claim = 'Ready to own the first 90 days and hit 87% adoption.';
  assert.equal(check(claim).verdict, 'block');
  const echoed = check(claim, { jd: 'In your first 90 days you will drive 87% adoption.' });
  assert.equal(echoed.verdict, 'warn');
  assert.ok(echoed.unsupported.some(c => /echo/.test(c.reason)));
});

// ---------------------------------------------------------- structured facts
test('structured facts work alone and alongside prose', () => {
  const facts = { counts: { tests: 4664, 'mcp tools': '585', 'n8n workflows': 85, 'n8n workflows daily production': 32 }, years: [2019, 2024], employers: ['Acme Robotics'], experience_start: '2019-02' };
  const r = verifyFacts('Runs 32 n8n workflows in daily production with 4,664 tests since 2019. Worked at Acme Robotics.', { facts, now: NOW });
  assert.equal(r.verdict, 'pass', formatReport(r));
  assert.equal(verifyFacts('Runs 9,000 tests.', { facts }).verdict, 'block');
  assert.equal(verifyFacts('six years in the field', { facts, now: NOW }).verdict, 'pass');
});

// ------------------------------------------------------------------- config
test('allow_metrics whitelists a figure and is audited; forbidden_phrases blocks', () => {
  const claim = 'Grew signups 42% quarter over quarter.';
  assert.equal(check(claim).verdict, 'block');
  const ok = check(claim, { config: { allow_metrics: ['42%'] } });
  assert.equal(ok.verdict, 'pass');
  assert.deepEqual(ok.allowlist.used, ['42%']);
  const r = check('Standard delivery, nothing unusual.', { config: { forbidden_phrases: ['nothing unusual'] } });
  assert.equal(r.verdict, 'block');
  assert.match(formatReport(r), /FORBIDDEN_PHRASE/);
});

test('allow_facts whitelists an employer the source words differently', () => {
  assert.equal(check('Worked at Acme Robotics SA on the CRM layer.', { config: { allow_facts: ['Acme Robotics SA'] } }).counts.fabricated, 0);
});

test('refuses to run without a source — an empty gate is not a gate', () => {
  assert.throws(() => verifyFacts('anything', {}), /requires a source of truth/);
  assert.throws(() => verifyFacts('anything', { source: '   ' }), /requires a source of truth/);
  assert.throws(() => verifyFacts('x', { source: SOURCE, config: { allow_metrics: 'nope' } }), /config\.allow_metrics must be an array/);
});

test('every claim carries a status and the counts add up', () => {
  const r = check('Ran 85 workflows, built 2 custom automation tools, cut costs 87%.');
  assert.equal(r.claims.length, r.counts.total);
  assert.equal(r.counts.verified + r.counts.unsupported + r.counts.fabricated, r.counts.total);
});

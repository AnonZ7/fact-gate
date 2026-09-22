import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericClaims, factClaims, createExtractor } from '../src/extract.mjs';
import { normalizeNumber, normalizeClaim, stripMarkup } from '../src/normalize.mjs';

const kinds = (t) => numericClaims(t).map(c => `${c.kind}:${c.claim}`).sort();

test('reads counts, percentages, amounts, multipliers and years', () => {
  assert.deepEqual(kinds('Ran 85 workflows'), ['count:85 workflows']);
  assert.deepEqual(kinds('Cut cost 40%'), ['percentage:40%']);
  assert.deepEqual(kinds('Closed a $90,000 deal'), ['amount:$90000']);
  assert.deepEqual(kinds('Delivered a 3x speedup'), ['multiplier:3x']);
  assert.deepEqual(kinds('Joined in 2019'), ['year:2019']);
});

test('normalizeNumber: grouping, decimals, magnitudes', () => {
  assert.equal(normalizeNumber('183,444'), '183444');
  assert.equal(normalizeNumber('183 444'), '183444');
  assert.equal(normalizeNumber('4.5K'), '4500');
  assert.equal(normalizeNumber('1.2M'), '1200000');
  assert.equal(normalizeNumber('3.75'), '3.75');
  assert.equal(normalizeNumber('50k'), '50000');
  assert.equal(normalizeClaim('50k users'), '50000 users');
});

test('a magnitude suffix belongs to the number: 50k never reads as 50', () => {
  assert.equal(numericClaims('Served 50k users').find(c => c.kind === 'count').claim, '50000 users');
});

test('the number binds to the NEAREST noun and keeps its "+"', () => {
  const c = numericClaims('15+ years scaling teams').find(x => x.kind === 'count');
  assert.equal(c.noun, 'years');
  assert.equal(c.claim, '15+ years');
  assert.equal(c.isLowerBound, true);
});

test('a digit inside a token is not a number: "n8n" yields no 8', () => {
  assert.ok(!numericClaims('n8n workflows').some(c => c.number === '8'));
});

test('ranges yield both ends', () => {
  assert.ok(kinds('4-5 hours of overlap').includes('count:4 hours'));
  assert.ok(kinds('4-5 hours of overlap').includes('count:5 hours'));
  assert.deepEqual(kinds('$3K–$4.5K per month'), ['amount:$3000', 'amount:$4500']);
  assert.deepEqual(kinds('40-60% faster'), ['percentage:40%', 'percentage:60%']);
});

test('noun-first order "tests: 846" is a count', () => {
  const c = numericClaims('Tests: 846. Tools — 585.').filter(x => x.kind === 'count');
  assert.deepEqual(c.map(x => x.claim).sort(), ['585 tools', '846 tests']);
  assert.equal(c[0].derivedFrom, 'noun-first');
});

test('spelled-out tenure is extracted as its own kind', () => {
  assert.deepEqual(kinds('six years shipping backend services'), ['spelled_years:six years']);
  assert.deepEqual(kinds('over a decade in ops'), ['spelled_years:a decade']);
});

test('a year next to a plural is a date, not a count of 2024 things', () => {
  assert.deepEqual(kinds('led the 2024 workflows migration'), ['year:2024']);
});

test('stripMarkup reduces rendered HTML to prose', () => {
  assert.equal(stripMarkup('<strong>85</strong> n8n &amp; Zoho workflows'), '85 n8n & Zoho workflows');
});

test('factClaims reads employer, title and tool assertions', () => {
  const c = factClaims('Worked at Initech as a Principal Engineer using Kubernetes and Terraform.');
  const by = (k) => c.filter(x => x.kind === k).map(x => x.value);
  assert.deepEqual(by('employer'), ['initech']);
  assert.ok(by('tool').includes('kubernetes'));
  assert.ok(by('tool').includes('terraform'));
});

test('custom nouns extend the vocabulary; synonyms fold', () => {
  const ex = createExtractor({ nouns: ['widgets'], synonyms: { widgets: 'gadgets' } });
  const c = ex.numericClaims('shipped 12 widgets');
  assert.equal(c[0].noun, 'gadgets');
  assert.equal(c[0].claim, '12 gadgets');
});

test('extraction is deterministic and de-duplicated', () => {
  const a = numericClaims('85 workflows, 85 workflows, 85 workflows');
  assert.equal(a.length, 1);
});

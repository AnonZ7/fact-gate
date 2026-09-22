#!/usr/bin/env node
// Eval harness for the gate itself.
//
// A verifier is only trustworthy if you measure it the way you would measure
// the model it polices. This runs every case in cases.json and reports:
//
//   precision  of everything the gate BLOCKED, how much deserved it
//   recall     of every true fabrication, how much the gate CAUGHT
//   false blocks  true statements rejected — the worst failure a gate can have
//
// Cases are grouped by suite (a source of truth: prose, a diff, or facts), so
// the same numbers are reported per domain — CV, PR description, docs — and
// nobody can hide a weak domain inside a strong average.
//
// Exit 1 on any regression, so it can sit in CI next to the unit tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyFacts, formatReport } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const spec = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const now = spec.now ? Date.parse(spec.now) : Date.now();
const json = process.argv.includes('--json');

const suites = [];
let tp = 0, fp = 0, fn = 0, tn = 0;
const failures = [];
const rows = [];

for (const suite of spec.suites) {
  const options = { now };
  if (suite.source) options.source = readFileSync(join(root, suite.source), 'utf8');
  if (suite.diff) options.diff = readFileSync(join(root, suite.diff), 'utf8');
  if (suite.facts) options.facts = suite.facts;
  if (suite.nouns) options.nouns = suite.nouns;
  const s = { name: suite.name, tp: 0, fp: 0, fn: 0, tn: 0, cases: suite.cases.length };
  for (const c of suite.cases) {
    const r = verifyFacts(c.target, { ...options, label: c.id });
    const blocked = r.verdict === 'block';
    const shouldBlock = c.expect === 'block';
    if (blocked && shouldBlock) { tp++; s.tp++; }
    else if (blocked && !shouldBlock) { fp++; s.fp++; failures.push({ ...c, suite: suite.name, got: r.verdict, detail: formatReport(r) }); }
    else if (!blocked && shouldBlock) { fn++; s.fn++; failures.push({ ...c, suite: suite.name, got: r.verdict, detail: formatReport(r) }); }
    else { tn++; s.tn++; }
    // warn-vs-pass is reported but never fails the run: both are "not blocked".
    const exactMatch = r.verdict === c.expect;
    rows.push(`${exactMatch ? ' ok ' : blocked === shouldBlock ? ' ~  ' : 'FAIL'} ${c.id.padEnd(4)} expect=${c.expect.padEnd(5)} got=${r.verdict.padEnd(5)}  ${c.why}`);
  }
  suites.push(s);
}

const prec = (a, b) => a + b ? a / (a + b) : 1;
const pct = (x) => (x * 100).toFixed(1) + '%';
const total = spec.suites.reduce((n, s) => n + s.cases.length, 0);
const summary = {
  cases: total, blockedCorrectly: tp, passedCorrectly: tn, falseBlocks: fp, missedFabrications: fn,
  precision: prec(tp, fp), recall: prec(tp, fn),
  suites: suites.map(s => ({ name: s.name, cases: s.cases, precision: prec(s.tp, s.fp), recall: prec(s.tp, s.fn), falseBlocks: s.fp, missed: s.fn })),
};

if (json) { console.log(JSON.stringify(summary, null, 2)); }
else {
  console.log(rows.join('\n'));
  console.log('');
  for (const s of summary.suites) console.log(`${s.name.padEnd(18)} cases: ${String(s.cases).padStart(3)}   precision: ${pct(s.precision).padStart(6)}   recall: ${pct(s.recall).padStart(6)}   false-blocks: ${s.falseBlocks}   missed: ${s.missed}`);
  console.log(`\ncases: ${total}   blocked-correctly: ${tp}   passed-correctly: ${tn}   false-blocks: ${fp}   missed-fabrications: ${fn}`);
  console.log(`precision: ${pct(summary.precision)}   recall: ${pct(summary.recall)}`);
}
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  [${f.suite}] ${f.id} (${f.expect} → ${f.got}): ${f.target}\n      ${f.detail.replace(/\n/g, '\n      ')}`);
  process.exit(1);
}
if (!json) console.log('eval: all cases within expectation');

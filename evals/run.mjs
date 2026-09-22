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
// Exit 1 on any regression, so it can sit in CI next to the unit tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyFacts, formatReport } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const source = readFileSync(join(here, '..', spec.source), 'utf8');
const now = spec.now ? Date.parse(spec.now) : Date.now();

let tp = 0, fp = 0, fn = 0, tn = 0;
const failures = [];
const rows = [];

for (const c of spec.cases) {
  const r = verifyFacts(c.target, { source, now, label: c.id });
  const blocked = r.verdict === 'block';
  const shouldBlock = c.expect === 'block';
  if (blocked && shouldBlock) tp++;
  else if (blocked && !shouldBlock) { fp++; failures.push({ ...c, got: r.verdict, detail: formatReport(r) }); }
  else if (!blocked && shouldBlock) { fn++; failures.push({ ...c, got: r.verdict, detail: formatReport(r) }); }
  else tn++;
  // warn-vs-pass is reported but never fails the run: both are "not blocked".
  const exactMatch = r.verdict === c.expect;
  rows.push(`${exactMatch ? ' ok ' : blocked === shouldBlock ? ' ~  ' : 'FAIL'} ${c.id}  expect=${c.expect.padEnd(5)} got=${r.verdict.padEnd(5)}  ${c.why}`);
}

const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
const pct = (x) => (x * 100).toFixed(1) + '%';

console.log(rows.join('\n'));
console.log(`\ncases: ${spec.cases.length}   blocked-correctly: ${tp}   passed-correctly: ${tn}   false-blocks: ${fp}   missed-fabrications: ${fn}`);
console.log(`precision: ${pct(precision)}   recall: ${pct(recall)}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  ${f.id} (${f.expect} → ${f.got}): ${f.target}\n      ${f.detail.replace(/\n/g, '\n      ')}`);
  process.exit(1);
}
console.log('eval: all cases within expectation');

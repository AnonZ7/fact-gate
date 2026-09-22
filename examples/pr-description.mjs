// Example: a PR description checked against the diff it describes.
//
//   node examples/pr-description.mjs
//
// The diff is a real unified diff (examples/pr.diff): two files added, one
// deleted, three modified, 26 lines in, 6 out, four test cases, one new
// dependency. Two descriptions of it: one truthful, one the way a model
// writes them on the first try.

import { readFileSync } from 'node:fs';
import { verifyFacts, formatReport, factsFromDiff } from '../src/index.mjs';

const here = new URL('./', import.meta.url);
const diff = readFileSync(new URL('pr.diff', here), 'utf8');

console.log('facts derived from the diff:');
const f = factsFromDiff(diff);
for (const k of ['files', 'files added', 'files deleted', 'lines added', 'lines deleted', 'tests added', 'dependencies added']) console.log(`  ${k.padEnd(20)} ${f.counts[k]}`);
console.log(`  ${'dependencies'.padEnd(20)} ${f.tools.join(', ')}\n`);

for (const name of ['pr-body.md', 'pr-body-inflated.md']) {
  const body = readFileSync(new URL(name, here), 'utf8');
  const r = verifyFacts(body, { diff, label: name });
  console.log(`${r.verdict.toUpperCase().padEnd(6)} ${name} — ${r.counts.verified} verified, ${r.counts.unsupported} unsupported, ${r.counts.fabricated} fabricated`);
  console.log('  ' + formatReport(r) + '\n');
}

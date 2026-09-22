// Example: gate a model-written CV summary against a canonical profile,
// and feed the reasons back into the prompt when it fails.
//
//   node examples/cv-tailoring.mjs
//
// No model is called here — `draft()` stands in for one, and returns the
// kind of paraphrase a real model produces on the first try.

import { readFileSync } from 'node:fs';
import { verifyFacts, formatReport } from '../src/index.mjs';

const source = readFileSync(new URL('./source.md', import.meta.url), 'utf8');

// A typical first draft. Two things pass — "six years" is under the real
// tenure and "800+" is a fair floor for 846 — and two block: "100+" is a
// floor ABOVE the real 85, and 45% appears nowhere in the source.
const drafts = [
  `Automation lead with six years shipping production systems. Built 100+ n8n
   workflows for Acme Robotics and cut manual reconciliation by 45%. Ships a
   storefront with 800+ tests.`,
  // …and the "corrected" second draft a model returns after seeing the report:
  `Automation lead shipping production systems since 2019. Built 85 n8n
   workflows for Acme Robotics, 32 in daily production, and cut manual
   reconciliation by 40%. Ships a storefront with 846 tests.`,
];

for (const [i, text] of drafts.entries()) {
  const r = verifyFacts(text, { source, label: `draft ${i + 1}`, now: Date.UTC(2026, 8, 22) });
  console.log(`\n${r.verdict.toUpperCase()}  ${r.label} — ${r.counts.verified} verified, ${r.counts.unsupported} unsupported, ${r.counts.fabricated} fabricated`);
  console.log('  ' + formatReport(r));
  if (r.verdict !== 'block') break;
  console.log('\n  → feed the lines above back to the model as "CORRECT THESE" and regenerate');
}

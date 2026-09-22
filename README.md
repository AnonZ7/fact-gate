# fact-gate

**Verify LLM-generated text against a source of truth. Block on fabrication.**

Zero dependencies. Zero LLM calls. Runs offline in milliseconds.

```
$ echo "Ran 1,200 tests across the stack." | fact-gate --source profile.md
BLOCK  stdin — 1 claims: 0 verified, 0 unsupported, 1 fabricated
  [CRITICAL] FABRICATED_COUNT: "1200 tests" — source states 846 tests, not 1200
```

---

## The problem this solves

You hand a model a document full of real figures and tell it to use them. It
paraphrases. A paraphrased number is a fabricated number:

| You wrote | The model wrote | What happened |
|---|---|---|
| 846 tests | "800+ tests" | rounded |
| 85 workflows | "100+ workflows" | inflated |
| 32 in daily production | "30+ workflows" | rounded *down* — still not what you said |
| *(nothing)* | "Cut costs 87%" | invented |
| Jul 2024 – Present | "six years of experience" | over-claimed |
| *(a company named in the job ad)* | "Worked at Initech" | absorbed from context |

Every one of those went out in a real CV before this gate existed. Generic
"hallucination detectors" that ask a second model to grade the first are slow,
non-deterministic, and wrong in ways you can't audit. This is a different
approach: **extract every checkable claim with rules, compare each one against
the source with rules, and refuse to ship on a contradiction.** Same input,
same verdict, every time — and every verdict comes with a reason you can read.

## What it checks

Every claim the generated text makes lands in one of three buckets:

| Bucket | Meaning | Effect |
|---|---|---|
| **verified** | the source states it | — |
| **unsupported** | the source neither states nor contradicts it | reported, never blocking |
| **fabricated** | the source contradicts it, or it's a hard self-claim with no evidence | **blocks** |

Claim kinds: counts (`85 workflows`, `500+ tools`, `4-5 hours`), percentages,
amounts (`$90k`, `$3K–$4.5K`), multipliers (`8x`), years, spelled-out tenure
(`six years`, `a decade`), employers, titles, tools.

**A gate that never fails anything is not a gate.** `fabricated` blocks by
design — and the *negative* tests are the ones that matter in this repo.

## Install

```bash
npm install fact-gate        # library
npx fact-gate --help         # CLI
```

Node ≥ 20. No dependencies.

## Use

### Library

```js
import { verifyFacts, assertFacts, formatReport } from 'fact-gate';

const result = verifyFacts(generatedText, {
  source: canonicalProfileText,      // prose, and/or:
  facts: {                           // structured
    counts: { tests: 4664, 'n8n workflows': 85, 'n8n workflows daily production': 32 },
    years: [2019, 2024],
    employers: ['Acme Robotics'],
    experience_start: '2019-02',
  },
  jd: jobDescriptionText,            // optional: figures quoted from here are echoes, not self-claims
  config: {
    allow_metrics: ['42%'],          // confirmed figures the source doesn't state
    forbidden_phrases: ['synergy'],  // always block
  },
});

result.verdict;        // 'pass' | 'warn' | 'block'
result.fabricated;     // [{ kind, claim, reason, … }]
result.allowlist;      // { used: [...], unused: [...] }  ← audit your own overrides
console.log(formatReport(result));

assertFacts(generatedText, { source });   // throws on 'block'
```

### CLI

```bash
fact-gate --target cv.md --source profile.md
fact-gate --target cv.md --facts facts.json --jd job.md --config gate.json --json
cat cv.md | fact-gate --source profile.md --strict     # exit 1 on warn too
```

Exit `0` pass · `1` block · `2` usage error.

### In a generation loop

```js
for (let attempt = 0; attempt < 3; attempt++) {
  const draft = await model.generate(prompt);
  const gate = verifyFacts(draft, { source, jd });
  if (gate.verdict !== 'block') return draft;
  prompt += `\n\nCORRECT THESE:\n${formatReport(gate)}`;   // the reasons are model-readable
}
throw new Error('model could not produce a truthful draft');
```

## How the comparison works — and why it's asymmetric

Three questions, in order, with deliberately different strictness:

**1. Verification is generous.** Same noun, same number → verified, qualifiers
ignored. `"580 tools"` is confirmed by a source that says `"580+ MCP tools"`.
A matching number is evidence; extra words around it are not a contradiction.

**2. A floor is a floor.** `"500+ tools"` is a lower bound, not an equality.
It holds when the source figure is ≥ 500 *and* 500 isn't an absurd
understatement (≥ 50% of the real figure). It's judged against the
best-matching source figure, and that figure is the one named in the message.

**3. Contradiction is strict.** Different number for the *same subject* →
fabricated. Two claims are the same subject only when their qualifiers
overlap, or neither has any. `"2 custom automation tools"` and `"575 MCP
tools"` share a plural and nothing else — that's *unsupported*, not a block.

Being generous about confirmation and strict about contradiction can only
produce **fewer false blocks**. An unmatched claim still surfaces as
unsupported and is never silently dropped.

Extraction runs the *same rules on both sides*, so a figure the source states
one way and the model restates another still meets in the middle: `"tests:
846"`, `"846 tests (Playwright 461 + Flutter 242)"`, `"85 built, 32 in daily
production"` all index as counts.

## Measured, not asserted

The gate is evaluated the way you'd evaluate the model it polices.
`npm run eval` runs 33 cases — 15 true fabrications, 18 true statements —
and reports precision and recall on the block decision:

```
cases: 33   blocked-correctly: 15   passed-correctly: 18   false-blocks: 0   missed-fabrications: 0
precision: 100.0%   recall: 100.0%
```

**False blocks are the number to watch.** A gate that rejects true statements
gets whitelisted around, and a whitelisted gate is worse than none — it
produces confidence without checking. That's why `result.allowlist.unused`
exists: an allow-list entry that rescues nothing is either stale or hiding a
bug that's since been fixed, and the report says so.

## Regressions, with dates

Every defect that reached production in the original gate has a dated test
in [`test/regressions.test.mjs`](test/regressions.test.mjs). Five were found
in one week of real use and reproduced against the pre-1.0 code before being
fixed — 4 of 5 reproduced cleanly; all 5 now pass.

| | Defect | What it did |
|---|---|---|
| B1 | trailing sub-count `"…, 32 in daily production"` not extracted | **blocked a true sentence** as fabricated |
| B2 | floor judged against the *smallest* figure, not the best match | wrong figure in the error message, wrong verdict |
| B3 | number token spanned a sentence boundary: `"2024. 32"` | produced the claim `"2024. 32 workflows"` |
| B4 | parenthetical breakdown `"(Playwright 461 + …)"` not extracted | a real figure reported as unsupported |
| B5 | bare claim vs qualified source treated as incomparable | `"580 tools"` unsupported against `"580+ MCP tools"` |

B1 is the one that matters. A gate that rejects the truth doesn't just fail
once — it trains whoever runs it to override it.

## What it does not do

- It does not judge **tone or negotiating posture**. It passed a cover letter
  that quoted the employer's own salary band back and pre-agreed to it. Numbers
  are checkable; judgement isn't.
- It does not know when the **source itself is stale**. If your profile says
  3,541 tests and the repo has 4,664, the gate happily verifies 3,541.
  Under-claiming is invisible to every rule here. Keep the source current.
- It does not verify a claim the source is **silent** on. `"Served 50k users"`
  against a source that never counts users is *unsupported*, not fabricated.
  It's surfaced for a human. That's the honest answer.
- It is not a general NLI model. It is a set of rules for the specific,
  common, expensive failure of a model restating your numbers wrong.

## Extending

```js
import { createExtractor } from 'fact-gate';

// Add domain nouns and synonyms
const ex = createExtractor({ nouns: ['sku', 'skus', 'orders'], synonyms: { sku: 'skus' } });
verifyFacts(text, { source, nouns: ['skus', 'orders'] });
```

Tests: `npm test` (39, `node:test`, no framework). Evals: `npm run eval`.
Both run in CI on Node 20/22/24, Linux and Windows.

## Provenance

The claim-shape regular expressions and the "widen the modifier window, bind
lazily" extraction rules are derived from
[career-ops](https://github.com/career-ops-hq/career-ops) (MIT, © 2026 Santiago
Fernández de Valderrama). The three-way classification, the asymmetric
comparison rules, floor checking, breakdown/sub-count/noun-first/range
extraction, structured facts, allow-list auditing, the CLI, the eval harness and
the tests are original to this project. See [NOTICE](NOTICE).

## License

MIT — see [LICENSE](LICENSE).

# Changelog

## Unreleased

- `factsFromDiff`: a changed test file whose runner syntax is not recognised no
  longer asserts `tests added: 0`. Found by the contrib bot on career-ops, whose
  tests are bare blocks calling `pass()` — "two new tests" was blocked as a lie.

## 1.2.0 — 2026-09-23

Where it runs, part two: git and the PR conversation. Chosen after a second
round of adversarial review of the roadmap, which dropped an MCP server and
a browser playground (no evidence either channel produces users for a CI
tool) in favour of the two things every team already has.

### Added

- **`fact-gate pre-commit`.** Checks the *staged* content (`git show :path`)
  of every file the nearest `.fact-gate.json` covers, refuses the commit on
  a contradiction. Editor-agnostic: Cursor, Codex, Copilot and humans go
  through the same gate. `.pre-commit-hooks.yaml` for the pre-commit
  framework; husky and lefthook one-liners in the README. `checkStaged`,
  `stagedPaths`, `stagedContent` in the library.
- **Sticky PR comment.** `comment: 'true'` on the Action posts one comment
  with the report and keeps it updated on every push (`pull-requests: write`).
  The Action now records its exit code and fails in a final step, so the
  comment is posted even when the gate blocks.
- `fact-gate/core`: the browser-safe half of the library (no Node built-ins).

### Deferred, deliberately

MCP server, GitHub Pages playground, SARIF output, dedicated JUnit / lcov /
git-log adapters. The `cmd` measurement already covers any artefact a shell
can read; the rest will be built when a user asks.

## 1.1.0 — 2026-09-22

The gate moves from "run it by hand on a CV" to "it runs where the text is
written". Same engine, three new places it fires, and three new kinds of
truth it can check against.

### Added

- **A diff is a source of truth.** `--diff <file>` / `--git <base>` /
  `verifyFacts(text, { diff })` turn a unified diff (or `git diff --numstat`)
  into facts: files by status, lines by direction, test cases added,
  dependencies added or removed (npm, pip, go.mod, Cargo). A PR description
  is verified against the change it describes. `parseDiff`, `factsFromDiff`.
- **Measured facts.** Any value in a facts file may be `{"cmd"|"file"|"json",
  "pattern"}` and is resolved at check time, so the README is checked against
  the test suite's own output, not against a number someone typed last month.
  `fact-gate measure`, `resolveFacts`, `measure`. A measurement that fails is
  an error, never a silent skip.
- **GitHub Action.** `uses: AnonZ7/fact-gate@v1` checks the PR body against
  the PR diff (default) or any file against facts/source; annotations, a
  step summary with the measured facts, and `verdict` / `report` outputs.
- **Claude Code hook.** `fact-gate hook` as a PreToolUse hook on Write / Edit
  / MultiEdit denies a save whose numbers contradict `.fact-gate.json` and
  hands the reasons back to the agent. `fact-gate init` scaffolds the config
  and prints the settings snippet. Inert when no config is found; never
  breaks a session.
- **Extraction:** verbs qualify a count (`adds 4 tests` → tests/added);
  participles after the noun (`6 lines deleted`); floors from words (`over
  4,000`, `more than 30`, `at least 5`); approximate claims (`roughly 500`,
  `about 5k`, `~85`) judged with a 10% tolerance; spelled-out small counts
  (`two new files`) and `no` in a change context (`no new dependencies` = 0
  added); colon breakdowns (`6 files: 2 new, 1 deleted, 3 modified`);
  qualified noun-first forms (`hook files: 27`); singular nouns (`1
  dependency`); a code-change vocabulary (files, insertions, deletions,
  dependencies, packages, functions, …).
- **Comparison:** a qualified claim is judged by the source entries that share
  its qualifier before the generous number-only match applies, so `no new
  dependencies` meets `dependencies added: 1` and loses instead of meeting
  `dependencies deleted: 0` and winning. Contradiction messages name the
  best-matching figure with its qualifiers.
- **Output:** `--format markdown` (table for PR comments), `--format github`
  (annotations + `$GITHUB_STEP_SUMMARY` + `$GITHUB_OUTPUT`), colour on a TTY,
  `--target-env`, `--no-measure`, `--no-color`.
- **Evals:** three suites (CV vs profile, PR body vs diff, docs vs facts)
  with per-suite precision and recall, so a weak domain cannot hide in the
  average. `evals/run.mjs --json`.
- JSON Schema for `.fact-gate.json`; `mergeFacts`; TypeScript declarations
  for everything above.
- The repository gates its own README with itself
  (`.github/workflows/fact-gate.yml`, `.fact-gate.json`).
- **Trust model for command measurements.** In hook mode a config's `cmd`
  measurements run only after `fact-gate trust <config>` has recorded the
  file's hash in `~/.fact-gate/trusted.json` (or with `FACT_GATE_ALLOW_CMD=1`
  in CI). Until then literal, `file` and `json` facts still gate, and the
  agent is told why the command was skipped. Editing the config revokes trust.
- Negated counts (`does not touch 12 files`, `doesn't add 40 tests`,
  `without adding 300 lines`) are not claims of that count.
- Fullwidth and Arabic-Indic digits normalise to ASCII before extraction.
- Unknown `--flags` are a usage error (exit 2) instead of being ignored.

### Fixed

- **Hook ordering (pre-release review, critical):** the include/exclude filter
  now runs before anything in the config is loaded, so a write to a file the
  config does not cover runs nothing from the config. Pinned by
  `test/security.test.mjs`.
- A heading on the line above a `Tests: 999` claim was captured as a
  qualifier, turning a fabrication into a warning. Noun-first qualifiers must
  now sit on the same line; line breaks survive normalisation.
- An `Edit` whose `old_string` is absent from the file is skipped instead of
  being judged against the unmodified file.
- A currency amount followed by a noun (`$90,000 deal`) was also read as a
  count once singular nouns entered the vocabulary. Counts now refuse a
  currency prefix.
- `total` / `overall` / `combined` are vacuous qualifiers and no longer make
  `total tests: 900` incomparable with `tests: 846`.

### Changed

- `contradicts()` is kept; `contradictions()` returns the ranked entries the
  messages are built from.

## 1.0.0 — 2026-09-22

First public release. Extracted from a private CV-tailoring pipeline where it
had gated ~20 generated application packs over three weeks, then audited
against a week of production failures and rebuilt.

### Fixed (regressions from production, each with a dated test)

- **B1** — a trailing sub-count (`"85 workflows built, 32 in daily production"`)
  was not extracted from the source, so a *true* claim of 32 was **blocked as
  fabricated**. Sub-counts introduced by `in / of which / for / on / across /
  with` after a count now inherit the parent noun and qualifiers.
- **B2** — a lower-bound claim (`"30+ n8n workflows"`) was judged against the
  *smallest* comparable source figure and the error message named that figure.
  Comparable entries are now ranked by shared qualifiers; the best match is
  used for the verdict and named in the message.
- **B3** — the number token allowed `.` and space inside a number, so
  `"since 2024. 32 workflows"` produced the claim `"2024. 32 workflows"`.
  Grouping separators are now accepted only when followed by exactly three
  digits.
- **B4** — a parenthetical breakdown (`"846 tests (Playwright 461 + Flutter
  242)"`) was not extracted, so `"461 Playwright tests"` reported as
  unsupported. Breakdowns after a count now yield one claim per label, with
  the parent noun.
- **B5** — a bare claim (`"580 tools"`) against a qualified source figure
  (`"580+ MCP tools"`) was treated as incomparable and reported unsupported.
  Verification now ignores qualifiers when the number matches; contradiction
  remains strict.

### Added

- Structured `facts` input, range extraction, noun-first extraction,
  allow-list audit (`result.allowlist.{used, unused}`), configurable nouns,
  `jd` reference-echo downgrade, CLI with exit codes 0/1/2, eval harness,
  TypeScript declarations, CI on Node 20/22/24 × Linux/Windows.

### Provenance

Claim-shape regexes and the "widen the modifier window, bind lazily" rules
derive from career-ops v1.31.0 (MIT). See NOTICE.

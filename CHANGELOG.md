# Changelog

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

- Structured `facts` input (`counts`, `years`, `percentages`, `amounts`,
  `multipliers`, `employers`, `titles`, `tools`, `experience_start`) — usable
  alone or alongside prose.
- Range extraction: both ends of `4-5 hours`, `$3K–$4.5K`, `40-60%`.
- Noun-first extraction: `tests: 846`, `Tools — 585`.
- Allow-list audit: `result.allowlist.{used, unused}` and an
  `ALLOWLIST_UNUSED` note in the report, so an override that no longer rescues
  anything is visible. (Motivated by a real whitelist that had been added to
  push a false timezone claim past the gate.)
- Configurable noun vocabulary and synonyms via `createExtractor` / `nouns`.
- Tenure checks accept `facts.experience_start` as well as prose date ranges.
- `--jd` / `jd` reference-text echo downgrade, now documented as general
  (any text the model was shown), not CV-specific.
- CLI (`fact-gate`) with `--json`, `--strict`, `--quiet`, stdin input, and
  exit codes 0/1/2.
- Eval harness (`npm run eval`): 33 cases, precision/recall on the block
  decision, fails CI on regression.
- TypeScript declarations (`index.d.ts`).
- CI on Node 20/22/24, Linux + Windows.

### Changed

- `sourceText` → `source`, `jdText` → `jd` (old names still accepted).
- `formatFactFailures` → `formatReport` (alias kept).
- Messages say "source", not "profile".
- Amount claims normalise to `$N` regardless of the original currency symbol
  (`€`, `£` still extract).

### Provenance

Claim-shape regexes and the "widen the modifier window, bind lazily" rules
derive from career-ops v1.31.0 (MIT). See NOTICE.

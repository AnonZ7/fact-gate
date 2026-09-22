// Claim extraction — regex and rule based, zero LLM calls.
//
// A "claim" is any span of generated text that asserts something a source of
// truth could confirm or deny: a count ("85 workflows"), an anchorless figure
// ("40%", "$90k", "3x"), a year, a spelled-out tenure ("six years"), or a
// hard self-claim (employer, title, tool).
//
// Extraction runs on BOTH sides — the generated text and the source of truth —
// with identical rules, so a figure the source states in one shape and the
// model restates in another still meets in the middle. Every rule here is
// therefore judged on one question: does it extract the same claim from both
// phrasings? A rule that reads "846 tests" but not "tests: 846" lets an
// inflated number through with nothing to compare against.

import { stripMarkup, normalizeNumber, normalizeModifiers } from './normalize.mjs';

/** Nouns a number can legitimately count. Extend per domain via `nouns`. */
export const DEFAULT_NOUNS = [
  'users', 'customers', 'clients', 'employees', 'engineers', 'teams', 'companies',
  'partners', 'organizations', 'organisations', 'brands', 'countries', 'attendees',
  'hours', 'days', 'weeks', 'months', 'years', 'minutes', 'seconds',
  'requests', 'tokens', 'documents', 'workflows', 'pipelines', 'agents', 'sub-agents',
  'applications', 'reports', 'sessions', 'responses', 'leads', 'deals', 'contacts',
  'calls', 'records', 'commits', 'repositories', 'repos', 'modules', 'tools',
  'servers', 'skills', 'hooks', 'guides', 'articles', 'datasets', 'deployments',
  'services', 'downloads', 'lines', 'projects', 'integrations', 'tests', 'nodes',
  'products', 'categories', 'migrations', 'pages', 'roles', 'endpoints', 'tables',
  'staff', 'people', 'contractors', 'vendors', 'students', 'sites', 'apps',
  'stores', 'orders', 'transactions', 'invoices', 'tickets', 'incidents', 'events',
  'models', 'prompts', 'evals', 'runs', 'jobs', 'queues', 'webhooks', 'schemas',
  // Code-change vocabulary: PR descriptions, changelogs, release notes.
  'files', 'insertions', 'deletions', 'additions', 'changes', 'dependencies',
  'packages', 'functions', 'methods', 'classes', 'components', 'directories',
  'folders', 'branches', 'releases', 'versions', 'issues', 'bugs', 'fixes',
  'features', 'warnings', 'errors', 'vulnerabilities', 'cases', 'assertions',
  'benchmarks', 'rules', 'detectors', 'languages', 'platforms', 'regressions',
  'defects', 'suites', 'claims', 'measurements', 'checks', 'verdicts',
];

/** Different words for the same thing: a restatement, not a fabrication. */
export const DEFAULT_SYNONYMS = {
  repos: 'repositories',
  organisations: 'organizations',
  'sub-agents': 'agents',
};

/**
 * A verb right before a count is a qualifier: "adds 4 tests" is a claim about
 * tests ADDED, and must be judged against "tests added: 4", not against the
 * size of the whole suite. Folded through MODIFIER_SYNONYMS afterwards.
 */
const VERB_MODIFIERS = {
  add: 'added', adds: 'added', added: 'added', adding: 'added',
  introduce: 'added', introduces: 'added', create: 'added', creates: 'added',
  remove: 'deleted', removes: 'deleted', removed: 'deleted', removing: 'deleted',
  delete: 'deleted', deletes: 'deleted', deleted: 'deleted', drop: 'deleted', drops: 'deleted', dropped: 'deleted',
  modify: 'modified', modifies: 'modified', modified: 'modified',
  update: 'modified', updates: 'modified', updated: 'modified',
  change: 'changed', changes: 'changed', changed: 'changed', touch: 'changed', touches: 'changed', touched: 'changed',
  rename: 'renamed', renames: 'renamed', renamed: 'renamed',
};
const CHANGE_MODIFIERS = new Set(['added', 'deleted', 'modified', 'changed', 'renamed', 'breaking']);
// "6 lines deleted", "3 files changed": a participle right after the noun qualifies it.
const POST_NOUN_RE = /^\s+(added|deleted|removed|changed|modified|touched|created|renamed|inserted|updated|affected)\b/i;
// "over 4,000 tests", "more than 30 workflows", "at least 5 tools" — a floor, like "N+".
const FLOOR_LOOKBACK_RE = /\b(?:over|above|more than|at least|exceeds|exceeding|upwards of|no fewer than|>=?)\s*$/i;
// "roughly 500 skills", "about 5k tests", "~85 workflows" — approximate, judged with a tolerance.
// "does not touch 12 files", "without adding any tests", "never 500 users":
// a negated count is not a claim of that count. Dropped, not compared.
const NEGATION_LOOKBACK_RE = /(?:\b(?:not|never|without|neither|nor|no longer)|n't)\b(?:\s+\w+){0,3}\s*$/i;
const APPROX_LOOKBACK_RE = /(?:\b(?:about|around|roughly|approximately|approx\.?|nearly|almost|close to|some|circa|c\.)\s*|[~≈])$/i;
const VERB_LOOKBACK = /([A-Za-z]+)\s+(?:(?:a|an|the|some|another|about|around|roughly|over|only|just|and)\s+){0,2}$/;

/** Words that carry no meaning as a qualifier ("32 in daily production"). */
const MODIFIER_STOPWORDS = new Set(['in', 'of', 'on', 'for', 'at', 'the', 'a', 'an', 'across', 'which', 'are', 'is', 'total', 'overall', 'combined', 'currently', 'now']);

// Number token. Grouped thousands FIRST (each group exactly 3 digits), then a
// plain integer/decimal. This is what keeps "2024. 32" apart: after "2024" the
// next char is "." followed by a space, not three digits, so the grouped
// branch fails and the plain branch stops at the boundary.
const NUM = String.raw`(?:\d{1,3}(?:[,.\s  ]\d{3})+|\d+(?:[.,]\d+)?)`;
const MAG = String.raw`(?:\s?[kKmMbB]\b)?`;
// A number may not start inside a token ("n8n" must not yield an 8) and a
// currency amount is not a count ("$90,000 deal" is an amount, not 90,000 deals).
const NOT_IN_TOKEN = String.raw`(?<![A-Za-z0-9$€£,.])`;
// A qualifier starts with a letter and may contain digits ("n8n", "gpt-4").
const QUALIFIER = String.raw`[A-Za-z][A-Za-z0-9-]*`;

const SPELLED_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const SPELLED_YEARS_RE = new RegExp(String.raw`\b(${Object.keys(SPELLED_NUMBERS).join('|')})\b[\s-]+(?:years?|yrs?)\b`, 'gi');
const SPELLED_DECADE_RE = /\ba decade\b/gi;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

const ANCHORLESS = [
  { kind: 'percentage', re: new RegExp(String.raw`${NOT_IN_TOKEN}(${NUM})\s?%`, 'g') },
  { kind: 'amount', re: new RegExp(String.raw`(?<![\w$€£])[$€£]\s?(${NUM}${MAG})`, 'g') },
  { kind: 'multiplier', re: new RegExp(String.raw`${NOT_IN_TOKEN}(${NUM})\s?x\b`, 'gi') },
];
// Ranges: both ends are claims. "40-60%" is a 40% and a 60%; "$3K–$4.5K" is
// two amounts; "4-5 hours" is a 4 and a 5 (the second end also matches the
// plain count rule and is de-duplicated).
const RANGE_PCT_RE = new RegExp(String.raw`${NOT_IN_TOKEN}(${NUM})\s*[-–—]\s*(${NUM})\s?%`, 'g');
const RANGE_AMT_RE = new RegExp(String.raw`(?<![\w$€£])[$€£]\s?(${NUM}${MAG})\s*[-–—]\s*[$€£]?\s?(${NUM}${MAG})`, 'g');

// Hard self-claims. Trigger case-insensitive (bullets are capitalised); the
// capture is not, because it leans on an initial capital to spot a proper noun.
const FACT_PATTERNS = [
  ['employer', /\b(?:[Ww]orked (?:at|for)|[Jj]oined|[Ee]mployed by|[Ee]mployer\s*:\s*|[Cc]ompany\s*:\s*)\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/g],
  ['title', /\b(?:[Ss]erved [Aa]s|[Ww]orked [Aa]s|[Tt]itle\s*:\s*|[Rr]ole\s*:\s*|[Pp]romoted to)\s*(?:an?\s+|the\s+)?([A-Z][\w/-]*(?:\s+(?:of|for|and|the)\s+[A-Z][\w/-]*|\s+[A-Z][\w/-]*){0,4})/g],
  ['tool', /\b(?:using|built with|worked with|technologies?\s*:\s*|tech stack\s*:\s*)([^.;\n]+?)(?=\s+\bfor\b|[.;\n]|$)/gi],
];
const TOOL_PROSE_WORDS = new Set([
  'a', 'an', 'and', 'at', 'both', 'built', 'by', 'for', 'from', 'in', 'of', 'on',
  'or', 'production', 'project', 'team', 'the', 'to', 'using', 'with', 'their',
  'our', 'my', 'its', 'this', 'that', 'these', 'those', 'it',
]);
const TOOL_PHRASE_RE = /^(?=.{1,60}$)[\p{L}\p{N}.][\p{L}\p{N}+#./-]*(?:\s+[\p{L}\p{N}.][\p{L}\p{N}+#./-]*){0,2}$/u;

/**
 * Build an extractor bound to a noun vocabulary.
 *
 * @param {object} [options]
 * @param {string[]} [options.nouns]        extra countable nouns (merged with defaults)
 * @param {Record<string,string>} [options.synonyms]  noun -> canonical noun
 * @param {number} [options.modifierWindow] words allowed between number and noun (default 4)
 */
function singularOf(plural) {
  if (/(?:ss|us|is)$/.test(plural) || plural.length < 4) return null;
  if (/ies$/.test(plural)) return plural.slice(0, -3) + 'y';
  if (/(?:ches|shes|xes|sses)$/.test(plural)) return plural.slice(0, -2);
  if (/s$/.test(plural)) return plural.slice(0, -1);
  return null;
}
const NO_SINGULAR = new Set(['staff', 'people', 'evals', 'sub-agents', 'series', 'news']);

export function createExtractor({ nouns = [], synonyms = {}, modifierWindow = 4 } = {}) {
  const plural = [...new Set([...DEFAULT_NOUNS, ...nouns.map(n => String(n).toLowerCase())])];
  // "1 dependency", "1 file deleted": the singular is a restatement of the plural noun.
  const SYN = { ...DEFAULT_SYNONYMS };
  for (const n of plural) {
    const sg = NO_SINGULAR.has(n) ? null : singularOf(n);
    if (sg && !plural.includes(sg) && !(sg in SYN)) SYN[sg] = DEFAULT_SYNONYMS[n] ?? n;
  }
  Object.assign(SYN, synonyms);
  const NOUNS = [...new Set([...plural, ...Object.keys(SYN)])].sort((a, b) => b.length - a.length);
  const nounSet = new Set(NOUNS);
  const NOUN = `(${NOUNS.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
  const canon = (n) => { const l = String(n).toLowerCase(); return SYN[l] ?? l; };

  // "85 n8n workflows", "500+ tools", "15+ years scaling teams" (binds to
  // the NEAREST noun — the window is lazy).
  const COUNT_RE = new RegExp(
    String.raw`${NOT_IN_TOKEN}(${NUM}${MAG})\s*(\+)?\s*((?:${QUALIFIER}\s+){0,${modifierWindow}}?)${NOUN}\b`, 'gi');
  // "4-5 hours", "3 to 5 engineers"
  const COUNT_RANGE_RE = new RegExp(
    String.raw`${NOT_IN_TOKEN}(${NUM}${MAG})\s*(?:[-–—]|to)\s*(${NUM}${MAG})\s*((?:${QUALIFIER}\s+){0,${modifierWindow}}?)${NOUN}\b`, 'gi');
  // "tests: 846", "Tests — 846" (noun first, then the number)
  const NOUN_FIRST_RE = new RegExp(
    String.raw`(?<![\w-])((?:${QUALIFIER}[ \t]+){0,2}?)${NOUN}[ \t]*[:=—–-][ \t]*(${NUM}${MAG})(?![\d.,]*[%x])`, 'gi');
  // After a count: a parenthetical breakdown "(Playwright 461 + Flutter 242)"
  const BREAKDOWN_RE = /^\s*\(([^()]{1,200})\)/;
  // After a count: a colon breakdown "6 files: 2 new, 1 deleted, 3 modified"
  const COLON_BREAKDOWN_RE = new RegExp(String.raw`^\s*:\s*((?:${NUM}\s+${QUALIFIER}(?:\s*,\s*(?:and\s+)?|\s+and\s+|(?=\s*$)|(?=\s*[.;:)\-–—•|])))+)`, 'i');
  // Spelled-out small counts, and "no" in a change context ("no new dependencies" = 0 added).
  const SPELLED_COUNT_RE = new RegExp(
    String.raw`\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|no)\s+((?:${QUALIFIER}\s+){0,${modifierWindow}}?)${NOUN}\b`, 'gi');
  const PAIR_LABEL_NUM = new RegExp(String.raw`(${QUALIFIER})\s+(${NUM}${MAG})`, 'g');
  const PAIR_NUM_LABEL = new RegExp(String.raw`${NOT_IN_TOKEN}(${NUM}${MAG})\s+(${QUALIFIER})`, 'g');
  // After a count: a trailing sub-count "..., 32 in daily production"
  const SUBCOUNT_RE = new RegExp(
    String.raw`^(?:\s+${QUALIFIER}){0,3}\s*[,;(]\s*(${NUM}${MAG})\s+(?:in|of which(?: are)?|for|on|across|with)\s+([A-Za-z][^,.;()]{0,60})`, 'i');

  function pushUnique(out, seen, rec) {
    const key = `${rec.kind}|${rec.claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rec);
  }

  function countRecord(number, noun, modifiers, extra = {}) {
    const isLowerBound = Boolean(extra.isLowerBound);
    return {
      kind: 'count', noun, number, modifiers,
      isLowerBound,
      claim: `${number}${isLowerBound ? '+' : ''} ${noun}`,
      ...extra,
    };
  }

  /** Qualifiers implied by the words around a count: verb before, participle after, floor/approx markers. */
  function contextOf(clean, start, end, modifiers) {
    const before = clean.slice(Math.max(0, start - 48), start);
    const after = clean.slice(end);
    const verb = VERB_LOOKBACK.exec(before);
    const verbMod = verb && VERB_MODIFIERS[verb[1].toLowerCase()];
    if (verbMod && !modifiers.includes(verbMod)) modifiers.unshift(verbMod);
    const post = POST_NOUN_RE.exec(after);
    if (post) { const pm = normalizeModifiers([post[1]])[0]; if (!modifiers.includes(pm)) modifiers.push(pm); }
    return { isLowerBound: FLOOR_LOOKBACK_RE.test(before), approximate: APPROX_LOOKBACK_RE.test(before), negated: NEGATION_LOOKBACK_RE.test(before) };
  }

  /**
   * Every numeric claim in `text`.
   * @param {string} text
   * @returns {Array<object>}
   */
  function numericClaims(text) {
    const clean = stripMarkup(text);
    const out = [];
    const seen = new Set();

    for (const { kind, re } of ANCHORLESS) {
      re.lastIndex = 0;
      for (const m of clean.matchAll(re)) {
        const number = normalizeNumber(m[1]);
        const claim = kind === 'percentage' ? `${number}%` : kind === 'amount' ? `$${number}` : `${number}x`;
        pushUnique(out, seen, { kind, noun: null, number, claim });
      }
    }
    RANGE_PCT_RE.lastIndex = 0;
    for (const m of clean.matchAll(RANGE_PCT_RE)) {
      for (const raw of [m[1], m[2]]) {
        const number = normalizeNumber(raw);
        pushUnique(out, seen, { kind: 'percentage', noun: null, number, claim: `${number}%`, range: true });
      }
    }
    RANGE_AMT_RE.lastIndex = 0;
    for (const m of clean.matchAll(RANGE_AMT_RE)) {
      for (const raw of [m[1], m[2]]) {
        const number = normalizeNumber(raw);
        pushUnique(out, seen, { kind: 'amount', noun: null, number, claim: `$${number}`, range: true });
      }
    }

    YEAR_RE.lastIndex = 0;
    for (const m of clean.matchAll(YEAR_RE)) {
      pushUnique(out, seen, { kind: 'year', noun: null, number: m[1], claim: m[1] });
    }

    const isYear = (n) => /^(19|20)\d{2}$/.test(n);

    COUNT_RANGE_RE.lastIndex = 0;
    for (const m of clean.matchAll(COUNT_RANGE_RE)) {
      const noun = canon(m[4]);
      const modifiers = normalizeModifiers((m[3] || '').trim().split(/\s+/));
      for (const raw of [m[1], m[2]]) {
        const number = normalizeNumber(raw);
        if (isYear(number)) continue;
        pushUnique(out, seen, countRecord(number, noun, modifiers, { range: true }));
      }
    }

    COUNT_RE.lastIndex = 0;
    for (const m of clean.matchAll(COUNT_RE)) {
      const number = normalizeNumber(m[1]);
      // "2024 workflows" is a date next to a plural, not a count of 2024 things.
      if (isYear(number)) continue;
      const noun = canon(m[4]);
      const modifiers = normalizeModifiers((m[3] || '').trim().split(/\s+/));
      const ctx = contextOf(clean, m.index, m.index + m[0].length, modifiers);
      if (ctx.negated) continue;
      pushUnique(out, seen, countRecord(number, noun, modifiers, { isLowerBound: Boolean(m[2]) || ctx.isLowerBound, approximate: ctx.approximate }));

      const rest = clean.slice(m.index + m[0].length);

      // "846 tests (Playwright 461 + Flutter 242 + Vitest 61 + Jest 82)"
      const bd = BREAKDOWN_RE.exec(rest);
      if (bd) {
        const inner = bd[1];
        const pairs = [];
        PAIR_LABEL_NUM.lastIndex = 0;
        for (const p of inner.matchAll(PAIR_LABEL_NUM)) pairs.push([p[1], p[2]]);
        PAIR_NUM_LABEL.lastIndex = 0;
        for (const p of inner.matchAll(PAIR_NUM_LABEL)) pairs.push([p[2], p[1]]);
        for (const [label, raw] of pairs) {
          const n = normalizeNumber(raw);
          if (isYear(n) || nounSet.has(label.toLowerCase())) continue;
          pushUnique(out, seen, countRecord(n, noun, normalizeModifiers([...modifiers, label]), { derivedFrom: 'breakdown' }));
        }
      }

      // "6 files: 2 new, 1 deleted, 3 modified"
      const cb = COLON_BREAKDOWN_RE.exec(rest);
      if (cb) {
        PAIR_NUM_LABEL.lastIndex = 0;
        for (const p of cb[1].matchAll(PAIR_NUM_LABEL)) {
          const n = normalizeNumber(p[1]);
          if (isYear(n) || nounSet.has(p[2].toLowerCase())) continue;
          pushUnique(out, seen, countRecord(n, noun, normalizeModifiers([...modifiers.filter(w => w !== 'changed'), p[2]]), { derivedFrom: 'breakdown' }));
        }
      }

      // "85 n8n workflows built, 32 in daily production"
      const sc = SUBCOUNT_RE.exec(rest);
      if (sc) {
        const n = normalizeNumber(sc[1]);
        if (!isYear(n)) {
          const words = normalizeModifiers(sc[2].trim().split(/\s+/)).filter(w => !MODIFIER_STOPWORDS.has(w));
          pushUnique(out, seen, countRecord(n, noun, normalizeModifiers([...modifiers, ...words]), { derivedFrom: 'subcount' }));
        }
      }
    }

    SPELLED_COUNT_RE.lastIndex = 0;
    for (const m of clean.matchAll(SPELLED_COUNT_RE)) {
      const word = m[1].toLowerCase();
      const spelledNoun = canon(m[3]);
      if (spelledNoun === 'years') continue; // "six years" is tenure, handled below
      const modifiers = normalizeModifiers((m[2] || '').trim().split(/\s+/));
      if (modifiers.some(w => MODIFIER_STOPWORDS.has(w))) continue;
      if (contextOf(clean, m.index, m.index + m[0].length, modifiers).negated) continue;
      // "no" is a count only in a change context: "no new dependencies", "removed no tests".
      if (word === 'no' && !modifiers.some(w => CHANGE_MODIFIERS.has(w))) continue;
      const number = word === 'no' ? '0' : String(SPELLED_NUMBERS[word] ?? (word === 'zero' ? 0 : NaN));
      if (number === 'NaN') continue;
      pushUnique(out, seen, countRecord(number, spelledNoun, modifiers, { derivedFrom: 'spelled' }));
    }

    NOUN_FIRST_RE.lastIndex = 0;
    for (const m of clean.matchAll(NOUN_FIRST_RE)) {
      const number = normalizeNumber(m[3]);
      if (isYear(number)) continue;
      const modifiers = normalizeModifiers((m[1] || '').trim().split(/\s+/)).filter(w => !MODIFIER_STOPWORDS.has(w));
      pushUnique(out, seen, countRecord(number, canon(m[2]), modifiers, { derivedFrom: 'noun-first' }));
    }

    SPELLED_YEARS_RE.lastIndex = 0;
    for (const m of clean.matchAll(SPELLED_YEARS_RE)) {
      const word = m[1].toLowerCase();
      pushUnique(out, seen, { kind: 'spelled_years', noun: 'years', number: SPELLED_NUMBERS[word], claim: `${word} years` });
    }
    SPELLED_DECADE_RE.lastIndex = 0;
    for (const _ of clean.matchAll(SPELLED_DECADE_RE)) {
      pushUnique(out, seen, { kind: 'spelled_years', noun: 'years', number: 10, claim: 'a decade' });
    }
    return out;
  }

  function isLikelyTool(value) {
    const normalized = String(value).toLowerCase().trim();
    const words = normalized.split(/\s+/);
    if (!normalized || words.length > 3) return false;
    if (words.some(w => TOOL_PROSE_WORDS.has(w))) return false;
    return TOOL_PHRASE_RE.test(String(value).trim());
  }

  /**
   * Explicitly asserted employer, title and tool claims.
   * @param {string} text
   * @returns {Array<{kind: string, value: string}>}
   */
  function factClaims(text) {
    const clean = stripMarkup(text);
    const out = [];
    const seen = new Set();
    for (const [kind, pattern] of FACT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of clean.matchAll(pattern)) {
        const captured = m[1] || '';
        const rawValues = kind === 'tool'
          ? (/^the\s+/i.test(captured.trim()) ? [] : captured.split(/,|\band\b|\bwith\b|\bin\b/i))
          : [captured];
        for (const raw of rawValues) {
          if (kind === 'tool' && !isLikelyTool(raw)) continue;
          const value = String(raw).toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,]+$/g, '').trim();
          const key = `${kind}|${value}`;
          if (!value || seen.has(key)) continue;
          seen.add(key);
          out.push({ kind, value });
        }
      }
    }
    return out;
  }

  return { numericClaims, factClaims, nouns: NOUNS, canon };
}

const DEFAULT = createExtractor();
/** Numeric claims with the default vocabulary. */
export const numericClaims = (text) => DEFAULT.numericClaims(text);
/** Fact claims with the default vocabulary. */
export const factClaims = (text) => DEFAULT.factClaims(text);

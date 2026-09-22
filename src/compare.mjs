// Comparison rules — how a claim from generated text is checked against the
// indexed source of truth.
//
// Three questions are asked, in this order, and they are deliberately NOT
// symmetric:
//
//   1. VERIFICATION  Does the source state this exact number for this noun?
//      Qualifiers are ignored here. "580 tools" is confirmed by "580+ MCP
//      tools": a matching number is evidence, and extra words around it are
//      not a contradiction. (Version 1 treated a bare claim and a qualified
//      source as incomparable and reported a true figure as unsupported —
//      see test/regressions.test.mjs, B5.)
//
//   2. LOWER BOUND   "500+ tools" is a floor, not an equality. It holds when
//      the source figure is >= 500 and 500 is not an absurd understatement
//      (>= 50% of the real figure).
//
//   3. CONTRADICTION Does the source state a DIFFERENT number for the SAME
//      subject? Here qualifiers matter, and the rule is strict: two claims
//      are the same subject only when their qualifiers overlap, or neither
//      side has any. "2 custom automation tools" and "575 MCP tools" share a
//      plural and nothing else; blocking that pair rejected a truthful CV on
//      the gate's first real run.
//
// Asymmetry is the point. Being generous about what counts as confirmation
// and strict about what counts as contradiction can only ever produce FEWER
// false blocks — an unmatched claim still surfaces as "unsupported" and is
// never silently dropped.

import { stripMarkup, normalizeNumber, normalizeClaim, normalizeModifiers } from './normalize.mjs';
import { createExtractor } from './extract.mjs';

const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// The START half of "Mon YYYY – Mon YYYY" / "Mon YYYY – Present".
const DATE_RANGE_START_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\s*[–—-]/gi;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})(?:-\d{2})?$/;
const STOP = new Set(['in', 'of', 'on', 'for', 'at', 'the', 'a', 'an', 'across', 'which', 'are', 'is', 'with']);

/** Whole-token containment tolerant of whitespace differences. */
export function containsPhrase(haystack, value) {
  const escaped = String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#/-])${escaped}(?=$|[^\\p{L}\\p{N}+#/-])`, 'iu').test(haystack);
}

function overlap(a, b) {
  let n = 0;
  for (const m of a) if (b.has(m)) n++;
  return n;
}

/**
 * Turn a structured `facts` object into the same claim records the text
 * extractor produces, so prose and structure index identically.
 *
 * facts = {
 *   counts:      { 'tests': 4664, 'n8n workflows': 85, 'n8n workflows daily production': 32 },
 *   years:       [2019, 2022],
 *   percentages: ['40%'], amounts: ['$90,000'], multipliers: ['3x'],
 *   employers:   ['Acme Robotics'], titles: ['Lead Engineer'], tools: ['n8n'],
 *   experience_start: '2019-10'
 * }
 * A counts key is "<qualifiers> <noun>": the LAST word is the noun.
 */
export function claimsFromFacts(facts, extractor) {
  const out = [];
  if (!facts || typeof facts !== 'object') return out;
  const counts = facts.counts || {};
  for (const [key, value] of Object.entries(counts)) {
    const words = String(key).toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    // The noun is the LAST word that is in the vocabulary ("n8n workflows daily
    // production" → workflows); everything else is a qualifier. Falls back to
    // the last word so an unknown noun still indexes.
    const nounSet = new Set(extractor.nouns);
    let nounIdx = words.length - 1;
    for (let i = words.length - 1; i >= 0; i--) if (nounSet.has(words[i])) { nounIdx = i; break; }
    const noun = extractor.canon(words[nounIdx]);
    const modifiers = normalizeModifiers(words.filter((_, i) => i !== nounIdx)).filter(w => !STOP.has(w));
    const raw = String(value).trim();
    const isLowerBound = raw.endsWith('+');
    const number = normalizeNumber(raw.replace(/\+$/, ''));
    out.push({ kind: 'count', noun, number, modifiers, isLowerBound, claim: `${number}${isLowerBound ? '+' : ''} ${noun}`, derivedFrom: 'facts' });
  }
  for (const y of facts.years || []) out.push({ kind: 'year', noun: null, number: String(y), claim: String(y) });
  for (const p of facts.percentages || []) { const n = normalizeNumber(String(p).replace('%', '')); out.push({ kind: 'percentage', noun: null, number: n, claim: `${n}%` }); }
  for (const a of facts.amounts || []) { const n = normalizeNumber(String(a).replace(/^[$€£]\s?/, '')); out.push({ kind: 'amount', noun: null, number: n, claim: `$${n}` }); }
  for (const x of facts.multipliers || []) { const n = normalizeNumber(String(x).replace(/x$/i, '')); out.push({ kind: 'multiplier', noun: null, number: n, claim: `${n}x` }); }
  return out;
}

/**
 * Index a source of truth (prose, structured facts, or both) into the sets a
 * generated text is checked against.
 */
export function indexSource({ sourceText = '', facts = null, allowMetrics = [], extractor = createExtractor() } = {}) {
  const claims = [...extractor.numericClaims(sourceText), ...claimsFromFacts(facts, extractor)];
  const exact = new Set();
  const byNoun = new Map();
  const add = (c) => {
    exact.add(`${c.kind}|${c.claim}`);
    if (c.kind !== 'count') return;
    if (!byNoun.has(c.noun)) byNoun.set(c.noun, []);
    byNoun.get(c.noun).push({ number: c.number, modifiers: new Set(c.modifiers || []), isLowerBound: c.isLowerBound, origin: c.derivedFrom || 'text' });
  };
  for (const c of claims) add(c);

  // Whitelisted metrics are indexed like source claims, and remembered so the
  // caller can see which entries actually did any work.
  const allow = new Map();
  for (const entry of allowMetrics) {
    const keys = new Set();
    for (const c of extractor.numericClaims(String(entry))) { add(c); keys.add(`${c.kind}|${c.claim}`); }
    const norm = normalizeClaim(entry);
    for (const kind of ['percentage', 'amount', 'multiplier', 'count']) { exact.add(`${kind}|${norm}`); keys.add(`${kind}|${norm}`); }
    allow.set(String(entry), keys);
  }

  const plain = [stripMarkup(sourceText), ...(facts?.employers || []), ...(facts?.titles || []), ...(facts?.tools || [])].join(' \n ');
  return { exact, byNoun, plain, allow, facts };
}

/** Source states this exact number for this noun (qualifiers ignored). */
export function findVerification(source, claim) {
  const entries = source.byNoun.get(claim.noun);
  if (!entries) return null;
  const hit = entries.find(e => e.number === claim.number);
  return hit || null;
}

function comparableForContradiction(entry, targetMods) {
  const shared = overlap(targetMods, entry.modifiers) > 0;
  const bothBare = targetMods.size === 0 && entry.modifiers.size === 0;
  return shared || bothBare;
}

/**
 * Does the source state a DIFFERENT number for the SAME subject?
 * @returns {string[]|null} conflicting numbers, or null when no comparable evidence exists
 */
export function contradicts(source, claim) {
  const entries = source.byNoun.get(claim.noun);
  if (!entries) return null;
  const targetMods = new Set(claim.modifiers || []);
  const conflicting = entries
    .filter(e => comparableForContradiction(e, targetMods))
    .filter(e => e.number !== claim.number)
    .map(e => e.number);
  return conflicting.length ? [...new Set(conflicting)] : null;
}

/**
 * Check a "N+" floor against the source. Comparable entries: those sharing a
 * qualifier, those where both sides are bare, or ANY entry when the claim is
 * bare (a bare floor is the least specific claim there is). The entry with
 * the most shared qualifiers is preferred — and it is the one named in the
 * message, so "30+ n8n workflows" is judged against the n8n figure, not
 * against whichever comparable figure happens to be smallest (B2).
 *
 * @returns {{result: 'ok'|'exceeds'|'too-low'|'none', actual?: string, floor?: number}}
 */
export function lowerBoundCheck(source, claim, { floorRatio = 0.5 } = {}) {
  const entries = source.byNoun.get(claim.noun);
  if (!entries) return { result: 'none' };
  const targetMods = new Set(claim.modifiers || []);
  const comparable = entries
    .map(e => ({ e, shared: overlap(targetMods, e.modifiers) }))
    .filter(({ e, shared }) => shared > 0 || targetMods.size === 0 || (targetMods.size === 0 && e.modifiers.size === 0))
    .sort((a, b) => b.shared - a.shared);
  if (!comparable.length) return { result: 'none' };

  const n = Number(claim.number);
  for (const { e } of comparable) {
    const actual = Number(e.number);
    if (!Number.isFinite(actual) || !Number.isFinite(n)) continue;
    if (n <= actual && n >= actual * floorRatio) return { result: 'ok', actual: e.number };
  }
  const best = comparable[0].e;
  return { result: n > Number(best.number) ? 'exceeds' : 'too-low', actual: best.number, floor: floorRatio };
}

/** Earliest role-start date findable in the source (prose ranges or facts.experience_start). */
export function earliestExperienceStart(sourceText = '', facts = null) {
  let earliest = null;
  const consider = (d) => { if (d && (!earliest || d < earliest)) earliest = d; };
  const iso = facts?.experience_start && ISO_MONTH_RE.exec(String(facts.experience_start));
  if (iso) consider(new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, 1)));
  DATE_RANGE_START_RE.lastIndex = 0;
  for (const m of String(sourceText).matchAll(DATE_RANGE_START_RE)) {
    const month = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    const year = Number(m[2]);
    if (month == null || !Number.isFinite(year)) continue;
    consider(new Date(Date.UTC(year, month, 1)));
  }
  return earliest;
}

/** Real years of experience since the earliest role start, or null. */
export function experienceYears(sourceText = '', facts = null, now = Date.now()) {
  const start = earliestExperienceStart(sourceText, facts);
  if (!start) return null;
  return (now - start.getTime()) / (365.25 * 24 * 3600 * 1000);
}

// fact-gate — verify LLM-generated text against a source of truth.
//
// Every claim the generated text makes lands in one of three buckets:
//
//   verified     the source states it
//   unsupported  the source neither states nor contradicts it — reported,
//                never silently dropped, never blocking
//   fabricated   the source contradicts it, or it is a hard self-claim
//                (number, year, employer, title) with no evidence at all
//
// "fabricated" blocks. That is the whole point: a gate that never fails
// anything is not a gate.

import { stripMarkup, normalizeClaim } from './normalize.mjs';
import { createExtractor } from './extract.mjs';
import {
  indexSource, findVerification, contradicts, lowerBoundCheck, containsPhrase,
  earliestExperienceStart, experienceYears,
} from './compare.mjs';

export { stripMarkup, normalizeNumber, normalizeClaim } from './normalize.mjs';
export { createExtractor, numericClaims, factClaims, DEFAULT_NOUNS, DEFAULT_SYNONYMS } from './extract.mjs';
export { indexSource, claimsFromFacts, contradicts, lowerBoundCheck, findVerification, earliestExperienceStart, experienceYears } from './compare.mjs';

export const VERSION = '1.0.0';
const BLOCK = 'fabricated';

/**
 * Verify generated text against a source of truth.
 *
 * @param {string} target  the generated text (CV, cover letter, summary, report…)
 * @param {object} options
 * @param {string} [options.source]      canonical source of truth as prose
 * @param {string} [options.sourceText]  alias of `source`
 * @param {object} [options.facts]       structured facts (see claimsFromFacts)
 * @param {string} [options.jd]          reference text the model was shown (e.g. a job
 *                                       description); figures quoted verbatim from it are
 *                                       echoes, not self-claims → downgraded to unsupported
 * @param {string} [options.jdText]      alias of `jd`
 * @param {object} [options.config]      { allow_metrics, allow_facts, forbidden_phrases, warn_phrases }
 * @param {string[]} [options.nouns]     extra countable nouns for this domain
 * @param {Record<string,string>} [options.synonyms]  noun synonyms
 * @param {number} [options.floorRatio]  minimum ratio for an "N+" floor (default 0.5)
 * @param {string} [options.label]       identifier for reports
 * @param {number} [options.now]         clock for tenure checks (tests)
 */
export function verifyFacts(target, options = {}) {
  const {
    source, sourceText, facts = null, jd, jdText, config = {},
    nouns = [], synonyms = {}, floorRatio = 0.5, label = '', now = Date.now(),
  } = options;
  const src = typeof source === 'string' ? source : sourceText;
  const hasProse = typeof src === 'string' && src.trim().length > 0;
  const hasFacts = facts && typeof facts === 'object' && Object.keys(facts).length > 0;
  if (!hasProse && !hasFacts) {
    throw new Error('verifyFacts requires a source of truth: pass `source` (prose) and/or `facts` (structured). An empty gate is not a gate.');
  }

  const cfg = { allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [], ...config };
  for (const k of ['allow_metrics', 'allow_facts', 'forbidden_phrases', 'warn_phrases']) {
    if (!Array.isArray(cfg[k])) throw new Error(`config.${k} must be an array`);
  }

  const extractor = createExtractor({ nouns, synonyms });
  const sourceIdx = indexSource({ sourceText: src || '', facts, allowMetrics: cfg.allow_metrics, extractor });
  const ref = jd ?? jdText;
  const jdIdx = ref ? indexSource({ sourceText: ref, extractor }) : null;
  const allowedFacts = new Set(cfg.allow_facts.map(v => String(v).toLowerCase().trim()));
  const targetPlain = stripMarkup(target);

  const actualYears = experienceYears(src || '', facts, now);
  const claims = [];
  const allowUsed = new Set();

  const rescuedBy = (key) => {
    for (const [entry, keys] of sourceIdx.allow) if (keys.has(key)) return entry;
    return null;
  };

  for (const c of extractor.numericClaims(target)) {
    const key = `${c.kind}|${c.claim}`;
    let status, reason;

    if (c.kind === 'spelled_years') {
      if (actualYears == null) {
        status = 'unsupported';
        reason = 'source has no parseable role dates to check a spelled-out tenure claim against';
      } else if (c.number > Math.ceil(actualYears)) {
        const start = earliestExperienceStart(src || '', facts);
        status = BLOCK;
        reason = `source shows ~${Math.floor(actualYears)} years since the earliest role (${start.toISOString().slice(0, 7)}), not "${c.claim}"`;
      } else {
        status = 'verified';
        reason = `consistent with ~${Math.floor(actualYears)} years since the earliest role`;
      }
    } else if (sourceIdx.exact.has(key)) {
      status = 'verified';
      const via = rescuedBy(key);
      if (via) { allowUsed.add(via); reason = `allowed by allow_metrics entry "${via}"`; }
    } else if (c.kind === 'count' && findVerification(sourceIdx, c)) {
      const hit = findVerification(sourceIdx, c);
      status = 'verified';
      reason = `source states ${hit.number}${hit.isLowerBound ? '+' : ''} ${c.noun}${hit.modifiers.size ? ` (${[...hit.modifiers].join(' ')})` : ''}`;
    } else if (c.kind === 'count' && c.isLowerBound) {
      const lb = lowerBoundCheck(sourceIdx, c, { floorRatio });
      if (lb.result === 'ok') { status = 'verified'; reason = `source confirms ${lb.actual} ${c.noun}; the floor "${c.number}+" holds`; }
      else if (lb.result === 'exceeds') { status = BLOCK; reason = `source states ${lb.actual} ${c.noun}, which is below the claimed floor "${c.number}+"`; }
      else if (lb.result === 'too-low') { status = BLOCK; reason = `source states ${lb.actual} ${c.noun}; "${c.number}+" understates it by more than ${Math.round((1 - lb.floor) * 100)}%`; }
      else { status = 'unsupported'; reason = `source never states a count of "${c.noun}" comparable to "${c.claim}"`; }
    } else if (c.kind === 'count') {
      const conflict = contradicts(sourceIdx, c);
      if (conflict) { status = BLOCK; reason = `source states ${conflict.join(' / ')} ${c.noun}, not ${c.number}`; }
      else {
        status = 'unsupported';
        const other = sourceIdx.byNoun.get(c.noun);
        reason = other
          ? `source counts "${c.noun}" only for a different subject (${other.map(e => e.number).join(' / ')}); nothing comparable to "${c.claim}"`
          : `source never states a count of "${c.noun}"`;
      }
    } else {
      status = BLOCK;
      reason = `no ${c.kind} matching "${c.claim}" anywhere in the source`;
    }

    if (status === BLOCK && jdIdx && jdIdx.exact.has(key)) {
      status = 'unsupported';
      reason = 'absent from the source but present verbatim in the reference text (echo, not a self-claim)';
    }
    claims.push({ ...c, status, reason });
  }

  for (const f of extractor.factClaims(target)) {
    if (allowedFacts.has(f.value)) { claims.push({ ...f, status: 'verified', reason: 'allowed by allow_facts' }); continue; }
    if (containsPhrase(sourceIdx.plain, f.value)) { claims.push({ ...f, status: 'verified' }); continue; }
    if (f.kind === 'tool') { claims.push({ ...f, status: 'unsupported', reason: 'tool not named anywhere in the source' }); continue; }
    claims.push({ ...f, status: BLOCK, reason: `no ${f.kind} "${f.value}" in the source` });
  }

  const lower = targetPlain.toLowerCase();
  const forbidden = cfg.forbidden_phrases.filter(Boolean).filter(p => lower.includes(String(p).toLowerCase()));
  const warnings = cfg.warn_phrases.filter(Boolean).filter(p => lower.includes(String(p).toLowerCase()));

  const fabricated = claims.filter(c => c.status === BLOCK);
  const unsupported = claims.filter(c => c.status === 'unsupported');
  const verified = claims.filter(c => c.status === 'verified');
  const allowUnused = cfg.allow_metrics.map(String).filter(e => !allowUsed.has(e));

  const blocked = fabricated.length > 0 || forbidden.length > 0;
  return {
    label,
    verdict: blocked ? 'block' : (unsupported.length || warnings.length) ? 'warn' : 'pass',
    claims, verified, unsupported, fabricated, forbidden, warnings,
    allowlist: { used: [...allowUsed], unused: allowUnused },
    counts: { total: claims.length, verified: verified.length, unsupported: unsupported.length, fabricated: fabricated.length },
  };
}

/**
 * Render a result as report lines:
 *   [CRITICAL] FABRICATED_COUNT: "1200 tests" — source states 846 tests, not 1200
 */
export function formatReport(result) {
  const rows = [];
  for (const c of result.fabricated) rows.push(`[CRITICAL] FABRICATED_${String(c.kind).toUpperCase()}: "${c.claim ?? c.value}" — ${c.reason}`);
  for (const p of result.forbidden) rows.push(`[CRITICAL] FORBIDDEN_PHRASE: "${p}"`);
  for (const c of result.unsupported) rows.push(`[WARNING] UNSUPPORTED_${String(c.kind).toUpperCase()}: "${c.claim ?? c.value}" — ${c.reason}`);
  for (const p of result.warnings) rows.push(`[WARNING] WARN_PHRASE: "${p}"`);
  for (const e of result.allowlist?.unused || []) rows.push(`[NOTE] ALLOWLIST_UNUSED: "${e}" rescued nothing — stale, or hiding a fixed problem`);
  if (!rows.length) return 'all claims verified against the source';
  return rows.join('\n  ');
}

/** Alias kept for callers of the original job-hunt gate. */
export const formatFactFailures = formatReport;

/** Throw on a blocking verdict. */
export function assertFacts(target, options = {}) {
  const result = verifyFacts(target, options);
  if (result.verdict === 'block') {
    throw new Error(`Fact check failed${options.label ? ` for ${options.label}` : ''}:\n  ${formatReport(result)}`);
  }
  return result;
}

export default verifyFacts;

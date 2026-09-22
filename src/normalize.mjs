// Text and number normalisation shared by extraction and comparison.
//
// Two ideas live here and both are load-bearing:
//
//   1. A magnitude suffix belongs to the number. "50k users" must never
//      compare equal to a source that says "50 users" — that is a 1000x
//      inflation waved through by a dropped letter.
//
//   2. A thousands separator is only a separator when it is followed by
//      EXACTLY three digits. "183,444" is one number; "2024. 32" is a year,
//      a full stop, and a different number. The first version of this gate
//      glued those together into "2024. 32 workflows" and blocked a true
//      sentence. See test/regressions.test.mjs, B3.

/**
 * Remove fenced and inline code from markdown. A README's code blocks are
 * examples and commands, not claims about the project: "cut costs 87%" inside
 * a usage example is not the author asserting 87%.
 */
export function stripCode(text) {
  return String(text ?? '')
    .replace(/```[^`]*?(?:```|$)/gs, ' ')
    .replace(/~~~[^~]*?(?:~~~|$)/gs, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<pre[^>]*>[^]*?<\/pre>/gi, ' ');
}

/** Strip HTML tags, entity escapes and markdown emphasis down to plain prose. */
export function stripMarkup(text) {
  return String(text ?? '')
    .replace(/[\uFF10-\uFF19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))   // fullwidth digits
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48)) // Arabic-Indic digits
    .replace(/[\u06F0-\u06F9]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 48)) // Eastern Arabic-Indic digits
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[*_`]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\r?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const MAGNITUDE = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * Fold a numeric token to a canonical digit string.
 *
 *   "183,444"  -> "183444"     "183 444" -> "183444"
 *   "4.5K"     -> "4500"       "1.2M"    -> "1200000"
 *   "3.75"     -> "3.75"       "12"      -> "12"
 *
 * Grouping separators (comma, dot, thin/regular space) are removed only when
 * each group is exactly three digits, so a decimal like "3.75" survives and a
 * sentence boundary like "2024. 32" is never fused.
 */
export function normalizeNumber(token) {
  let s = String(token).trim().toLowerCase();
  const suffix = /([kmb])$/.exec(s)?.[1];
  if (suffix) s = s.slice(0, -1).trim();

  // Grouped thousands: a leading 1-3 digit block followed by one or more
  // separator+3-digit blocks and nothing else.
  if (/^\d{1,3}(?:[,.\s  ]\d{3})+$/.test(s)) {
    s = s.replace(/[,.\s  ]/g, '');
  } else {
    // Otherwise a single comma or dot is a decimal mark (EU or US style).
    s = s.replace(/,/g, '.');
  }

  if (suffix) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(Math.round(n * MAGNITUDE[suffix]));
  }
  // Drop a trailing ".0"
  return s.replace(/\.0+$/, '');
}

/**
 * Fold a whole claim string to its comparison form: lowercase, every embedded
 * number normalised, whitespace collapsed, trailing punctuation removed.
 */
export function normalizeClaim(claim) {
  let s = String(claim).toLowerCase().trim();
  s = s.replace(/\d{1,3}(?:[,.\s  ]\d{3})+(?:\s?[kmb]\b)?|\d+(?:[.,]\d+)?(?:\s?[kmb]\b)?/g,
    (m) => normalizeNumber(m));
  return s.replace(/[,\s]+/g, ' ').replace(/[.;:,]+$/g, '').trim();
}

/**
 * Qualifier synonyms. "3 new tests" and "tests added: 3" are the same claim;
 * a fabrication check that treats them as different subjects cannot compare
 * them, and an inflated "adds 10 tests" would sail through as unsupported.
 */
export const MODIFIER_SYNONYMS = {
  new: 'added', created: 'added', inserted: 'added', introduced: 'added', additional: 'added',
  removed: 'deleted', dropped: 'deleted', deletions: 'deleted', removals: 'deleted',
  updated: 'modified', edited: 'modified',
  touched: 'changed', affected: 'changed',
};

/** Lowercase a modifier list, fold synonyms, drop empties. */
export function normalizeModifiers(words) {
  return (words || [])
    .map(w => String(w).toLowerCase().trim())
    .filter(Boolean)
    .map(w => MODIFIER_SYNONYMS[w] ?? w);
}

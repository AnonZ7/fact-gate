// A diff as a source of truth.
//
// The most common AI-written text in a repository is the pull-request
// description, and the most common lie in it is a number: "touches 12 files",
// "adds 40 tests", "removes 300 lines". The diff already knows the truth.
// This module reads a unified diff (or `git diff --numstat` output) and turns
// it into the same structured `facts` the gate checks against, so a PR body
// is verified against the change it describes with no model in the loop.
//
// Every fact here is derived, never inferred: file counts by status, line
// counts by direction, test files and test cases added, dependencies added
// (package.json / requirements.txt / pyproject / go.mod / Cargo.toml).

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|specs?|test_?utils?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|rs|ex|exs)$|(^|\/)test_[^/]*\.py$|Tests?\.(cs|java|kt|swift|php)$/i;
// One added line that starts a test case, across the common runners.
const TEST_CASE_RE = /^\+\s*(?:(?:it|test|describe\.each|test\.each)\s*\(|@Test\b|#\[(?:test|tokio::test)\]|def test_\w+|func Test[A-Z]\w*\(|(?:public\s+)?function test\w+\(|(?:it|test|describe)\s*\.\s*(?:only|skip)\s*\()/;

const PACKAGE_JSON_TOP_LEVEL = new Set([
  'name', 'version', 'description', 'main', 'module', 'types', 'typings', 'type', 'exports', 'imports',
  'bin', 'files', 'scripts', 'engines', 'os', 'cpu', 'private', 'license', 'author', 'repository',
  'bugs', 'homepage', 'keywords', 'workspaces', 'packageManager', 'sideEffects', 'browser', 'funding',
  'publishConfig', 'config', 'peerDependenciesMeta', 'overrides', 'resolutions', 'unpkg', 'jsdelivr',
]);
const NPM_DEP_LINE_RE = /^([+-])\s*"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"[^"]*"\s*,?\s*$/;
const PY_REQ_LINE_RE = /^([+-])\s*([A-Za-z][\w.-]*)(?:\[[^\]]*\])?\s*(?:[=<>!~]=?|$)/;
const GO_MOD_LINE_RE = /^([+-])\s+([\w.-]+(?:\/[\w.-]+)+)\s+v[\w.+-]+/;
const CARGO_DEP_LINE_RE = /^([+-])\s*([A-Za-z][\w-]*)\s*=\s*(?:"[^"]*"|\{)/;

function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }

function depFromLine(line, path) {
  const base = basename(path);
  let m;
  if (base === 'package.json') {
    m = NPM_DEP_LINE_RE.exec(line);
    if (m && !PACKAGE_JSON_TOP_LEVEL.has(m[2])) return { sign: m[1], name: m[2] };
    return null;
  }
  if (/^requirements[\w.-]*\.txt$/.test(base)) { m = PY_REQ_LINE_RE.exec(line); return m ? { sign: m[1], name: m[2].toLowerCase() } : null; }
  if (base === 'go.mod') { m = GO_MOD_LINE_RE.exec(line); return m ? { sign: m[1], name: m[2] } : null; }
  if (base === 'Cargo.toml' || base === 'pyproject.toml') { m = CARGO_DEP_LINE_RE.exec(line); return m && !/^(name|version|edition|description|authors|license|readme|repository|homepage|python|build-backend|requires)$/.test(m[2]) ? { sign: m[1], name: m[2] } : null; }
  return null;
}

/**
 * Parse a unified diff or `git diff --numstat` output.
 * @param {string} text
 * @returns {{format: 'unified'|'numstat'|'empty', files: Array<{path: string, oldPath: string|null, status: 'added'|'deleted'|'modified'|'renamed', additions: number, deletions: number, binary: boolean, isTest: boolean, testsAdded: number}>, dependenciesAdded: string[], dependenciesRemoved: string[]}}
 */
export function parseDiff(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const files = [];
  const depAdded = new Map();
  const depRemoved = new Map();

  const isUnified = lines.some(l => DIFF_HEADER_RE.test(l) || l.startsWith('--- ') || l.startsWith('+++ '));
  if (!isUnified) {
    for (const l of lines) {
      const m = NUMSTAT_RE.exec(l);
      if (!m) continue;
      const binary = m[1] === '-';
      const path = m[3].includes(' => ') ? m[3].replace(/^.*\{?(?:[^{}]*) => ([^{}]*)\}?(.*)$/, '$1$2').replace(/\/\//g, '/') : m[3];
      files.push({
        path, oldPath: null, status: 'modified', binary,
        additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]),
        isTest: TEST_PATH_RE.test(path), testsAdded: 0,
      });
    }
    return { format: files.length ? 'numstat' : 'empty', files, dependenciesAdded: [], dependenciesRemoved: [] };
  }

  let cur = null;
  let inHunk = false;
  const flush = () => { if (cur) files.push(cur); cur = null; inHunk = false; };
  for (const l of lines) {
    const h = DIFF_HEADER_RE.exec(l);
    if (h) {
      flush();
      cur = { path: h[2], oldPath: h[1] !== h[2] ? h[1] : null, status: 'modified', additions: 0, deletions: 0, binary: false, isTest: TEST_PATH_RE.test(h[2]), testsAdded: 0 };
      continue;
    }
    if (!cur) {
      // A bare "--- a/x" / "+++ b/x" pair without the git header line.
      if (l.startsWith('+++ ') && !l.startsWith('+++ /dev/null')) {
        cur = { path: l.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''), oldPath: null, status: 'modified', additions: 0, deletions: 0, binary: false, isTest: false, testsAdded: 0 };
        cur.isTest = TEST_PATH_RE.test(cur.path);
      }
      continue;
    }
    if (!inHunk) {
      if (l.startsWith('new file mode')) cur.status = 'added';
      else if (l.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (l.startsWith('rename from ') || l.startsWith('rename to ')) cur.status = 'renamed';
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) cur.binary = true;
      else if (l.startsWith('--- /dev/null')) cur.status = 'added';
      else if (l.startsWith('+++ /dev/null')) cur.status = 'deleted';
      else if (l.startsWith('@@')) inHunk = true;
      continue;
    }
    if (l.startsWith('@@')) continue;
    if (l.startsWith('diff ') || l.startsWith('index ')) { inHunk = false; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      cur.additions++;
      if (cur.isTest && TEST_CASE_RE.test(l)) cur.testsAdded++;
      const d = depFromLine(l, cur.path); if (d) depAdded.set(d.name, true);
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      cur.deletions++;
      const d = depFromLine(l, cur.path); if (d) depRemoved.set(d.name, true);
    }
  }
  flush();

  // A dependency that was removed and re-added (a trailing comma, a version bump) is not new.
  const dependenciesAdded = [...depAdded.keys()].filter(n => !depRemoved.has(n));
  const dependenciesRemoved = [...depRemoved.keys()].filter(n => !depAdded.has(n));
  return { format: 'unified', files, dependenciesAdded, dependenciesRemoved };
}

/**
 * Derive structured facts from a diff, in the shape `verifyFacts` accepts.
 *
 * Counts are keyed "<qualifier> <noun>" so a claim's own qualifier ("adds 4
 * tests" → tests/added) lands on the matching figure. Totals that would make
 * a truthful partial claim look like a contradiction ("removes 6 lines" vs a
 * bare 32 changed lines) are deliberately NOT indexed bare.
 *
 * @param {string} text  unified diff or `git diff --numstat` output
 * @param {object} [options]
 * @param {number} [options.commits]  number of commits, when the caller knows it
 * @returns {import('./index.mjs').Facts}
 */
export function factsFromDiff(text, { commits } = {}) {
  const d = parseDiff(text);
  const by = (s) => d.files.filter(f => f.status === s).length;
  const additions = d.files.reduce((n, f) => n + f.additions, 0);
  const deletions = d.files.reduce((n, f) => n + f.deletions, 0);
  const testFiles = d.files.filter(f => f.isTest);
  const testsAdded = testFiles.reduce((n, f) => n + f.testsAdded, 0);

  const counts = {
    'files': d.files.length,
    'files changed': d.files.length,
    'files added': by('added'),
    'files deleted': by('deleted'),
    'files modified': by('modified'),
    'files renamed': by('renamed'),
    'lines added': additions,
    'insertions': additions,
    'additions': additions,
    'lines deleted': deletions,
    'deletions': deletions,
    'lines changed': additions + deletions,
    'changes': additions + deletions,
    'test files': testFiles.length,
    'test files added': testFiles.filter(f => f.status === 'added').length,
    'test files changed': testFiles.length,
    'dependencies added': d.dependenciesAdded.length,
    'packages added': d.dependenciesAdded.length,
    'dependencies deleted': d.dependenciesRemoved.length,
    'packages deleted': d.dependenciesRemoved.length,
  };
  // Test cases are counted only when the runner's syntax is recognised. A test
  // file written in a house style (bare blocks calling pass()/fail()) yields no
  // count at all; asserting "0 tests added" there would turn a true "two new
  // tests" into a fabrication.
  const testSyntaxKnown = testsAdded > 0 || testFiles.every(f => f.additions === 0);
  if (d.format === 'unified' && testSyntaxKnown) { counts['tests added'] = testsAdded; counts['cases added'] = testsAdded; }
  if (Number.isFinite(commits)) counts['commits'] = commits;

  return {
    counts,
    tools: [...d.dependenciesAdded],
    files: d.files.map(f => f.path),
    _diff: { format: d.format, files: d.files.length, additions, deletions, testsAdded, dependenciesAdded: d.dependenciesAdded, dependenciesRemoved: d.dependenciesRemoved },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDiff, factsFromDiff } from '../src/diff.mjs';
import { verifyFacts, formatReport } from '../src/index.mjs';

const diff = readFileSync(new URL('../examples/pr.diff', import.meta.url), 'utf8');

test('parseDiff reads status, additions and deletions per file', () => {
  const d = parseDiff(diff);
  assert.equal(d.format, 'unified');
  assert.equal(d.files.length, 6);
  const by = Object.fromEntries(d.files.map(f => [f.path, f]));
  assert.equal(by['src/limits.mjs'].status, 'added');
  assert.equal(by['src/limits.mjs'].additions, 8);
  assert.equal(by['src/legacy-limits.mjs'].status, 'deleted');
  assert.equal(by['src/legacy-limits.mjs'].deletions, 3);
  assert.equal(by['src/server.mjs'].status, 'modified');
  assert.deepEqual([by['src/server.mjs'].additions, by['src/server.mjs'].deletions], [4, 1]);
  assert.equal(by['test/limits.test.mjs'].isTest, true);
  assert.equal(by['test/limits.test.mjs'].testsAdded, 4);
});

test('a dependency removed and re-added (trailing comma) is not "new"', () => {
  const d = parseDiff(diff);
  assert.deepEqual(d.dependenciesAdded, ['zod']);
  assert.deepEqual(d.dependenciesRemoved, []);
});

test('factsFromDiff produces qualified counts', () => {
  const f = factsFromDiff(diff);
  assert.equal(f.counts['files'], 6);
  assert.equal(f.counts['files added'], 2);
  assert.equal(f.counts['files deleted'], 1);
  assert.equal(f.counts['files modified'], 3);
  assert.equal(f.counts['lines added'], 26);
  assert.equal(f.counts['lines deleted'], 6);
  assert.equal(f.counts['tests added'], 4);
  assert.equal(f.counts['dependencies added'], 1);
  assert.deepEqual(f.tools, ['zod']);
  assert.equal('lines' in f.counts, false, 'a bare lines total would make "removes 6 lines" look like a contradiction');
});

test('numstat output is accepted too', () => {
  const f = factsFromDiff('12\t3\tsrc/a.js\n0\t40\tsrc/b.js\n-\t-\tlogo.png\n');
  assert.equal(f.counts.files, 3);
  assert.equal(f.counts['lines added'], 12);
  assert.equal(f.counts['lines deleted'], 43);
  assert.equal(f._diff.format, 'numstat');
  assert.equal('tests added' in f.counts, false, 'numstat cannot see test cases');
});

test('an empty diff yields zero counts, not an error', () => {
  const f = factsFromDiff('');
  assert.equal(f.counts.files, 0);
});

// ----------------------------------------------------------- PR descriptions
test('a truthful PR description passes against its diff', () => {
  const body = readFileSync(new URL('../examples/pr-body.md', import.meta.url), 'utf8');
  const r = verifyFacts(body, { diff });
  assert.equal(r.verdict, 'warn', formatReport(r));
  assert.equal(r.fabricated.length, 0);
  const claims = r.verified.map(c => c.claim);
  for (const want of ['6 files', '2 files', '1 files', '3 files', '26 lines', '4 tests', '1 dependencies']) {
    assert.ok(claims.includes(want), `expected "${want}" verified, got ${JSON.stringify(claims)}`);
  }
});

test('an inflated PR description is blocked with the real figures named', () => {
  const body = readFileSync(new URL('../examples/pr-body-inflated.md', import.meta.url), 'utf8');
  const r = verifyFacts(body, { diff });
  assert.equal(r.verdict, 'block');
  const reasons = Object.fromEntries(r.fabricated.map(c => [c.claim, c.reason]));
  assert.match(reasons['12 files'], /6 files/);
  assert.match(reasons['40 tests'], /4 tests/);
  assert.match(reasons['300 lines'], /6 lines/);
  assert.match(reasons['0 dependencies'], /1 dependencies/, '"no new dependencies" is a count of zero and it is false');
});

test('verbs qualify a count: "adds N tests" is judged against tests ADDED', () => {
  assert.equal(verifyFacts('Adds 4 tests.', { diff }).verdict, 'pass');
  assert.equal(verifyFacts('Adds 10 tests.', { diff }).verdict, 'block');
  assert.equal(verifyFacts('Removes 6 lines.', { diff }).verdict, 'pass');
  assert.equal(verifyFacts('Removes 26 lines.', { diff }).verdict, 'block');
  assert.equal(verifyFacts('Touches 6 files.', { diff }).verdict, 'pass');
});

test('"no new dependencies" against a diff that adds one is a fabrication', () => {
  const r = verifyFacts('No new dependencies.', { diff });
  assert.equal(r.verdict, 'block', formatReport(r));
  assert.equal(r.fabricated[0].claim, '0 dependencies');
});

test('"no" outside a change context is not a count', () => {
  const r = verifyFacts('There are no users in this fixture.', { facts: { counts: { users: 3 } } });
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('a colon breakdown after a count is extracted with its labels', () => {
  const r = verifyFacts('Touches 6 files: 2 new, 1 deleted, 3 modified.', { diff });
  assert.equal(r.verdict, 'pass', formatReport(r));
  assert.equal(verifyFacts('Touches 6 files: 4 new, 1 deleted, 1 modified.', { diff }).verdict, 'block');
});

test('diff facts merge with user facts; user facts win on a duplicate key', () => {
  const r = verifyFacts('Adds 4 tests. The suite has 100 tests.', { diff, facts: { counts: { tests: 100 } } });
  assert.equal(r.verdict, 'pass', formatReport(r));
});

test('a test file in a house style (no recognisable test() calls) leaves the case count unknown, not zero', () => {
  const d = [
    'diff --git a/tests/x.test.mjs b/tests/x.test.mjs', 'new file mode 100644', '--- /dev/null', '+++ b/tests/x.test.mjs', '@@ -0,0 +1,4 @@',
    '+import { pass, fail } from "./helpers.mjs";', '+{', '+  if (1 + 1 === 2) pass("adds"); else fail("adds");', '+}', '',
  ].join(String.fromCharCode(10));
  const f = factsFromDiff(d);
  assert.equal('tests added' in f.counts, false, 'unknown, so a claim of "two new tests" is unsupported, never fabricated');
  assert.equal(f.counts['test files added'], 1);
  assert.equal(verifyFacts('Adds two new tests.', { diff: d }).verdict, 'warn');
  // ...while a recognised runner still yields an exact count.
  assert.equal(factsFromDiff(diff).counts['tests added'], 4);
});

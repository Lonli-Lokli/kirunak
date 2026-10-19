import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReview, parseEvidence } from '../lib/review.mjs';
import { parseTask } from '../lib/task.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { gitCommitAll, k, makeWorkspace, sh } from './helpers.mjs';

const ID = 'weather/offline-forecast';

// The invented workspace with a test file, a source file and an evidence table committed at head.
async function reviewed() {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  const put = (abs, text) => {
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  };
  put(join(w.weather, 'test', 'forecast.test.ts'), "describe('OfflineForecastTest', () => {\n  test('opens on the last forecast', () => {});\n});\n");
  put(join(w.weather, 'src', 'cache.ts'), Array.from({ length: 90 }, (_, n) => `// line ${n + 1}`).join('\n') + '\n');
  put(join(p.dir, 'evidence', 'S-1-cache-sizes.tsv'), 'days\tbytes\n3\t2048\n');
  gitCommitAll(w.weather, 'the work');
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const task = parseTask(sh(w.weather, 'cat', [p.task]));
  const check = (text) => checkReview(text, { task, id: ID, p });
  return { ...w, p, head, check };
}

const ROWS = [
  '| AC-1 | met | test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:2) |',
  '| AC-2 | met | file src/cache.ts:88: the fetch time goes through the reader\'s own format |',
  '| AC-3 | needs device | a restart on both phone platforms is not testable on the desktop |',
  '| E-1 | met | measure evidence/S-1-cache-sizes.tsv row 2 |',
];

const review = (head, rows = ROWS, verdict = 'verdict: needs owner (AC-3)') => `---
task: ${ID}
reviewed: 2026-11-07
head: ${head}
base: 7c1d2e3
session: 3e4f
---

| id | verdict | evidence |
| --- | --- | --- |
${rows.join('\n')}

## Findings
- AC-3: on a phone.

${verdict}
`;

const problems = (list) => list.map((x) => x.problem);

test('a review in the grammar passes', async () => {
  const w = await reviewed();
  assert.deepEqual(w.check(review(w.head)), []);
});

test('the evidence forms: test, file, measure, screenshot', () => {
  assert.deepEqual(parseEvidence('test A.b c (t/x.test.ts:41)'), { kind: 'test', name: 'A.b c', path: 't/x.test.ts', line: 41 });
  assert.deepEqual(parseEvidence('test opens (t/x.test.ts)'), { kind: 'test', name: 'opens', path: 't/x.test.ts', line: null });
  assert.deepEqual(parseEvidence('file src/a.ts:88: two days, not three'), { kind: 'file', path: 'src/a.ts', line: 88 });
  assert.deepEqual(parseEvidence('measure evidence/x.tsv row 12'), { kind: 'measure', path: 'evidence/x.tsv', line: null });
  assert.deepEqual(parseEvidence('screenshot evidence/a.png, the dark theme'), { kind: 'screenshot', path: 'evidence/a.png', line: null });
  assert.equal(parseEvidence('the tests pass'), null);
  assert.equal(parseEvidence('file src/a.ts'), null, 'a file needs its line');
});

test('a missing row and an extra row', async () => {
  const w = await reviewed();
  const missing = w.check(review(w.head, ROWS.filter((r) => !r.includes('AC-2'))));
  assert.deepEqual(problems(missing), ['AC-2 has no row: one row per AC and E']);
  const extra = w.check(review(w.head, [...ROWS, '| O-1 | met | file src/cache.ts:1 |', '| E-1 | met | measure evidence/S-1-cache-sizes.tsv |']));
  assert.deepEqual(problems(extra), [
    'O-1 is not an AC or E of the task: one row per AC and E, none extra',
    'E-1 has a second row (the first is line 14)',
  ]);
});

test('met without evidence, and a verdict outside the four', async () => {
  const w = await reviewed();
  const rows = [...ROWS];
  rows[1] = '| AC-2 | met | the format follows the locale |';
  rows[3] = '| E-1 | done | measured |';
  assert.deepEqual(problems(w.check(review(w.head, rows))), [
    'AC-2: met without evidence: the evidence starts with test <Name> (<path>), file <path>:<line>, measure <path> or screenshot <path>',
    'E-1: the verdict done is not one of met, not met, needs device, needs owner',
  ]);
});

test('a file:line past the file, a test name not in the named file, a path not at head', async () => {
  const w = await reviewed();
  const rows = [...ROWS];
  rows[0] = '| AC-1 | met | test OfflineForecastTest.keeps three days (test/forecast.test.ts:2) |';
  rows[1] = '| AC-2 | met | file src/cache.ts:91 |';
  rows[3] = '| E-1 | met | screenshot evidence/S-4-age.png |';
  writeFileSync(join(w.p.dir, 'evidence', 'S-4-age.png'), 'not committed');
  assert.deepEqual(problems(w.check(review(w.head, rows))), [
    'AC-1: test OfflineForecastTest.keeps three days is not in test/forecast.test.ts',
    "AC-2: src/cache.ts:91 is past the file's length (90 lines at head)",
    'E-1: evidence/S-4-age.png does not exist at head',
  ]);
  rows[1] = '| AC-2 | met | file src/cache.ts:90 |';
  rows[0] = '| AC-1 | met | test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:4) |';
  assert.deepEqual(problems(w.check(review(w.head, rows))).slice(0, 2), ["AC-1: test/forecast.test.ts:4 is past the file's length (3 lines at head)", 'E-1: evidence/S-4-age.png does not exist at head']);
});

test('the verdict line: from the rows, the last line, and only there', async () => {
  const w = await reviewed();
  const allMet = ROWS.map((r) => r.replace('| needs device | a restart', '| met | file src/cache.ts:3: a restart'));
  assert.deepEqual(w.check(review(w.head, allMet, 'verdict: met')), []);
  assert.deepEqual(problems(w.check(review(w.head, ROWS, 'verdict: met'))), ['the rows make the verdict verdict: needs owner (AC-3), not verdict: met']);
  const notMet = [...ROWS];
  notMet[1] = '| AC-2 | not met | file src/cache.ts:88: a fixed 24-hour format |';
  assert.deepEqual(w.check(review(w.head, notMet, 'verdict: not met (AC-2)')), []);
  assert.deepEqual(problems(w.check(review(w.head, notMet, 'verdict: needs owner (AC-3)'))), ['the rows make the verdict verdict: not met (AC-2), not verdict: needs owner (AC-3)']);
  notMet[1] = '| AC-2 | not met | |';
  assert.deepEqual(problems(w.check(review(w.head, notMet, 'verdict: not met (AC-2)'))), ['AC-2 is not met: its row names what is wrong']);
  assert.deepEqual(problems(w.check(review(w.head, ROWS, 'verdict: pass'))), ['verdict: pass is not verdict: met, verdict: not met (<ids>) or verdict: needs owner (<ids>)']);
  assert.deepEqual(problems(w.check(review(w.head, ROWS, 'Signed, the reviewer.'))), ['the last line is the verdict: verdict: needs owner (AC-3)']);
  assert.deepEqual(problems(w.check(review(w.head, ROWS, 'verdict: needs owner (AC-3)\n\nverdict: needs owner (AC-3)'))), ['a verdict line before the last line: the verdict is the last line only']);
});

test('the front matter: the task and a head that is a commit', async () => {
  const w = await reviewed();
  const text = review(w.head).replace(`task: ${ID}`, 'task: weather/other').replace(`head: ${w.head}`, 'head: 0000000');
  assert.deepEqual(problems(w.check(text)), [`the review is for weather/other, not ${ID}`, 'head 0000000 is not a commit of the repo']);
  assert.deepEqual(problems(w.check(review(w.head).replace(/^head: .*\n/m, ''))), ['the front matter names no head, the commit the cited paths are read at']);
});

test('k review check reads the latest review, or the one named, and exits 1 on a problem', async () => {
  const w = await reviewed();
  const none = k(w.home, ['review', 'check', ID]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /has no kirunak\/tasks\/offline-forecast\/review\.md/);
  writeFileSync(join(w.p.dir, 'review.md'), review(w.head));
  const ok = k(w.home, ['review', 'check', ID]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /review\.md: check passes/);
  writeFileSync(join(w.p.dir, 'review-2.md'), review(w.head, ROWS.slice(1)));
  const bad = k(w.home, ['review', 'check', ID]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /review-2\.md: 1 problem\n {2}line 9: AC-1 has no row: one row per AC and E\n$/);
  assert.equal(k(w.home, ['review', 'check', ID, 'review.md']).status, 0);
});

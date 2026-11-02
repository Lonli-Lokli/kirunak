import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReview, evidenceWords, parseEvidence, verdictOf, verdictText } from '../lib/review.mjs';
import { parseTask } from '../lib/task.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { gitCommitAll, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

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

test('the head is a commit id, never a name that moves on after the review: HEAD, a branch, or a ref spelled like an id', async () => {
  const w = await reviewed();
  const full = sh(w.weather, 'git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(problems(w.check(review(full))), [], 'the full 40-character id');
  assert.deepEqual(problems(w.check(review(w.head.toUpperCase()))), [], 'in capitals');
  for (const name of ['HEAD', 'master', 'HEAD~1', `${w.head}^`, w.head.slice(0, 6)]) {
    const want = [`head ${name} is not a commit id: write the reviewed commit's hash, 7 to 40 hex characters`];
    assert.deepEqual(problems(w.check(review(w.head).replace(`head: ${w.head}`, `head: ${name}`))), want, name);
    assert.deepEqual(problems(checkReview(review(name), { task: parseTask(sh(w.weather, 'cat', [w.p.task])), id: ID, p: w.p, atHead: false })), want, `${name}, without git`);
  }
  sh(w.weather, 'git', ['branch', 'abcdef1']);
  assert.deepEqual(problems(w.check(review('abcdef1'))), ['head abcdef1 is not a commit of the repo'], 'a branch named like an id');
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

// A re-review (gulnya/review-reruns-whole-task AC-2, AC-5): review-2.md written at head `seen`, whose E-1 row was itself
// carried, then more work; a review-3 at the head now carries rows from it. given is what kirunak gave review-3.
async function rereviewed() {
  const w = await reviewed();
  writeFileSync(join(w.hub, 'tools.txt'), 'tools\n');
  writeFileSync(join(w.hub, 'cache.txt'), 'cache\n');
  gitCommitAll(w.hub, 'hub work');
  const hubSeen = sh(w.hub, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const seenRows = [
    ROWS[0],
    '| AC-2 | not met | file src/cache.ts:88: a fixed 24-hour format |',
    `| AC-3 | needs device | On a phone: restart the app offline (src/cache.ts, ${w.hub}/tools.txt) |`,
    '| E-1 | needs owner | carried from review-1: Read the age line aloud: does it read naturally? |',
  ];
  writeFileSync(join(w.p.dir, 'review-2.md'), review(w.head, seenRows, 'verdict: not met (AC-2)'));
  writeFileSync(join(w.p.dir, 'checklist.md'), [
    `- [x] AC-3 On a phone: restart the app offline (src/cache.ts, ${w.hub}/tools.txt) (review-2.md), done on the Pixel 7`,
    '- [ ] E-1 Read the age line aloud: does it read naturally? (review.md)',
  ].join('\n') + '\n');
  // Work after review-2: a file no row names, here and in hub.
  writeFileSync(join(w.weather, 'src', 'other.ts'), 'other\n');
  gitCommitAll(w.weather, 'more work');
  writeFileSync(join(w.hub, 'cache.txt'), 'cache\nevicted\n');
  gitCommitAll(w.hub, 'more hub work');
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const hubHead = sh(w.hub, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const given = {
    head,
    repos: [{ name: 'hub', root: w.hub, ref: 'master', base: hubSeen, head: hubHead, files: ['cache.txt'] }],
    last: { file: 'review-2.md', review: 'review-2', head: w.head, repos: { hub: hubSeen } },
  };
  const task = parseTask(sh(w.weather, 'cat', [w.p.task]));
  const carry = (rows, opts = {}) => checkReview(review(sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim(), rows, 'verdict: ' + verdictText(verdictOf(rows.map((r) => ({ id: r.split('|')[1].trim(), verdict: r.split('|')[2].trim() }))))), { task, id: ID, p: w.p, given, ws: w.ws, ...opts });
  return { ...w, seen: w.head, hubSeen, head, hubHead, given, carry };
}

const CARRIED_ROWS = (w) => [
  '| AC-1 | met | carried from review-2: test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:2) |',
  '| AC-2 | met | file src/cache.ts:3: the reader\'s own format |',
  `| AC-3 | needs device | carried from review-2: On a phone: restart the app offline (src/cache.ts, ${w.hub}/tools.txt) |`,
  '| E-1 | needs owner | Read the age line aloud: does it read naturally? |',
];

test('a re-review carries a met row and a needs device row on the owner\'s checklist whose paths did not change, here and in another repo (AC-2, D-2, D-3)', async () => {
  const w = await rereviewed();
  assert.deepEqual(problems(w.carry(CARRIED_ROWS(w))), []);
  // An untouched folder of the task folder, and an absolute path in hub that did not change, carry too.
  writeFileSync(join(w.p.dir, 'review-2.md'), readFileSync(join(w.p.dir, 'review-2.md'), 'utf8').replace(ROWS[0], `| AC-1 | met | measure evidence/S-1-cache-sizes.tsv, ${w.hub}/tools.txt |`));
  const rows = CARRIED_ROWS(w);
  rows[0] = `| AC-1 | met | carried from review-2: measure evidence/S-1-cache-sizes.tsv, ${w.hub}/tools.txt |`;
  assert.deepEqual(problems(w.carry(rows)), []);
});

test('a re-review refuses a carried row that was not met there, or needs device with no item on the checklist (AC-2, D-3)', async () => {
  const w = await rereviewed();
  const rows = CARRIED_ROWS(w);
  rows[1] = '| AC-2 | not met | carried from review-2: file src/cache.ts:88: a fixed 24-hour format |';
  assert.deepEqual(problems(w.carry(rows)), ['AC-2: carried from review-2, where it was not met: only a met row, or a needs device or needs owner row on the owner\'s checklist, is carried; check the line again']);
  writeFileSync(join(w.p.dir, 'checklist.md'), '- [ ] E-1 Read the age line aloud: does it read naturally? (review.md)\n');
  assert.deepEqual(problems(w.carry(CARRIED_ROWS(w))), ['AC-3: carried from review-2, where it was needs device with no item of the same id and words on the owner\'s checklist, checklist.md: check the line again']);
});

test('a re-review refuses a carried row whose named path changed since, here or in another repo, or in a repo whose earlier head is not known (AC-2)', async () => {
  const w = await rereviewed();
  writeFileSync(join(w.weather, 'test', 'forecast.test.ts'), readFileSync(join(w.weather, 'test', 'forecast.test.ts'), 'utf8') + '// more\n');
  gitCommitAll(w.weather, 'the test changed');
  const now = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  assert.deepEqual(problems(w.carry(CARRIED_ROWS(w))), [`AC-1: carried from review-2, but test/forecast.test.ts changed between ${w.seen} and ${now}: check the line again`]);

  const v = await rereviewed();
  const unknown = { ...v.given, repos: [] };
  assert.deepEqual(problems(v.carry(CARRIED_ROWS(v), { given: unknown })), [`AC-3: carried from review-2, but ${v.hub}/tools.txt is in hub, whose head the last review saw is not known: check the line again`]);
  const rows = CARRIED_ROWS(v);
  writeFileSync(join(v.p.dir, 'review-2.md'), readFileSync(join(v.p.dir, 'review-2.md'), 'utf8').replace(ROWS[0], `| AC-1 | met | file src/cache.ts:1, and ${v.hub}/cache.txt |`));
  rows[0] = `| AC-1 | met | carried from review-2: file src/cache.ts:1, and ${v.hub}/cache.txt |`;
  assert.deepEqual(problems(v.carry(rows)), [`AC-1: carried from review-2, but ${v.hub}/cache.txt changed in hub between ${v.hubSeen} and ${v.hubHead}: check the line again`]);
  // The same file named in a git worktree of hub is hub's.
  const tree = join(v.root, 'hub-tree');
  sh(v.hub, 'git', ['worktree', 'add', '-q', '--detach', tree]);
  writeFileSync(join(v.p.dir, 'review-2.md'), readFileSync(join(v.p.dir, 'review-2.md'), 'utf8').replace(`${v.hub}/cache.txt`, `${tree}/cache.txt`));
  rows[0] = rows[0].replace(`${v.hub}/cache.txt`, `${tree}/cache.txt`);
  assert.deepEqual(problems(v.carry(rows)), [`AC-1: carried from review-2, but ${tree}/cache.txt changed in hub between ${v.hubSeen} and ${v.hubHead}: check the line again`]);
});

test('a re-review refuses a carried row of a line amended since, with no path, from a review not given, or in other words (AC-2, E-2, E-4)', async () => {
  const w = await rereviewed();
  const rows = CARRIED_ROWS(w);
  rows[3] = '| E-1 | needs owner | carried from review-2: Read the age line aloud: does it read naturally? |';
  assert.deepEqual(problems(w.carry(rows)), ['E-1: carried from review-2, but its evidence names no path, a file or folder at review-2\'s head ' + w.seen + ': check the line again']);

  const other = CARRIED_ROWS(w);
  other[0] = '| AC-1 | met | carried from review-1: test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:2) |';
  assert.deepEqual(problems(w.carry(other)), ['AC-1: carried from review-1, but the last review kirunak gave this review is review-2 (review-2.md): a row is carried only from it; check the line again']);
  assert.deepEqual(problems(w.carry(CARRIED_ROWS(w), { given: null })).slice(0, 1), ['AC-1: carried from review-2, but kirunak gave this review no last review: a row is carried only from it; check the line again']);

  const words = CARRIED_ROWS(w);
  words[0] = '| AC-1 | met | carried from review-2: test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:1) |';
  assert.deepEqual(problems(w.carry(words)), ['AC-1: carried from review-2, but its row there is met: test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:2): a carried row keeps that verdict and that evidence verbatim; check the line again']);

  const task = readFileSync(w.p.task, 'utf8');
  writeFileSync(w.p.task, task.replace('with the time it was fetched.', 'with the time and date it was fetched.'));
  gitCommitAll(w.weather, 'amended');
  const amended = parseTask(readFileSync(w.p.task, 'utf8'));
  assert.deepEqual(problems(w.carry(CARRIED_ROWS(w), { task: amended })), [`AC-1: carried from review-2, but its task line was amended since review-2's head ${w.seen}: check the line again`]);
});

test('k review check reads the last review from given.json and refuses a carry it does not take', async () => {
  const w = await rereviewed();
  reviewsRan(w.p.dir, ['review.md', 'review-2.md', 'review-3.md']);
  mkdirSync(join(w.p.dir, 'steps', 'S-4'), { recursive: true });
  writeFileSync(join(w.p.dir, 'steps', 'S-4', 'given.json'), JSON.stringify(w.given));
  const rows = CARRIED_ROWS(w);
  writeFileSync(join(w.p.dir, 'review-3.md'), review(w.head, rows, 'verdict: needs owner (AC-3, E-1)'));
  const ok = k(w.home, ['review', 'check', ID, 'review-3.md']);
  assert.equal(ok.status, 0, ok.stderr);
  rows[1] = '| AC-2 | not met | carried from review-2: file src/cache.ts:88: a fixed 24-hour format |';
  writeFileSync(join(w.p.dir, 'review-3.md'), review(w.head, rows, 'verdict: not met (AC-2)'));
  const bad = k(w.home, ['review', 'check', ID, 'review-3.md']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /line 12: AC-2: carried from review-2, where it was not met: only a met row/);
});

test('the words of a row\'s evidence that may name a path', () => {
  assert.deepEqual(evidenceWords('test A.b c (t/x.test.ts:41), `src/a.ts:3-9`; ~/x/y.md.'), ['A.b', 'c', 't/x.test.ts', 'src/a.ts', '~/x/y.md']);
  assert.deepEqual(evidenceWords('measure evidence/x.tsv row 2 [docs/a.md]'), ['evidence/x.tsv', 'row', '2', 'docs/a.md']);
});

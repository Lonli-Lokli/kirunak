import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accept } from '../lib/approval.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { approvedWorkspace, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

const ID = 'weather/offline-forecast';

// A review of the task at the current commit of the workspace's repo.
const reviewText = (w, rows, verdict) => `---
task: ${ID}
reviewed: 2026-11-07
head: ${sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim()}
---

| id | verdict | evidence |
| --- | --- | --- |
${rows.join('\n')}

${verdict}
`;

const ROWS = [
  '| AC-1 | met | file docs/offline.md:1 |',
  '| AC-2 | not met | file src/cache.ts:88: a fixed 24-hour format |',
  '| AC-3 | needs device | On a phone: restart the app offline; the forecast is still there |',
  '| E-1 | needs owner | Read: the age line reads naturally (evidence/S-4-wording.md) |',
];

test('k checklist lists exactly the needs device and needs owner rows of the latest review', async () => {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  const file = join(p.dir, 'checklist.md');
  assert.match(k(w.home, ['checklist', ID]).stderr, /has no review: kirunak\/tasks\/offline-forecast\/review\.md/);
  reviewsRan(p.dir, ['review.md', 'review-2.md']);
  writeFileSync(join(p.dir, 'review.md'), reviewText(w, ROWS, ''));
  assert.match(k(w.home, ['checklist', ID]).stderr, /review\.md is not a finished review; the checklist comes from one:\n {2}line 12: the last line is the verdict: verdict: not met \(AC-2\)/);
  writeFileSync(join(p.dir, 'review.md'), reviewText(w, ROWS, 'verdict: not met (AC-2)'));
  reviewsRan(p.dir, ['review.md', 'review-2.md']);
  const r = k(w.home, ['checklist', ID]);
  assert.equal(r.status, 0, r.stderr);
  const items = [
    '- [ ] AC-3 On a phone: restart the app offline; the forecast is still there (review.md)',
    '- [ ] E-1 Read: the age line reads naturally (evidence/S-4-wording.md) (review.md)',
  ];
  assert.equal(readFileSync(file, 'utf8'), items.join('\n') + '\n');
  assert.equal(r.stdout, `${file}: 2 items from review.md\n${items.join('\n')}\n`);

  // The owner ticks AC-3; a second review keeps E-1 for the owner and leaves AC-3's row with no evidence.
  writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] AC-3', '- [x] AC-3'));
  assert.equal(k(w.home, ['checklist', ID]).status, 0);
  assert.match(readFileSync(file, 'utf8'), /^- \[x\] AC-3 .*\(review\.md\)\n- \[ \] E-1/, 'an unchanged item keeps the owner\'s tick');
  const second = [ROWS[0], '| AC-2 | met | file docs/offline.md:1 |', '| AC-3 | needs device | |', ROWS[3]];
  writeFileSync(join(p.dir, 'review-2.md'), reviewText(w, second, 'verdict: needs owner (AC-3, E-1)'));
  reviewsRan(p.dir, ['review.md', 'review-2.md']);
  assert.equal(k(w.home, ['checklist', ID]).status, 0);
  assert.equal(readFileSync(file, 'utf8'), [
    '- [ ] AC-3 Both phone platforms keep the last forecast across a restart. (review-2.md)',
    '- [ ] E-1 Read: the age line reads naturally (evidence/S-4-wording.md) (review-2.md)',
  ].join('\n') + '\n', 'from the latest review only, each unticked: the owner checks it again');
});

test('k checklist run again keeps the owner\'s tick and words on an item line, and the lines that are not items', async () => {
  const w = await approvedWorkspace('');
  const file = join(w.p.dir, 'checklist.md');
  const rows = [ROWS[0], '| AC-2 | met | file docs/offline.md:1 |', ROWS[2], ROWS[3]];
  writeFileSync(join(w.p.dir, 'review.md'), reviewText(w, rows, 'verdict: needs owner (AC-3, E-1)'));
  reviewsRan(w.p.dir);
  assert.equal(k(w.home, ['checklist', ID]).status, 0);
  // The owner ticks AC-3 with a word on where it was done, and adds a note of their own.
  const owned = readFileSync(file, 'utf8').replace(/- \[ \] (AC-3 .*\(review\.md\))\n/, '- [x] $1, done on the Pixel 7, 7 Nov\n') + '\nAsk about E-1 before the release.\n';
  assert.match(owned, /^- \[x\] AC-3 .*\(review\.md\), done on the Pixel 7, 7 Nov\n- \[ \] E-1 .*\n\nAsk about E-1/);
  writeFileSync(file, owned);
  const r = k(w.home, ['checklist', ID]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(file, 'utf8'), owned, 'the tick, the owner\'s words and the note survive');
  assert.throws(() => accept({ ws: w.ws, id: ID }), /checklist\.md has 1 unticked item\(s\):\n {2}- \[ \] E-1 Read: /, 'the annotated line counts as AC-3\'s, ticked');
});

test('k checklist on a review with every row met writes an empty checklist', async () => {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  writeFileSync(join(p.dir, 'checklist.md'), '- [ ] E-1 from an older review (review.md)\n');
  const met = ROWS.map((r) => r.replace(/\| (not met|needs device|needs owner) \|.*$/, '| met | file docs/offline.md:1 |'));
  writeFileSync(join(p.dir, 'review.md'), reviewText(w, met, 'verdict: met'));
  reviewsRan(p.dir);
  const r = k(w.home, ['checklist', ID]);
  assert.equal(r.stdout, `${join(p.dir, 'checklist.md')}: 0 items from review.md\n`);
  assert.equal(readFileSync(join(p.dir, 'checklist.md'), 'utf8'), '');
});

test('k checklist refuses rows the owner should check that are not spelled as a verdict, and a review no step finished', async () => {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  reviewsRan(p.dir);
  const rows = [ROWS[0], '| AC-2 | met | file nowhere.ts:999 |', ROWS[2].replace('needs device', 'Needs device'), ROWS[3].replace('needs owner', 'needs owner: the wording')];
  writeFileSync(join(p.dir, 'review.md'), reviewText(w, rows, 'verdict: met'));
  const r = k(w.home, ['checklist', ID]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 10: AC-2: nowhere\.ts does not exist at head\n {2}line 11: AC-3: the verdict Needs device is not one of[^\n]*\n {2}line 12: E-1: the verdict needs owner: the wording/);
  assert.equal(existsSync(join(p.dir, 'checklist.md')), false, 'no empty checklist from it');
  writeFileSync(join(p.dir, 'review.md'), reviewText(w, ROWS, 'verdict: not met (AC-2)'));
  writeFileSync(join(p.dir, 'progress.md'), '2026-11-06 10:00 S-2 started (session r-1)\n');
  assert.match(k(w.home, ['checklist', ID]).stderr, /:\n {2}S-2, the review step that writes review\.md, has not finished \(running\)\n$/);
});

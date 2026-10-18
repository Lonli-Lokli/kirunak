import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskPaths } from '../lib/workspace.mjs';
import { k, makeWorkspace } from './helpers.mjs';

const ID = 'weather/offline-forecast';

const reviewText = (rows, verdict) => `---
task: ${ID}
reviewed: 2026-11-07
head: HEAD
---

| id | verdict | evidence |
| --- | --- | --- |
${rows.join('\n')}

${verdict}
`;

const ROWS = [
  '| AC-1 | met | test OfflineForecastTest.opens on the last forecast (test/forecast.test.ts:2) |',
  '| AC-2 | not met | file src/cache.ts:88: a fixed 24-hour format |',
  '| AC-3 | needs device | On a phone: restart the app offline; the forecast is still there |',
  '| E-1 | needs owner | Read: the age line reads naturally (evidence/S-4-wording.md) |',
];

test('k checklist lists exactly the needs device and needs owner rows of the latest review', async () => {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  const file = join(p.dir, 'checklist.md');
  assert.match(k(w.home, ['checklist', ID]).stderr, /has no review: kirunak\/tasks\/offline-forecast\/review\.md/);
  writeFileSync(join(p.dir, 'review.md'), reviewText(ROWS, ''));
  assert.match(k(w.home, ['checklist', ID]).stderr, /review\.md has no verdict yet/);
  writeFileSync(join(p.dir, 'review.md'), reviewText(ROWS, 'verdict: not met (AC-2)'));
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
  const second = [ROWS[0], '| AC-2 | met | file src/cache.ts:88 |', '| AC-3 | needs device | |', ROWS[3]];
  writeFileSync(join(p.dir, 'review-2.md'), reviewText(second, 'verdict: needs owner (AC-3, E-1)'));
  assert.equal(k(w.home, ['checklist', ID]).status, 0);
  assert.equal(readFileSync(file, 'utf8'), [
    '- [ ] AC-3 Both phone platforms keep the last forecast across a restart. (review-2.md)',
    '- [ ] E-1 Read: the age line reads naturally (evidence/S-4-wording.md) (review-2.md)',
  ].join('\n') + '\n', 'from the latest review only, each unticked: the owner checks it again');
});

test('k checklist on a review with every row met writes an empty checklist', async () => {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  writeFileSync(join(p.dir, 'checklist.md'), '- [ ] E-1 from an older review (review.md)\n');
  const met = ROWS.map((r) => r.replace(/\| (not met|needs device|needs owner) \|/, '| met |'));
  writeFileSync(join(p.dir, 'review.md'), reviewText(met, 'verdict: met'));
  const r = k(w.home, ['checklist', ID]);
  assert.equal(r.stdout, `${join(p.dir, 'checklist.md')}: 0 items from review.md\n`);
  assert.equal(readFileSync(join(p.dir, 'checklist.md'), 'utf8'), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accept } from '../lib/approval.mjs';
import * as steps from '../lib/steps.mjs';
import { approvedWorkspace, k, reviewsRan, sh } from './helpers.mjs';

// What kirunak gave a review, held to (gulnya/kirunak-review-base): k review check refuses a base other than the one
// it gave (AC-4) but for a review briefed before it kept one (E-5); k accept refuses a task whose change in another
// repo changed after the head the review saw there (AC-10).

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1
inputs: task
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

function work(dir, path, text, message) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
  sh(dir, 'git', ['add', '--', path]);
  sh(dir, 'git', ['commit', '-qm', message, '--', path]);
  return sh(dir, 'git', ['rev-parse', '--short', 'HEAD']).trim();
}

const headOf = (dir) => sh(dir, 'git', ['rev-parse', '--short', 'HEAD']).trim();
const firstOf = (w) => sh(w.weather, 'git', ['log', '--diff-filter=A', '--format=%h', '--', 'kirunak/approvals/offline-forecast.json']).trim();
const review = (w, base) => `---\ntask: ${w.id}\nhead: ${headOf(w.weather)}\n${base === null ? '' : `base: ${base}\n`}---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${['AC-1', 'AC-2', 'AC-3', 'E-1'].map((id) => `| ${id} | met | file docs/offline.md:1 |`).join('\n')}\n\nverdict: met\n`;
const given = (w) => join(w.p.dir, 'steps', 'S-2', 'given.json');

test('k review check, a review step\'s finish and k accept refuse a review whose base is not the one kirunak gave; one briefed before is not checked (AC-4, E-5)', async () => {
  const w = await approvedWorkspace(PLAN);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  work(w.weather, 'docs/offline.md', 'three days\n', `docs/offline.md (${w.id} S-1)`);
  mkdirSync(join(w.p.dir, 'evidence'), { recursive: true });
  writeFileSync(join(w.p.dir, 'steps', 'S-1', 'report.md'), 'done');
  writeFileSync(join(w.p.dir, 'evidence', 'S-1-cache-sizes.tsv'), 'x');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  const first = firstOf(w);
  const wrong = headOf(w.weather);
  const why = `the commit kirunak gave S-2, the task's first approval, where the review's diff starts`;

  writeFileSync(join(w.p.dir, 'review.md'), review(w, wrong));
  let r = k(w.home, ['review', 'check', w.id]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(`line 1: base ${wrong} is not ${first}, ${why}`) || r.stderr.includes(`line 1: base ${wrong} is not ${first}, ${why}`), r.stdout + r.stderr);
  r = k(w.home, ['step', 'finish', w.id, 'S-2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`base ${wrong} is not ${first}`));
  writeFileSync(join(w.p.dir, 'review.md'), review(w, null));
  r = k(w.home, ['review', 'check', w.id]);
  assert.ok((r.stdout + r.stderr).includes(`the front matter names no base: write base: ${first}, ${why}`), r.stdout + r.stderr);

  writeFileSync(join(w.p.dir, 'review.md'), review(w, first));
  assert.equal(k(w.home, ['review', 'check', w.id]).status, 0, 'the base given passes');
  const long = sh(w.weather, 'git', ['rev-parse', first]).trim();
  writeFileSync(join(w.p.dir, 'review.md'), review(w, long));
  assert.equal(k(w.home, ['review', 'check', w.id]).status, 0, 'and its full id');

  writeFileSync(join(w.p.dir, 'review.md'), review(w, wrong));
  reviewsRan(w.p.dir);
  assert.throws(() => accept({ ws: w.ws, id: w.id, dryRun: true }), new RegExp(`not a review k accept takes:\\n {2}line 1: base ${wrong} is not ${first}`));
  rmSync(given(w));
  assert.equal(k(w.home, ['review', 'check', w.id]).status, 0, 'a review briefed before kirunak kept its base is not checked');
  assert.equal(accept({ ws: w.ws, id: w.id, dryRun: true }).state, 'would accept');
});

test('k accept refuses a task whose change in another repo changed after the head the review saw there, naming the repo and the file (AC-10)', async () => {
  const w = await approvedWorkspace(PLAN);
  const other = 'weather/other-thing';
  work(w.weather, 'kirunak/tasks/other-thing/task.md', '# another task\n', `kirunak: intake ${other}`);
  work(w.weather, 'docs/offline.md', 'three days\n', `docs/offline.md (${w.id} S-1)`);
  sh(w.hub, 'git', ['checkout', '-qb', 'offline-forecast']);
  work(w.hub, 'tools/cache.txt', 'cache\n', 'tools/cache.txt: on the task\'s branch, naming nothing');
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  sh(w.hub, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge the branch', 'offline-forecast']);
  await steps.brief({ ws: w.ws, id: w.id, step: 'S-2', session: 'rev-1' });
  writeFileSync(join(w.p.dir, 'review.md'), review(w, firstOf(w)));
  reviewsRan(w.p.dir);
  const ok = () => assert.equal(accept({ ws: w.ws, id: w.id, dryRun: true }).state, 'would accept');
  const refused = (rows) => assert.throws(() => accept({ ws: w.ws, id: w.id, dryRun: true }), (e) => {
    assert.match(e.message, /its work changed after review\.md's head \w+ \(in hub, after the head it saw there\), in \d+ file\(s\) the review never saw/);
    assert.deepEqual(e.blocking.map((x) => `${x.path}  ${x.commit}  ${x.task}`), rows);
    for (const x of rows) assert.ok(e.message.includes(`\n  ${x}`), x);
    return true;
  });
  const undo = () => sh(w.hub, 'git', ['reset', '-q', '--hard', 'HEAD~1']);
  ok();

  work(w.hub, 'tools/other.txt', 'other\n', `tools/other.txt (${other})`);
  ok();
  const b = work(w.hub, 'tools/cache.txt', 'cache, reworded\n', `tools/cache.txt reworded (${other})`);
  refused([`hub:tools/cache.txt  ${b}  ${other}`]);
  undo();
  const a = work(w.hub, 'tools/new.txt', 'new\n', `tools/new.txt (${w.id})`);
  refused([`hub:tools/new.txt  ${a}  ${w.id}`]);
  undo();
  ok();
  sh(w.hub, 'git', ['checkout', '-qb', 'later']);
  const c = work(w.hub, 'tools/later.txt', 'later\n', `tools/later.txt (${w.id})`);
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  refused([`hub:tools/later.txt  ${c}  ${w.id}`]);
  writeFileSync(join(w.p.dir, 'repos.md'), '- nowhere main\n');
  assert.throws(() => accept({ ws: w.ws, id: w.id, dryRun: true }), /repos\.md names what kirunak cannot read, so it cannot be accepted:\n {2}line 1, "- nowhere main"/);
  rmSync(join(w.p.dir, 'repos.md'));
  rmSync(given(w));
  ok();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from '../lib/steps.mjs';
import { holdOf, progressText } from '../lib/held.mjs';
import { parsePlan, releaseRun } from '../lib/plan.mjs';
import { approvedWorkspace, k, sh } from './helpers.mjs';

// A release run keeps the tree clean (orchestrator.md §2; the bug gulnya/step-records-void-release-receipts): while
// steps marked `clean-tree: yes` run, a release gate that reads `git status --porcelain --untracked-files=no` and
// `git rev-parse HEAD` (gulnya tools/ios-smoke.mjs, the legacy gate) sees no tracked change and the same commit from
// the run's first start to its last finish, and then the run's records committed.

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, E-1, D-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md
budget: 80 calls

### S-2 Check the build on the devices [agent]
needs: S-1
covers: AC-1
inputs: task
outputs: steps/S-2/report.md, evidence/S-2-receipt.txt
clean-tree: yes

### S-3 Upload the build [agent]
needs: S-2
covers: AC-2
inputs: task
outputs: steps/S-3/report.md
clean-tree: yes

### S-4 Review [review]
needs: S-3
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

const put = (w, rel, text = 'x') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};
// The stand-in release gate: what ios-smoke.mjs's treeState reads.
const gate = (w) => ({ dirty: sh(w.weather, 'git', ['status', '--porcelain', '--untracked-files=no']).trim(), head: sh(w.weather, 'git', ['rev-parse', 'HEAD']).trim() });
const ok = (r) => assert.equal(r.status, 0, r.stderr);
const statesOf = (w) => Object.fromEntries([...steps.load(w.ws, w.id).states].map(([s, v]) => [s, v.state]));
const atHead = (w, rel) => sh(w.weather, 'git', ['show', `HEAD:${w.p.rel(rel)}`]);

// S-1 run and finished as any step is, so progress.md is tracked before the release run starts.
async function built() {
  const w = await approvedWorkspace(PLAN);
  ok(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'b-1']));
  put(w, 'steps/S-1/report.md');
  ok(k(w.home, ['step', 'finish', w.id, 'S-1']));
  sh(w.weather, 'git', ['add', w.p.rel('plan.md')]);
  sh(w.weather, 'git', ['commit', '-q', '-m', 'the plan']);
  return w;
}

test('clean-tree: yes parses, and the release run is the marked steps next to each other', () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.steps.map((s) => s.cleanTree), [false, true, true, false]);
  assert.deepEqual(plan.problems ?? [], []);
  assert.deepEqual(releaseRun(plan, 'S-2'), ['S-2', 'S-3']);
  assert.deepEqual(releaseRun(plan, 'S-3'), ['S-2', 'S-3']);
  assert.deepEqual(releaseRun(plan, 'S-1'), []);
  assert.match(parsePlan(PLAN.replace('clean-tree: yes\n\n### S-3', 'clean-tree: maybe\n\n### S-3')).problems.map((x) => x.problem).join('\n'), /clean-tree is `yes` or left out/);
});

test('a release run leaves the tree clean and HEAD where it was until its last step finishes, a failure and a retry included; then its records are committed', async () => {
  const w = await built();
  const before = gate(w);
  assert.equal(before.dirty, '', 'the tree is clean before the release run');
  const same = (when) => assert.deepEqual(gate(w), before, `the gate sees a clean tree at the same commit ${when}`);

  ok(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rel-1']));
  same('after S-2 starts');
  assert.deepEqual(holdOf(w.p.dir).run, ['S-2', 'S-3']);
  put(w, 'evidence/S-2-receipt.txt', 'device run 1\n');
  ok(k(w.home, ['step', 'fail', w.id, 'S-2', '--why', 'the emulator went away']));
  same('after S-2 fails');
  assert.equal(statesOf(w)['S-2'], 'ready', 'a fresh process reads the failure from the hold');

  ok(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rel-2']));
  same('after S-2 starts again');
  put(w, 'steps/S-2/report.md');
  put(w, 'evidence/S-2-receipt.txt', 'device run 2\n');
  ok(k(w.home, ['step', 'finish', w.id, 'S-2']));
  same('after S-2 finishes');
  assert.deepEqual(statesOf(w), { 'S-1': 'done', 'S-2': 'done', 'S-3': 'ready', 'S-4': 'pending' });

  ok(k(w.home, ['step', 'start', w.id, 'S-3', '--session', 'rel-3']));
  same('after S-3 starts');
  put(w, 'steps/S-3/report.md');
  ok(k(w.home, ['step', 'finish', w.id, 'S-3']));

  const after = gate(w);
  assert.equal(after.dirty, '', 'the records are committed, not left changed');
  assert.notEqual(after.head, before.head, 'the run\'s last finish commits');
  assert.equal(holdOf(w.p.dir), null, 'the hold is gone');
  const lines = atHead(w, 'progress.md').split('\n').filter(Boolean).map((l) => l.slice(17));
  assert.deepEqual(lines, [
    'S-1 started (session b-1)', 'S-1 finished',
    'S-2 started (session rel-1)', 'S-2 failed: the emulator went away',
    'S-2 started (session rel-2)', 'S-2 finished',
    'S-3 started (session rel-3)', 'S-3 finished',
  ]);
  for (const rel of ['steps/S-2/report.md', 'steps/S-2/failure-1.md', 'steps/S-3/report.md']) assert.ok(atHead(w, rel), rel);
  assert.equal(atHead(w, 'evidence/S-2-receipt.txt'), 'device run 2\n');
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain', '--', w.p.rel('steps/S-2'), w.p.rel('steps/S-3'), w.p.rel('evidence')]).trim(), '');
  const log = sh(w.weather, 'git', ['log', '--format=%s', `${before.head}..HEAD`]).trim().split('\n');
  assert.deepEqual(log, [`${w.id} S-3: the release steps' records (S-2, S-3)`, `${w.id} S-3: the release steps' evidence (S-2, S-3)`]);
  assert.deepEqual(statesOf(w), { 'S-1': 'done', 'S-2': 'done', 'S-3': 'done', 'S-4': 'ready' });
});

test('a release step will not start on a tree with a tracked change, and a session that lost its context reads the held lines', async () => {
  const w = await built();
  writeFileSync(join(w.weather, 'README.md'), 'changed\n');
  const r = k(w.home, ['step', 'start', w.id, 'S-2']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /S-2 is a release step \(clean-tree: yes\).*README\.md/s);
  assert.equal(holdOf(w.p.dir), null);
  sh(w.weather, 'git', ['checkout', '--', 'README.md']);

  ok(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rel-1']));
  assert.match(progressText(w.p.dir), /S-1 finished\n.* S-2 started \(session rel-1\)\n$/);
  assert.doesNotMatch(readFileSync(join(w.p.dir, 'progress.md'), 'utf8'), /S-2/);
  assert.match(k(w.home, ['step', 'start', w.id, 'S-2']).stderr, /S-2 is running/);
});

test('k records ends a hold whose run will not finish: the held lines and the step folders committed', async () => {
  const w = await built();
  ok(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rel-1']));
  ok(k(w.home, ['step', 'fail', w.id, 'S-2', '--why', 'the store is down']));
  const r = k(w.home, ['records', w.id]);
  ok(r);
  assert.equal(holdOf(w.p.dir), null);
  assert.equal(gate(w).dirty, '');
  assert.match(atHead(w, 'progress.md'), /S-2 started \(session rel-1\)\n.* S-2 failed: the store is down\n$/);
  assert.ok(existsSync(join(w.p.dir, 'steps', 'S-2', 'failure-1.md')));
  assert.ok(atHead(w, 'steps/S-2/failure-1.md'));
});

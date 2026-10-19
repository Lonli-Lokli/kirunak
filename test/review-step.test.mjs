import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecord } from '../lib/approval.mjs';
import { run } from '../lib/run.mjs';
import * as steps from '../lib/steps.mjs';
import { approvedWorkspace, k, sh } from './helpers.mjs';

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, AC-3, E-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

const NO_SESSION = { CLAUDE_CODE_SESSION_ID: '' };
const put = (w, rel, text = 'x') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};

// The invented task with S-1 done, its report and evidence written, and notes beside them.
async function implemented(plan = PLAN) {
  const w = await approvedWorkspace(plan);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  put(w, 'steps/S-1/report.md', 'the implementer says it all works');
  put(w, 'evidence/S-1-cache-sizes.tsv', 'days\tbytes\n3\t2048\n');
  put(w, 'notes.md', 'a dead end');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  return w;
}

test('a review step refuses an input outside the three, an output with no review file, and a start with no session', async () => {
  const w = await implemented(PLAN.replace('inputs: task, diff, evidence/', 'inputs: task, diff, evidence/, steps/S-1/report.md'));
  const outside = /S-2 is a review: steps\/S-1\/report\.md is outside its three inputs \(task, diff, evidence\/\)/;
  assert.match(k(w.home, ['step', 'brief', w.id, 'S-2']).stderr, outside);
  assert.match(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).stderr, outside);
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN.replace('outputs: review.md', 'outputs: steps/S-2/notes.md'));
  assert.match(k(w.home, ['step', 'brief', w.id, 'S-2']).stderr, /S-2 is a review: its outputs name no review file/);
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN);
  const r = k(w.home, ['step', 'start', w.id, 'S-2'], NO_SESSION);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /S-2 is a review: it runs in a fresh conversation, so it starts with its --session/);
  assert.match(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'impl-1']).stderr, /session impl-1 is S-1's/);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  assert.deepEqual(readdirSync(join(w.p.dir, 'steps', 'S-2', 'in')).sort(), ['diff.patch', 'evidence', 'task.md'], 'a start with no brief copies the inputs');
});

test('the review brief copies the three inputs into in/ and names only that folder', async () => {
  const w = await implemented();
  writeFileSync(join(w.weather, 'docs', 'offline.md'), 'the cache keeps three days\n');
  sh(w.weather, 'git', ['commit', '-qam', 'the work']);
  const r = k(w.home, ['step', 'brief', w.id, 'S-2', '--session', 'rev-1']);
  assert.equal(r.status, 0, r.stderr);
  const dir = join(w.p.dir, 'steps', 'S-2');
  assert.deepEqual(readdirSync(join(dir, 'in')).sort(), ['diff.patch', 'evidence', 'task.md']);
  assert.equal(readFileSync(join(dir, 'in', 'task.md'), 'utf8'), readFileSync(w.p.task, 'utf8'));
  assert.deepEqual(readdirSync(join(dir, 'in', 'evidence')), ['S-1-cache-sizes.tsv']);
  const patch = readFileSync(join(dir, 'in', 'diff.patch'), 'utf8');
  assert.match(patch, /\+the cache keeps three days/);
  assert.equal(patch, readFileSync(join(dir, 'diff.patch'), 'utf8'));

  const text = readFileSync(join(dir, 'brief.md'), 'utf8');
  const task = readFileSync(w.p.task, 'utf8').split('\n');
  for (const id of ['AC-1', 'AC-2', 'AC-3', 'E-1', 'O-1']) assert.ok(text.includes(task.find((l) => l.startsWith(`- ${id} `))), `${id} verbatim`);
  assert.ok(!text.includes('- D-1 '), 'the decisions are not the reviewer\'s lines');
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const base = readRecord(w.weather, 'offline-forecast').commit;
  for (const s of ['`kirunak/tasks/offline-forecast/steps/S-2/in/task.md`', '`kirunak/tasks/offline-forecast/steps/S-2/in/diff.patch`',
    '`kirunak/tasks/offline-forecast/steps/S-2/in/evidence/`', 'Write `kirunak/tasks/offline-forecast/review.md`', `task: ${w.id}`, `head: ${head}`,
    `base: ${base}`, 'session: rev-1', 'never guess', '`needs device` or `needs owner`', 'k review check weather/offline-forecast']) {
    assert.ok(text.includes(s), s);
  }
  assert.doesNotMatch(text, /steps\/S-1|offline-forecast\/notes\.md|offline-forecast\/progress\.md|offline-forecast\/plan\.md|\{\{/);

  // A retry's failure report is copied in beside them, and in/ is written afresh.
  put(w, 'steps/S-2/failure-1.md', '# failed');
  await steps.brief({ ws: w.ws, id: w.id, step: 'S-2', extraInputs: ['kirunak/tasks/offline-forecast/steps/S-2/failure-1.md'] });
  assert.deepEqual(readdirSync(join(dir, 'in')).sort(), ['diff.patch', 'evidence', 'failure-1.md', 'task.md']);
  assert.match(readFileSync(join(dir, 'brief.md'), 'utf8'), /`kirunak\/tasks\/offline-forecast\/steps\/S-2\/in\/failure-1\.md`: the last attempt failed/);
});

test('a review\'s diff leaves out the task folder: committed notes, a step\'s report and progress are not in in/diff.patch', async () => {
  const w = await implemented();
  writeFileSync(join(w.weather, 'docs', 'offline.md'), 'the cache keeps three days\n');
  sh(w.weather, 'git', ['add', '-A']);
  sh(w.weather, 'git', ['commit', '-qm', 'the work and the implementer\'s account']);
  const committed = sh(w.weather, 'git', ['show', '--name-only', '--format=', 'HEAD']);
  for (const f of ['notes.md', 'steps/S-1/report.md', 'progress.md']) assert.ok(committed.includes(`kirunak/tasks/offline-forecast/${f}`), f);
  assert.equal(k(w.home, ['step', 'brief', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  const patch = readFileSync(join(w.p.dir, 'steps', 'S-2', 'in', 'diff.patch'), 'utf8');
  assert.match(patch, /\+the cache keeps three days/);
  assert.doesNotMatch(patch, /a dead end|the implementer says it all works|S-1 started|kirunak\/tasks\/offline-forecast/);
});

test('a review step finishes only when its review passes k review check', async () => {
  const w = await implemented();
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const rows = ['AC-1', 'AC-2', 'AC-3', 'E-1'].map((id) => `| ${id} | met | file docs/offline.md:1 |`);
  const review = (r) => `---\ntask: ${w.id}\nhead: ${head}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${r.join('\n')}\n\nverdict: met\n`;
  put(w, 'review.md', review(rows.slice(1)));
  const bad = k(w.home, ['step', 'finish', w.id, 'S-2']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /S-2: review\.md fails k review check:\n {2}line 6: AC-1 has no row: one row per AC and E\n$/);
  put(w, 'review.md', review(rows));
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-2']).status, 0);
  assert.equal(steps.load(w.ws, w.id).states.get('S-2').state, 'done');
});

test('k run runs a review in a fresh conversation on models.review; a review that fails the grammar fails, and the retry reads why', async () => {
  const w = await approvedWorkspace(PLAN);
  w.ws.models = { review: { model: 'opus', effort: 'high' } };
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const rows = ['AC-1', 'AC-2', 'AC-3', 'E-1'].map((id) => `| ${id} | met | file docs/offline.md:1 |`);
  const review = (r) => `---\ntask: ${w.id}\nhead: ${head}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${r.join('\n')}\n\nverdict: met\n`;
  const calls = [];
  w.ws.seams.runner = {
    start(step) {
      const n = calls.push(step);
      const child = spawn('sleep', ['0.05'], { detached: true });
      const done = new Promise((resolve) => child.on('exit', () => {
        if (step.env.KIRUNAK_STEP === 'S-1') for (const o of ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv']) put(w, o);
        else put(w, 'review.md', review(n === 2 ? rows.slice(1) : rows));
        resolve({ exitCode: 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: step.sessionId, total_cost_usd: 0.1 } });
      }));
      return { pid: child.pid, sessionId: step.sessionId, done };
    },
    keepAlive: () => null,
  };
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  assert.deepEqual(r.states, { 'S-1': 'done', 'S-2': 'done' });
  assert.equal(calls.length, 3);
  const [impl, first, retry] = calls;
  assert.deepEqual([impl.model, first.model, first.effort, retry.model], [null, 'opus', 'high', 'opus']);
  for (const c of [first, retry]) {
    assert.equal(c.resume, null);
    assert.notEqual(c.sessionId, impl.sessionId);
    assert.deepEqual(c.addDirs, []);
    assert.match(c.prompt, /^# weather\/offline-forecast S-2: Review\n/);
    assert.ok(c.prompt.includes(`session: ${c.sessionId}`));
  }
  assert.notEqual(first.sessionId, retry.sessionId);
  const dir = join(w.p.dir, 'steps', 'S-2');
  const failure = readFileSync(join(dir, 'failure-1.md'), 'utf8');
  assert.match(failure, /S-2 failed\n\n.*: review\.md fails k review check \(1 problem\)\n\nExit code 0, session .*\n\nk review check:\n\n- line 6: AC-1 has no row: one row per AC and E\n$/);
  assert.match(retry.prompt, /`kirunak\/tasks\/offline-forecast\/steps\/S-2\/in\/failure-1\.md`: the last attempt failed/);
  assert.equal(readFileSync(join(dir, 'in', 'failure-1.md'), 'utf8'), failure);
});

test('an output check that throws fails the step, so the retry and [escalate] apply, never leaving it running', async () => {
  const w = await approvedWorkspace(PLAN);
  w.ws.seams.runner = {
    start(step) {
      const child = spawn('sleep', ['0.05'], { detached: true });
      const done = new Promise((resolve) => child.on('exit', () => {
        if (step.env.KIRUNAK_STEP === 'S-1') for (const o of ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv']) put(w, o);
        else mkdirSync(join(w.p.dir, 'review.md'), { recursive: true });
        resolve({ exitCode: 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: step.sessionId, total_cost_usd: 0.1 } });
      }));
      return { pid: child.pid, sessionId: step.sessionId, done };
    },
    keepAlive: () => null,
  };
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  assert.match(r.stopped, /^S-2 is marked \[escalate\]/);
  const progress = readFileSync(join(w.p.dir, 'progress.md'), 'utf8');
  assert.equal((progress.match(/S-2 failed: kirunak stopped the step: EISDIR/g) || []).length, 2);
  assert.ok(!/S-2 finished/.test(progress));
});

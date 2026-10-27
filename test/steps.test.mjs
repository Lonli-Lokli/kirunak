import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from '../lib/steps.mjs';
import { hold } from '../lib/approval.mjs';
import { approvedWorkspace, k, sh } from './helpers.mjs';

export const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, E-1, D-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv
budget: 80 calls

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

const put = (w, rel, text = 'x') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};
const progress = (w) => readFileSync(join(w.p.dir, 'progress.md'), 'utf8');
const statesOf = (w) => Object.fromEntries([...steps.load(w.ws, w.id).states].map(([s, v]) => [s, v.state]));

test('the states from the files: ready and pending, running, then done', async () => {
  const w = await approvedWorkspace(PLAN);
  assert.deepEqual(statesOf(w), { 'S-1': 'ready', 'S-2': 'pending' });
  assert.equal(steps.load(w.ws, w.id).states.get('S-2').why, 'S-1 is not done, evidence/ does not exist');
  const r = k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'abc-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(progress(w), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} S-1 started \(session abc-1\)\n$/);
  assert.deepEqual(statesOf(w), { 'S-1': 'running', 'S-2': 'pending' });
  assert.match(k(w.home, ['step', 'start', w.id, 'S-1']).stderr, /S-1 is running/);
  const missing = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /has not written steps\/S-1\/report\.md, evidence\/S-1-cache-sizes\.tsv/);
  put(w, 'steps/S-1/report.md');
  put(w, 'evidence/S-1-cache-sizes.tsv');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  assert.deepEqual(statesOf(w), { 'S-1': 'done', 'S-2': 'ready' });
});

test('the brief quotes the goal and the covered lines, names the paths and the rules', async () => {
  const w = await approvedWorkspace(PLAN);
  const r = k(w.home, ['step', 'brief', w.id, 'S-1']);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(w.p.dir, 'steps', 'S-1', 'brief.md'), 'utf8');
  const task = readFileSync(w.p.task, 'utf8');
  for (const id of ['AC-1', 'AC-2', 'E-1', 'D-1']) {
    const line = task.split('\n').find((l) => l.startsWith(`- ${id} `));
    assert.ok(text.includes(line), `${id} quoted verbatim`);
  }
  assert.ok(!text.includes('- AC-3 '), 'a line the step does not cover is left out');
  assert.ok(text.includes(task.split('\n').find((l) => l.startsWith('With no network'))));
  for (const s of ['- task: kirunak/tasks/offline-forecast/task.md', '- docs/offline.md', '- kirunak/tasks/offline-forecast/evidence/S-1-cache-sizes.tsv',
    'about 80 calls', 'kirunak/tasks/offline-forecast/steps/S-1/needs.json', '"then": "resume"', '{ "owner": "<the question>" }', 'No agents.',
    'kirunak/tasks/offline-forecast/steps/S-1/report.md`, at most a page']) {
    assert.ok(text.includes(s), s);
  }
  assert.doesNotMatch(text, /\{\{/);
});

test('a review step refuses a session another step ran, and starts in a fresh one', async () => {
  const w = await approvedWorkspace(PLAN);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-7']).status, 0);
  put(w, 'steps/S-1/report.md');
  put(w, 'evidence/S-1-cache-sizes.tsv');
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: 'impl-8', num_turns: 1 }));
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  for (const shared of ['impl-7', 'impl-8']) {
    const r = k(w.home, ['step', 'start', w.id, 'S-2', '--session', shared]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`S-2 is a review: it runs in a fresh conversation, and session ${shared} is S-1's`));
  }
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'fresh-1']).status, 0);
  const patch = readFileSync(join(w.p.dir, 'steps', 'S-2', 'diff.patch'), 'utf8');
  assert.equal(typeof patch, 'string', 'the diff from the approved commit is written for the review');
});

test('a second failure leaves the step failed for k run to climb; past the top, escalate marks it [escalate] and names every report', async () => {
  const w = await approvedWorkspace(PLAN);
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
  const one = steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'the cache test does not build' });
  assert.deepEqual(Object.keys(one), ['report', 'failures'], 'fail climbs nothing');
  assert.equal(one.failures, 1);
  assert.match(readFileSync(one.report, 'utf8'), /S-1 failed\n\n.*: the cache test does not build/);
  assert.deepEqual(statesOf(w), { 'S-1': 'ready', 'S-2': 'pending' });
  assert.deepEqual(steps.load(w.ws, w.id).states.get('S-1').retry, { reports: ['steps/S-1/failure-1.md'], rung: null, phase: 'build', design: null });
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
  assert.equal(steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'still' }).failures, 2);
  assert.deepEqual([statesOf(w)['S-1'], steps.load(w.ws, w.id).states.get('S-1').why], ['failed', 'failed 2 times']);
  assert.doesNotMatch(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /\[escalate/, 'plan.md changes only at the stop');
  const e = steps.escalate({ ws: w.ws, id: w.id, step: 'S-1' });
  assert.deepEqual(e, { failures: ['steps/S-1/failure-1.md', 'steps/S-1/failure-2.md'], last: 'steps/S-1/failure-2.md', why: 'failed on every rung (sonnet 2)' });
  const plan = readFileSync(join(w.p.dir, 'plan.md'), 'utf8');
  assert.match(plan, /^### S-1 Keep the last forecast on disk \[agent\] \[escalate\]\n(?:.+\n)*failures: steps\/S-1\/failure-1\.md, steps\/S-1\/failure-2\.md\n\n### S-2 /m);
  assert.deepEqual(steps.load(w.ws, w.id).plan.steps[0].failures, ['steps/S-1/failure-1.md', 'steps/S-1/failure-2.md']);
  assert.match(progress(w), /S-1 escalated: stopped for the owner, failed on every rung \(sonnet 2\)\n$/);
  assert.equal(statesOf(w)['S-1'], 'escalated');
  const event = JSON.parse(readFileSync(join(w.home, 'events.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual({ ...event, time: 0 }, { time: 0, kind: 'escalate', trigger: 'k run failure count', task: 'weather/offline-forecast', step: 'S-1', failures: 2, from: { model: 'sonnet' }, to: null, stopped: true });
  // The owner's session takes the mark off: the step is tried again, fresh.
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN);
  assert.deepEqual(statesOf(w), { 'S-1': 'ready', 'S-2': 'pending' });
  assert.equal(steps.load(w.ws, w.id).states.get('S-1').retry, null);
});

test('a stop of k run is not one of the step\'s two failures and writes no report; the retry after it reads the last own one', async () => {
  const w = await approvedWorkspace(PLAN);
  const failOnce = async (why) => (await steps.start({ ws: w.ws, id: w.id, step: 'S-1' }), steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why }));
  const dir = join(w.p.dir, 'steps', 'S-1');
  const reports = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /^failure-/.test(f)) : []);
  const retry = () => steps.load(w.ws, w.id).states.get('S-1').retry;
  // Stopped twice while it ran: retried, not failed, no report written, and no retry is told an attempt failed.
  for (const why of [steps.STOPPED.bySignal('SIGINT'), steps.STOPPED.orphan]) {
    const r = await failOnce(why);
    assert.deepEqual([r.failures, r.report, statesOf(w)['S-1'], retry()], [0, null, 'ready', null], why);
  }
  assert.deepEqual(reports(), []);
  // One failure of its own, then a stop: still retried, and the retry still reads the own failure's report.
  assert.equal((await failOnce('the cache test does not build')).failures, 1);
  assert.deepEqual(retry().reports, ['steps/S-1/failure-1.md']);
  assert.equal((await failOnce(steps.STOPPED.bySignal('SIGTERM'))).failures, 1);
  assert.deepEqual([statesOf(w)['S-1'], steps.historyOf(progress(w), 'S-1').failures, retry().reports], ['ready', 1, ['steps/S-1/failure-1.md']]);
  assert.deepEqual(reports(), ['failure-1.md']);
  // A second failure of its own fails it, the stops between them aside: k run climbs it.
  assert.equal((await failOnce('still')).failures, 2);
  assert.equal(statesOf(w)['S-1'], 'failed');
  assert.equal(steps.isStop('k run was stopped by hand, it said'), false);
});

test('k step fail refuses a stop\'s words, so a failure given by hand always counts', async () => {
  const w = await approvedWorkspace(PLAN);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  for (const why of ['k run was stopped (SIGINT)', '  the k run   that started it stopped ']) {
    const r = k(w.home, ['step', 'fail', w.id, 'S-1', '--why', why]);
    assert.equal(r.status, 1, why);
    assert.match(r.stderr, /is k run's own reason for a stop; say what went wrong/);
  }
  assert.doesNotMatch(progress(w), /failed/);
  assert.equal(k(w.home, ['step', 'fail', w.id, 'S-1', '--why', 'k run was stopped, then the build broke']).status, 0);
  assert.equal(steps.historyOf(progress(w), 'S-1').failures, 1);
});

test('a step\'s needs.json takes the name it keeps as its run ends: k step fail moves it and its report says so; k step finish moves it too', async () => {
  const w = await approvedWorkspace(PLAN);
  const requests = () => readdirSync(join(w.p.dir, 'steps', 'S-1')).filter((f) => f.startsWith('needs')).sort();
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  put(w, 'steps/S-1/needs-1.json', '{}');
  put(w, 'steps/S-1/needs.json', '{"owner":"Three days or a week?"}');
  assert.equal(k(w.home, ['step', 'fail', w.id, 'S-1', '--why', 'the owner chose another way']).status, 0);
  assert.deepEqual(requests(), ['needs-1.json', 'needs-2.json']);
  assert.match(readFileSync(join(w.p.dir, 'steps', 'S-1', 'failure-1.md'), 'utf8'), /\nIts needs\.json is now \S*steps\/S-1\/needs-2\.json\.\n$/);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  put(w, 'steps/S-1/needs.json', '{"owner":"Keep a week?"}');
  for (const o of ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv']) put(w, o);
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  assert.deepEqual(requests(), ['needs-1.json', 'needs-2.json', 'needs-3.json']);
});

test('a step starts only on a task that may run: approved, queued, not on hold, a plan that passes', async () => {
  const w = await approvedWorkspace(PLAN.replace('covers: all\n', 'covers: E-1\n'));
  assert.match(k(w.home, ['step', 'start', w.id, 'S-1']).stderr, /cannot run a step:\n  plan\.md line 1: AC-3 is covered by no step/);
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN.replace('blocked-by: []', 'blocked-by: [weather/other]'));
  assert.match(k(w.home, ['step', 'start', w.id, 'S-1']).stderr, /blocked by weather\/other, which is not done/);
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN);
  hold({ ws: w.ws, id: w.id, why: 'waiting for the provider' });
  assert.match(k(w.home, ['step', 'start', w.id, 'S-1']).stderr, /is on hold/);
  assert.equal(existsSync(join(w.p.dir, 'progress.md')), false);
});

test('needs.json: heavy and owner requests parse, anything else is an error a run fails on', async () => {
  const w = await approvedWorkspace(PLAN);
  const dir = join(w.p.dir, 'steps', 'S-1');
  const needs = (x) => {
    put(w, 'steps/S-1/needs.json', typeof x === 'string' ? x : JSON.stringify(x));
    return steps.readNeeds(dir);
  };
  assert.deepEqual(needs({ heavy: { what: 'tests', command: ['npm', 'test'], maxMinutes: 10 }, then: 'resume' }).heavy.command, ['npm', 'test']);
  assert.deepEqual(needs({ owner: ' Three days or a week? ' }), { owner: 'Three days or a week?' });
  assert.match(needs({ heavy: { what: 'tests', command: 'npm test' } }).error, /heavy wants/);
  assert.match(needs('{').error, /not JSON/);
  assert.match(needs({}).error, /neither heavy nor owner/);
});

test('k step finish commits the evidence the step wrote and nothing else; a review then cites it at head; no evidence, no commit', async () => {
  const w = await approvedWorkspace(PLAN);
  const git = (...args) => sh(w.weather, 'git', args).trim();
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  put(w, 'steps/S-1/report.md');
  put(w, 'evidence/S-1-cache-sizes.tsv', 'days\tbytes\n3\t2048\n');
  writeFileSync(join(w.weather, 'docs', 'staged.md'), 'staged by the session\n');
  git('add', 'docs/staged.md');
  const before = git('rev-parse', 'HEAD');
  const r = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(git('rev-parse', 'HEAD'), before);
  assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'),
    'weather/offline-forecast S-1: the step\'s evidence\n\nkirunak/tasks/offline-forecast/evidence/S-1-cache-sizes.tsv');
  assert.equal(git('diff', '--cached', '--name-only'), 'docs/staged.md', 'what else was staged stays staged');

  const head = git('rev-parse', '--short', 'HEAD');
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  const rows = ['AC-1', 'AC-2', 'AC-3'].map((id) => `| ${id} | met | file docs/offline.md:1 |`);
  rows.push('| E-1 | met | measure evidence/S-1-cache-sizes.tsv row 2 |');
  // The base kirunak gave the review, the task's first approval (kirunak-review-base AC-4).
  const base = git('log', '--diff-filter=A', '--format=%h', '--', 'kirunak/approvals/offline-forecast.json');
  put(w, 'review.md', `---\ntask: ${w.id}\nhead: ${head}\nbase: ${base}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n\nverdict: met\n`);
  const done = k(w.home, ['step', 'finish', w.id, 'S-2']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('rev-parse', '--short', 'HEAD'), head, 'a finish with no new or changed evidence makes no commit');
  assert.equal(git('diff', '--cached', '--name-only'), 'docs/staged.md');
});

test('a finish whose evidence commit git refuses fails with git\'s message, and the step stays running', async () => {
  const w = await approvedWorkspace(PLAN);
  writeFileSync(join(w.weather, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "the repo takes no commits now" >&2\nexit 1\n', { mode: 0o755 });
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  put(w, 'steps/S-1/report.md');
  put(w, 'evidence/S-1-cache-sizes.tsv');
  const r = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git commit in .* failed: the repo takes no commits now/);
  assert.doesNotMatch(progress(w), /S-1 finished/);
  assert.equal(steps.load(w.ws, w.id).states.get('S-1').state, 'running');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from '../lib/steps.mjs';
import { hold } from '../lib/approval.mjs';
import { approvedWorkspace, events, k, repeatedWorkspace, sh } from './helpers.mjs';

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

// The plan's header (its text above the first step) and a step's `what:` line, quoted in its brief and its design
// brief, never in a review's (gulnya/brief-what-and-header).
const HEADER_TEXT = '# The plan\n\nRules for every step: build at the lock, keep images out of git.';
const WHAT = 'what: cache the forecast in one JSON file, written after every fetch';
const PLAN_WITH_HEADER = PLAN.replace('---\n\n### S-1', `---\n\n${HEADER_TEXT}\n\n### S-1`).replace('budget: 80 calls\n', `budget: 80 calls\n${WHAT}\n`);

test('the brief and the design brief quote the step\'s what line and the plan\'s header; with neither, no heading', async () => {
  const w = await approvedWorkspace(PLAN_WITH_HEADER);
  const what = `## What this step does, quoted from the plan\n\n${WHAT.slice('what: '.length)}\n`;
  const header = `## The plan's rules for every step, quoted from the plan\n\n${HEADER_TEXT}\n`;
  const built = (await steps.brief({ ws: w.ws, id: w.id, step: 'S-1' })).text;
  const designed = (await steps.brief({ ws: w.ws, id: w.id, step: 'S-1', retry: { reports: [], rung: w.ws.ladder[1], phase: 'design', design: null } })).text;
  for (const text of [built, designed]) {
    assert.ok(text.includes(`then stop.\n\n${what}\n${header}\n## The task's goal`), text);
    assert.doesNotMatch(text, /\{\{/);
  }
  const plain = await approvedWorkspace(PLAN);
  const none = (await steps.brief({ ws: plain.ws, id: plain.id, step: 'S-1' })).text;
  assert.doesNotMatch(none, /What this step does|The plan's rules|\{\{/);
  assert.match(none, /then stop\.\n\n## The task's goal/);
  const review = (await steps.brief({ ws: w.ws, id: w.id, step: 'S-2', session: 'rev-1' })).text;
  assert.doesNotMatch(review, /What this step does|The plan's rules|build at the lock/, 'a review may not read plan.md');
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
  for (const why of ['k run was stopped (SIGINT)', '  the k run   that started it stopped ', 'unfinished: two tests left']) {
    const r = k(w.home, ['step', 'fail', w.id, 'S-1', '--why', why]);
    assert.equal(r.status, 1, why);
    assert.match(r.stderr, /is k run's own reason for a stop; say what went wrong/);
  }
  assert.doesNotMatch(progress(w), /failed/);
  assert.equal(k(w.home, ['step', 'fail', w.id, 'S-1', '--why', 'k run was stopped, then the build broke']).status, 0);
  assert.equal(steps.historyOf(progress(w), 'S-1').failures, 1);
});

test('an owner\'s stop, k step stop, counts no failure and writes stop-<k>.md, which the next attempt\'s brief reads first; own failures still climb (gulnya/escalation-counts-non-work-failures)', async () => {
  const w = await approvedWorkspace(PLAN);
  const briefText = () => (assert.equal(k(w.home, ['step', 'brief', w.id, 'S-1']).status, 0), readFileSync(join(w.p.dir, 'steps', 'S-1', 'brief.md'), 'utf8'));
  assert.equal(k(w.home, ['step', 'stop', w.id, 'S-1', '--why', 'not now']).status, 1, 'a step not running is not stopped');
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  const r = k(w.home, ['step', 'stop', w.id, 'S-1', '--why', "S-46 finishes S-41's result bar first"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /S-1: stopped by the owner, no failure counted, kirunak\/tasks\/offline-forecast\/steps\/S-1\/stop-1\.md\n$/);
  assert.match(progress(w), /S-1 failed: stopped by the owner: S-46 finishes S-41's result bar first\n$/);
  const h = steps.historyOf(progress(w), 'S-1');
  assert.deepEqual([h.last, h.stopped, h.failures, h.total], ['failed', true, 0, 0]);
  assert.deepEqual([statesOf(w)['S-1'], steps.load(w.ws, w.id).states.get('S-1').retry], ['ready', null]);
  assert.match(readFileSync(join(w.p.dir, 'steps', 'S-1', 'stop-1.md'), 'utf8'), /S-1 stopped by the owner\n\n.*: S-46 finishes S-41's result bar first/);
  assert.ok(!existsSync(join(w.p.dir, 'steps', 'S-1', 'failure-1.md')), 'a stop writes no failure report');
  assert.ok(briefText().includes('- kirunak/tasks/offline-forecast/steps/S-1/stop-1.md (the owner stopped the last attempt: read why first)'));
  // k step fail refuses the stop's words: only k step stop writes them.
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  const f = k(w.home, ['step', 'fail', w.id, 'S-1', '--why', '  stopped by the owner:  later']);
  assert.equal(f.status, 1);
  assert.match(f.stderr, /k step stop/);
  // An own failure counts as before, and the brief after it reads its report, not the old stop.
  assert.equal(steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'the cache test does not build' }).failures, 1);
  assert.doesNotMatch(briefText(), /stop-1\.md/);
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
  assert.equal(steps.stop({ ws: w.ws, id: w.id, step: 'S-1', why: 'the Mac restarts' }).failures, 1);
  assert.deepEqual(readdirSync(join(w.p.dir, 'steps', 'S-1')).filter((x) => /^(stop|failure)-/.test(x)).sort(), ['failure-1.md', 'stop-1.md', 'stop-2.md']);
  assert.deepEqual([statesOf(w)['S-1'], steps.load(w.ws, w.id).states.get('S-1').retry.reports], ['ready', ['steps/S-1/failure-1.md']]);
  assert.ok(briefText().includes('steps/S-1/stop-2.md (the owner stopped the last attempt'));
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
  assert.equal(steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'still' }).failures, 2);
  assert.equal(statesOf(w)['S-1'], 'failed', 'two own failures climb, the stops between them aside');
});

test('a progress.md written before k step stop reads the same: a stop given with k step fail still counts', () => {
  const old = [
    '2026-10-26 09:12 S-44 started (opus, session a1)',
    "2026-10-26 09:14 S-44 failed: stopped before running, by the owner's answer Q-39: S-46 finishes S-41's result bar first",
    '2026-10-26 10:02 S-44 started (opus, session a2)',
    '2026-10-26 10:36 S-44 failed: kirunak stopped the step: git commit failed',
  ].join('\n');
  const h = steps.historyOf(old, 'S-44');
  assert.deepEqual([h.last, h.stopped, h.failures, h.total], ['failed', false, 2, 2]);
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

test('needs.json: heavy, owner and unfinished requests parse, anything else is an error a run fails on', async () => {
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
  assert.deepEqual(needs({ unfinished: ' two tests\n left ' }), { unfinished: 'two tests left' });
  assert.match(needs({ unfinished: ' ' }).error, /none of heavy, owner and unfinished/);
  assert.match(needs({}).error, /none of heavy, owner and unfinished/);
});

test('needs.json heavy: expectMinutes is optional; one that is no number or is over maxMinutes is an error (gulnya/heavy-queue-nearest-done E-1, E-3)', async () => {
  const w = await approvedWorkspace(PLAN);
  const dir = join(w.p.dir, 'steps', 'S-1');
  const needs = (heavy) => {
    put(w, 'steps/S-1/needs.json', JSON.stringify({ heavy: { what: 'tests', command: ['npm', 'test'], maxMinutes: 10, ...heavy }, then: 'resume' }));
    return steps.readNeeds(dir);
  };
  assert.equal(needs({ expectMinutes: 4 }).heavy.expectMinutes, 4);
  assert.equal(needs({ expectMinutes: 10 }).heavy.expectMinutes, 10, 'the max itself is allowed');
  assert.equal(needs({}).heavy.expectMinutes, undefined, 'none stated');
  assert.equal(needs({ expectMinutes: null }).heavy.maxMinutes, 10, 'null is none');
  assert.deepEqual(needs({ expectMinutes: 11 }), { error: 'needs.json heavy expectMinutes 11 is larger than its maxMinutes 10' });
  for (const bad of [0, -1, '4']) assert.deepEqual(needs({ expectMinutes: bad }), { error: 'needs.json heavy expectMinutes is a number of minutes' }, String(bad));
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

// A plan whose steps run side by side, one id beginning with another's and a dash (gulnya/evidence-commit-own-step).
const PLAN_SIDE_BY_SIDE = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, E-1, D-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/cache-sizes.tsv
budget: 80 calls

### S-1-look Look at the cached forecast [agent]
covers: AC-3
inputs: task
outputs: steps/S-1-look/report.md

### S-2 Show the forecast's age [agent]
covers: AC-3
inputs: task
outputs: steps/S-2/report.md

### S-3 Review [review]
needs: S-1, S-1-look, S-2
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

test('k step finish commits only its own step\'s evidence: named for it, inside its folder, or declared; never another running step\'s', async () => {
  const w = await approvedWorkspace(PLAN_SIDE_BY_SIDE);
  const git = (...args) => sh(w.weather, 'git', args).trim();
  const ev = (f) => `kirunak/tasks/offline-forecast/evidence/${f}`;
  for (const s of ['S-1', 'S-1-look', 'S-2']) assert.equal(k(w.home, ['step', 'start', w.id, s]).status, 0, s);
  put(w, 'steps/S-1/report.md');
  for (const f of ['S-1-a.tsv', 'S-1/shot.txt', 'cache-sizes.tsv', 'S-2-b.tsv', 'S-1-look-x.tsv', 'S-10-y.tsv']) put(w, `evidence/${f}`);
  const r = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'),
    `weather/offline-forecast S-1: the step's evidence\n\n${['S-1-a.tsv', 'S-1/shot.txt', 'S-10-y.tsv', 'cache-sizes.tsv'].map(ev).join('\n')}`,
    'its own by name, by folder and by declaration; S-10-y.tsv no step names, so it goes too');
  assert.deepEqual(git('ls-files', '--others', '--', ev('')).split('\n').sort(), [ev('S-1-look-x.tsv'), ev('S-2-b.tsv')],
    'S-1-look\'s and S-2\'s files stay untracked');

  put(w, 'steps/S-1-look/report.md');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1-look']).status, 0);
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), ev('S-1-look-x.tsv'));
  assert.equal(git('ls-files', '--others', '--', ev('')), ev('S-2-b.tsv'));
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

// kirunak's own pre-commit hook: every refusal of it starts `kirunak: ` (gulnya/finish-refused-commit-waits).
const KIRUNAK_REFUSAL = 'kirunak: binary files that .slapignore does not list: evidence/S-1-shot.png';

test('a finish whose evidence commit kirunak\'s own hook refuses waits for the owner, counts no failure, and k step finish commits it once fixed', async () => {
  const w = await approvedWorkspace(PLAN);
  const hook = join(w.weather, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\necho "${KIRUNAK_REFUSAL}" >&2\nexit 1\n`, { mode: 0o755 });
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  put(w, 'steps/S-1/report.md');
  put(w, 'evidence/S-1-cache-sizes.tsv');
  const r = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(r.status, 1);
  const owner = `kirunak refused the commit of ${w.id} S-1's evidence: ${KIRUNAK_REFUSAL}. Once it is fixed: k step finish ${w.id} S-1`;
  assert.equal(r.stderr.trim(), `${w.id} S-1 waits for the owner: ${owner}`);
  assert.match(progress(w), /S-1 waiting for the owner: kirunak refused the commit/);
  assert.doesNotMatch(progress(w), /S-1 failed|S-1 finished/);
  const st = steps.load(w.ws, w.id).states.get('S-1');
  assert.deepEqual([st.state, st.needs.owner], ['waiting-owner', owner]);
  assert.match(readFileSync(join(w.home, 'events.jsonl'), 'utf8'), /"kind":"awaiting owner","task":"weather\/offline-forecast","step":"S-1"/);

  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const again = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(sh(w.weather, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim(), 'kirunak/tasks/offline-forecast/evidence/S-1-cache-sizes.tsv');
  assert.equal(steps.load(w.ws, w.id).states.get('S-1').state, 'done');
  assert.equal(existsSync(join(w.p.dir, 'steps', 'S-1', 'needs.json')), false, 'the question is set aside');
});

test('a step needing a step written below it is ready once that one is done', async () => {
  const w = await approvedWorkspace(`---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1
inputs: task
outputs: steps/S-1/report.md

### S-2 Show it [agent]
needs: S-3
covers: AC-2
inputs: task
outputs: steps/S-2/report.md

### S-3 Read it back [agent]
covers: AC-3
inputs: task
outputs: steps/S-3/report.md
`);
  assert.equal(steps.load(w.ws, w.id).states.get('S-2').why, 'S-3 is not done');
  writeFileSync(join(w.p.dir, 'progress.md'), '2026-10-28 01:59 S-3 finished\n');
  assert.deepEqual(statesOf(w), { 'S-1': 'ready', 'S-2': 'ready', 'S-3': 'done' });
});

test('k step start stops a review whose two latest counting reviews repeat a not met: [escalate], repeat.md with both rows and the three ways on, the progress line; the same pair stops it once, a new pair again (review-reruns-whole-task AC-4, D-4)', async () => {
  const w = await repeatedWorkspace();
  const first = w.review('review.md', ['AC-1', 'AC-2']);
  w.finished('S-2', 'review.md');
  const t0 = steps.load(w.ws, w.id);
  assert.equal(steps.repeatOf(t0, steps.stepOf(t0, 'S-3')), null, 'one review: nothing repeats yet');
  const second = w.review('review-2.md', ['AC-1', 'AC-3']);
  w.finished('S-3', 'review-2.md');

  const r = k(w.home, ['step', 'start', w.id, 'S-4', '--session', 'rev-3']);
  assert.notEqual(r.status, 0);
  const file = 'kirunak/tasks/offline-forecast/steps/S-4/repeat.md';
  assert.match(r.stderr, new RegExp(`S-4 is stopped for the owner: AC-1 not met in review-1 and review-2; read ${file.replace(/\./g, '\\.')}`));
  assert.match(r.stderr, /amend the line, accept a ratio by an amendment, or let one more fix run/);
  assert.doesNotMatch(progress(w), /S-4 started/);
  const plan = readFileSync(join(w.p.dir, 'plan.md'), 'utf8');
  assert.match(plan, /^### S-4 Review 3 \[review\] \[escalate\]$/m);
  assert.doesNotMatch(plan, /^failures:/m);
  assert.match(progress(w), /S-4 escalated: stopped for the owner, AC-1 not met in review-1 and review-2\n$/);
  const repeat = readFileSync(join(w.p.dir, 'steps', 'S-4', 'repeat.md'), 'utf8');
  const row = (text, id) => text.split('\n').find((l) => l.startsWith(`| ${id} |`));
  for (const x of [row(first, 'AC-1'), row(second, 'AC-1'), '## AC-1', 'review-1 (`review.md`)', 'review-2 (`review-2.md`)', '1. Amend the line', '2. Accept a ratio', '3. Let one more fix run', 'takes `[escalate]` off S-4']) assert.ok(repeat.includes(x), x);
  assert.doesNotMatch(repeat, /AC-2|AC-3/, 'only the id not met in both');
  assert.deepEqual(events(w.home).filter((e) => e.kind === 'escalate').map(({ time, ...e }) => e), [
    { kind: 'escalate', trigger: 'repeated not met', task: w.id, step: 'S-4', ids: ['AC-1'], reviews: ['review-1', 'review-2'], to: null, stopped: true },
  ]);
  // k waiting and the board read it as a stopped step, its why the repeat file.
  assert.deepEqual(steps.stopsOf(w.ws, w.p), [{
    step: 'S-4', kind: 'escalated', what: 'stopped, AC-1 not met in review-1 and review-2',
    why: 'not met in two reviews in a row: steps/S-4/repeat.md holds both rows and your three ways on',
    reports: ['steps/S-4/repeat.md'], dir: 'kirunak/tasks/offline-forecast/steps/S-4/',
  }]);

  // The owner chose one more fix run: the session takes the mark off, and the same pair does not stop S-4 again.
  writeFileSync(join(w.p.dir, 'plan.md'), plan.replace(' [escalate]', ''));
  const again = k(w.home, ['step', 'start', w.id, 'S-4', '--session', 'rev-3']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(progress(w), /S-4 started \(session rev-3\)\n$/);
  // review-3 has AC-1 not met again: a new pair, review-2 and review-3, stops S-5.
  w.review('review-3.md', ['AC-1', 'AC-3']);
  w.finished('S-4', 'review-3.md');
  const next = k(w.home, ['step', 'start', w.id, 'S-5', '--session', 'rev-4']);
  assert.notEqual(next.status, 0);
  assert.match(next.stderr, /S-5 is stopped for the owner: AC-1, AC-3 not met in review-2 and review-3; read /);
  assert.match(progress(w), /S-5 escalated: stopped for the owner, AC-1, AC-3 not met in review-2 and review-3\n$/);
});

test('an owner step is finished with k step finish alone, as k run\'s notice says, once its needs are done; never before (gulnya/owner-step-finish)', async () => {
  const plan = `${PLAN}
### S-3 The owner's yes to push [owner]
needs: S-1
outputs: steps/S-3/answer.md
`;
  const w = await approvedWorkspace(plan);
  put(w, 'steps/S-3/answer.md', 'yes');
  const early = k(w.home, ['step', 'finish', w.id, 'S-3']);
  assert.notEqual(early.status, 0, 'an owner step whose needs are not done finished');
  assert.match(early.stderr, /S-3 is pending: S-1 is not done/);
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1']).status, 0);
  for (const o of ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv']) put(w, o);
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  const done = k(w.home, ['step', 'finish', w.id, 'S-3']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(statesOf(w)['S-3'], 'done');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-2']).status === 0, false, 'an agent step still needs k step start');
  const again = k(w.home, ['step', 'finish', w.id, 'S-3']);
  assert.notEqual(again.status, 0, 'a done owner step finished again');
  assert.match(again.stderr, /S-3 is done\n/);
});

test('an owner step finished from ready goes through the task\'s gate, as k step start does: a held task refuses it (gulnya/owner-step-finish)', async () => {
  const plan = `${PLAN}
### S-3 The owner's yes to push [owner]
outputs: steps/S-3/answer.md
`;
  const w = await approvedWorkspace(plan);
  put(w, 'steps/S-3/answer.md', 'yes');
  assert.equal(statesOf(w)['S-3'], 'ready');
  hold({ ws: w.ws, id: w.id, why: 'waiting for the provider' });
  assert.notEqual(k(w.home, ['step', 'start', w.id, 'S-3']).status, 0, 'k step start ran a step of a held task');
  const r = k(w.home, ['step', 'finish', w.id, 'S-3']);
  assert.notEqual(r.status, 0, 'k step finish moved a held task\'s owner step');
  assert.match(r.stderr, /cannot finish a step:\n.*is on hold/);
  assert.notEqual(statesOf(w)['S-3'], 'done');
  assert.doesNotMatch(existsSync(join(w.p.dir, 'progress.md')) ? progress(w) : '', /S-3 finished/);
});

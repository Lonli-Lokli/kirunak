// k usage's steps stopped for the owner, by reason and task (gulnya/usage-improve-11-22 AC-10), and the agents past 100
// calls with their type, task and step (AC-16): escalations.txt's stops section from readTasks's tasks, and report.txt's
// list under its subagents section. Invented progress lines and calls; never this machine's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escalations, stopReason } from '../lib/usage/escalations.mjs';
import { report } from '../lib/usage/report.mjs';
import { readTasks, rootsOf } from '../lib/usage/tasks.mjs';
import { tempDir } from './helpers.mjs';

const FROM = '2026-11-15T00:00:00.000Z', TO = '2026-11-22T00:00:00.000Z';
const UTC = { zone: 'UTC' };

// One repo `weather` and its worktree `weather-radar`, each with the task's progress.md holding `lines`.
function checkouts(byTask) {
  const src = tempDir(), home = tempDir();
  for (const d of ['weather', 'weather-radar']) {
    for (const [slug, lines] of Object.entries(byTask)) {
      const dir = join(src, d, 'kirunak', 'tasks', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'progress.md'), lines.join('\n') + '\n');
    }
  }
  const roots = rootsOf({ repos: [{ name: 'weather', root: join(src, 'weather') }], compact: { alsoIn: [] } });
  return { home, tasks: readTasks(roots, UTC) };
}

test('two worktree copies of one task with one stop count it once, under its reason (AC-10)', () => {
  const { home, tasks } = checkouts({ radar: [
    '2026-11-18 10:00 S-4 started (opus, k run)',
    '2026-11-18 10:30 S-4 escalated: stopped for the owner, failed on an unchanged checkout (~/src/weather at 1234567): a rerun would fail the same way',
  ] });
  const out = escalations(home, FROM, TO, { tasks, ...UTC });
  assert.match(out, /^stops for the owner: 1$/m);
  assert.match(out, /^ {2}heavy, unchanged checkout: 1$/m);
  assert.match(out, /^ {2}weather\/radar: 1 \(heavy, unchanged checkout 1\)$/m);
});

test('a stop dated outside the week is left out, and a task with none is not listed (AC-10)', () => {
  const { home, tasks } = checkouts({
    radar: ['2026-11-12 10:30 S-4 escalated: stopped for the owner, failed on every rung (sonnet 2, opus 2, fable 2)'],
    tides: ['2026-11-18 10:00 S-1 finished'],
  });
  const out = escalations(home, FROM, TO, { tasks, ...UTC });
  assert.match(out, /^stops for the owner: 0$/m);
  assert.doesNotMatch(out, /weather\/(radar|tides):/);
});

test("each reason's pattern (AC-10)", () => {
  const cases = [
    ['failed on an unchanged checkout (~/src/weather at 1234567): a rerun would fail the same way', 'heavy, unchanged checkout'],
    ['stopped unfinished after its resume with half more budget', 'unfinished after its resume'],
    ['failed on every rung (sonnet 2, opus 2, fable 2)', 'failed on every rung'],
    ['AC-3, E-1 not met in review-1 and review-2', 'not met in two reviews'],
    ["its job passed but wrote no evidence/S-5.txt: a rerun cannot write them; the plan's command or outputs: is wrong", 'missing outputs'],
    ['failed 3 times', 'other'],
  ];
  for (const [why, reason] of cases) assert.equal(stopReason(why), reason, why);
});

test('a task with stops of two reasons lists each, and the reasons sum to the stops (AC-10)', () => {
  const { home, tasks } = checkouts({ radar: [
    '2026-11-16 09:00 S-2 escalated: stopped for the owner, stopped unfinished after its resume with half more budget',
    '2026-11-17 09:00 S-3 escalated stopped for the owner, AC-1 not met in review-2 and review-3',
    '2026-11-19 09:00 S-5 escalated: stopped for the owner, AC-2 not met in review-3 and review-4',
  ] });
  const out = escalations(home, FROM, TO, { tasks, ...UTC });
  assert.match(out, /^stops for the owner: 3$/m);
  assert.match(out, /^ {2}not met in two reviews: 2$/m);
  assert.match(out, /^ {2}unfinished after its resume: 1$/m);
  assert.match(out, /^ {2}weather\/radar: 3 \(not met in two reviews 2, unfinished after its resume 1\)$/m);
});

// An agent's calls: n of them, in session S, the first at 10:00:00 and a second apart.
const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const agent = (sub, n, type) => Array.from({ length: n }, (_, i) => ({
  kind: 'call', ts: new Date(Date.parse('2026-11-18T10:00:00.000Z') + i * 1000).toISOString(), session: S, sub, agentType: type,
  desc: `${type} job`, proj: 'weather', model: 'claude-opus-5-5', inp: 10, cw5: 2000, cw1h: 0, cr: 50000, out: 300, think: 0,
}));

test('an agent of 101 calls is listed with its type, calls, weight, task and step, one of 100 not (AC-16)', () => {
  const home = tempDir();
  const tasks = new Map([['weather/radar', { id: 'weather/radar', dirs: [], steps: [
    { task: 'weather/radar', step: 'S-4', named: S, start: Date.parse('2026-11-18T09:00:00Z'), end: Date.parse('2026-11-18T11:00:00Z'), finished: null },
  ] }]]);
  const out = report([...agent('a1', 101, 'builder'), ...agent('a2', 100, 'scout')], { tasks, home });
  const list = out.split('-- agents past 100 calls')[1]?.split('\n==')[0];
  assert.ok(list, 'report.txt has the list');
  assert.match(list, /builder\t101 calls\tweight 0\.9M\tweather\/radar\tS-4/);
  assert.doesNotMatch(list, /scout/);
});

test("an agent past 100 calls with no task to join is listed as in no task (AC-16)", () => {
  const out = report(agent('a1', 120, 'general-purpose'));
  const list = out.split('-- agents past 100 calls')[1]?.split('\n==')[0];
  assert.match(list, /general-purpose\t120 calls\tweight 1\.1M\tno task\t-/);
});

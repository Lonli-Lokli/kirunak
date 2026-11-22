// fable.txt (gulnya/usage-improve-11-22 AC-13): each Fable step and agent of the week with its weight, calls and first
// context, its role (design, review or escalation), and whether its design was later redone. Invented plans, progress
// lines, calls and events; never this machine's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fable } from '../lib/usage/fable.mjs';
import { readTasks, rootsOf } from '../lib/usage/tasks.mjs';
import { tempDir } from './helpers.mjs';

const FROM = '2026-11-15T00:00:00.000Z', TO = '2026-11-22T00:00:00.000Z';
const TASK = 'weather/radar';
const S1 = 'aaaaaaaa-1111-2222-3333-444444444444';
const S2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const S3 = 'cccccccc-1111-2222-3333-444444444444';

const PLAN = `# Plan

### S-1 Design the radar layer [agent, fable, high]
covers: AC-1, AC-2
outputs: steps/S-1/design.md

### S-2 Build the radar layer [agent, opus, high]
covers: AC-1, AC-2
outputs: steps/S-2/report.md

### S-3 Review the whole run [review, fable, high]
covers: all
outputs: steps/S-3/review.md

### S-4 The tiles' cache [agent, fable, high]
covers: AC-2
what: lay out the tile cache
outputs: steps/S-4/report.md

### S-5 Tiles [agent, fable, high]
covers: AC-3
what: review the tile diff against the task
outputs: steps/S-5/report.md

### S-6 Wind arrows [agent, opus, high]
covers: AC-4
outputs: steps/S-6/report.md
`;

// The repo `weather` with the task's plan.md and progress.md (`lines`); events.jsonl's rows in home.
function world(lines, { events = [], sessions = {} } = {}) {
  const src = tempDir(), home = tempDir();
  const dir = join(src, 'weather', 'kirunak', 'tasks', 'radar');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), PLAN);
  writeFileSync(join(dir, 'progress.md'), lines.join('\n') + '\n');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  for (const [id, f] of Object.entries(sessions)) writeFileSync(join(home, 'sessions', `${id}.json`), JSON.stringify(f));
  if (events.length) writeFileSync(join(home, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const roots = rootsOf({ repos: [{ name: 'weather', root: join(src, 'weather') }], compact: { alsoIn: [] } });
  return { home, tasks: readTasks(roots, { zone: 'UTC' }) };
}

// n calls of a session (an agent's with `sub`), a minute apart from `at`, the first with `ctx` context.
const calls = (session, at, n, { model = 'claude-fable-5-2', sub, agentType, desc, ctx = 40000 } = {}) => Array.from({ length: n }, (_, i) => ({
  kind: 'call', ts: new Date(Date.parse(`2026-11-18T${at}:00.000Z`) + i * 60000).toISOString(), session, sub, agentType, desc,
  proj: 'weather', model, inp: 10, cw5: 1000, cw1h: 0, cr: ctx - 1010 + i * 1000, out: 200, think: 0,
}));
const run = (w, rows) => fable({ rows, tasks: w.tasks, home: w.home, from: FROM, to: TO });
const row = (out, what) => out.split('\n').find((l) => l.startsWith(`${TASK}  `) && l.split(/ {2,}/)[1] === what);

test('a Fable design step is a row with its weight, calls and first context; an Opus step is not listed (AC-13)', () => {
  const w = world([
    `2026-11-18 10:00 S-1 started (session ${S1})`, '2026-11-18 10:30 S-1 finished',
    `2026-11-18 11:00 S-2 started (session ${S2})`, '2026-11-18 11:30 S-2 finished',
  ]);
  const out = run(w, [...calls(S1, '10:01', 3, { ctx: 52000 }), ...calls(S2, '11:01', 4, { model: 'claude-opus-5-5' })]);
  const r = row(out, 'S-1');
  assert.ok(r, out);
  assert.match(r, / {2}3 calls {2}first 52k {2}design$/);
  assert.match(r, /\d+\.\d+M/);
  assert.equal(row(out, 'S-2'), undefined, out);
  assert.match(out, /^fable: 1 steps \(weight \d+\.\dM\), 0 agents \(weight 0\.0M\); design 1, review 0, escalation 0; designs redone 0$/m);
});

test('a review step, and a step whose what names a review, are reviews (AC-13)', () => {
  const w = world([
    `2026-11-18 10:00 S-3 started (session ${S1})`, '2026-11-18 10:30 S-3 finished',
    `2026-11-18 11:00 S-5 started (session ${S2})`, '2026-11-18 11:30 S-5 finished',
  ]);
  const out = run(w, [...calls(S1, '10:01', 2), ...calls(S2, '11:01', 2)]);
  assert.match(row(out, 'S-3'), / review$/);
  assert.match(row(out, 'S-5'), / review$/);
  assert.match(out, /design 0, review 2, escalation 0/);
});

test('a fable-step agent, and a step run on a Fable rung by k run, are escalations; a design agent is a design (AC-13)', () => {
  const w = world([
    `2026-11-18 10:00 S-2 started (session ${S1})`, '2026-11-18 11:00 S-2 finished',
    `2026-11-18 12:00 S-6 started (session ${S2})`, '2026-11-18 12:30 S-6 finished',
  ], { events: [{ time: '2026-11-18T12:30:00.000Z', kind: 'escalated-run', task: TASK, step: 'S-6', rung: { model: 'fable', effort: 'high', mode: 'build' }, phase: 'build', passed: true }] });
  const out = run(w, [
    ...calls(S1, '10:01', 2, { model: 'claude-opus-5-5' }),
    ...calls(S1, '10:05', 5, { sub: 'a1', agentType: 'fable-step', desc: 'take over the failing build' }),
    ...calls(S1, '10:20', 3, { sub: 'a2', agentType: 'general-purpose', desc: 'design the tile store' }),
    ...calls(S2, '12:01', 4),
  ]);
  assert.match(row(out, 'agent fable-step (S-2)'), / {2}5 calls {2}first 40k {2}escalation$/, out);
  assert.match(row(out, 'agent general-purpose (S-2)'), / {2}3 calls .* design$/, out);
  assert.match(row(out, 'S-6'), / escalation$/, out);
  assert.equal(row(out, 'S-2'), undefined, 'the Opus step itself is not listed');
  assert.match(out, /^fable: 1 steps \(weight .*\), 2 agents \(weight .*\); design 1, review 0, escalation 2; designs redone 0$/m);
});

test('a design is redone when the same step is started again after it finished (AC-13)', () => {
  const w = world([
    `2026-11-18 10:00 S-1 started (session ${S1})`, '2026-11-18 10:30 S-1 finished',
    `2026-11-18 14:00 S-1 started (session ${S2})`, '2026-11-18 14:30 S-1 finished',
  ]);
  const out = run(w, [...calls(S1, '10:01', 2), ...calls(S2, '14:01', 2)]);
  const rs = out.split('\n').filter((l) => l.startsWith(`${TASK}  S-1  `));
  assert.equal(rs.length, 2, out);
  assert.match(rs.find((l) => / {2}2 calls /.test(l) && /redone/.test(l)) ?? '', /design, redone \(S-1 started again\)$/, out);
  assert.equal(rs.filter((l) => /redone/.test(l)).length, 1, 'the second run is not redone');
  assert.match(out, /designs redone 1$/m);
});

test("a design is redone when a later Fable design step of the task covers one of its ids; a later Opus step does not redo it (AC-13)", () => {
  const w = world([
    `2026-11-18 10:00 S-1 started (session ${S1})`, '2026-11-18 10:30 S-1 finished',
    `2026-11-18 11:00 S-2 started (session ${S2})`, '2026-11-18 11:30 S-2 finished',
    `2026-11-18 12:00 S-4 started (session ${S3})`, '2026-11-18 12:30 S-4 finished',
  ]);
  const out = run(w, [...calls(S1, '10:01', 2), ...calls(S2, '11:01', 2, { model: 'claude-opus-5-5' }), ...calls(S3, '12:01', 2)]);
  assert.match(row(out, 'S-1'), /design, redone \(S-4 covers AC-2\)$/, out);
  assert.match(row(out, 'S-4'), / design$/, out);
});

test('a design step with no later cover and no restart is not redone; a headless step session is its step (AC-13)', () => {
  const w = world(['2026-11-18 10:00 S-4 started (opus, k run)', '2026-11-18 10:30 S-4 finished'],
    { sessions: { [S1]: { kind: 'headless', task: TASK, step: 'S-4' } } });
  const out = run(w, calls(S1, '10:01', 3));
  assert.match(row(out, 'S-4'), / {2}3 calls {2}first 40k {2}design$/, out);
  assert.match(out, /designs redone 0$/m);
});

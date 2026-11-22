// A step holds a session only while it runs (gulnya/usage-improve-11-22 AC-4, AC-5, D-1; the bug
// gulnya/usage-step-of-other-task): a session linked to task A by k start that runs a step of task B counts the calls
// inside B's step to it, and its later calls to A again, under no step; a session with no k start link still holds the
// task of the step it last started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinOf } from '../lib/usage/tasks.mjs';
import { tempDir } from './helpers.mjs';

const A = 'weather/offline-forecast';
const B = 'weather/radar';
const S = 'bbbbbbbb-1111-2222-3333-444444444444';
const at = (hm) => Date.parse(`2026-11-20T${hm}:00Z`);
const stepOf = (task, step, start, end) => ({ task, step, named: S, start: at(start), end: at(end), finished: at(end) });
const tasksWith = (...steps) => {
  const m = new Map();
  for (const s of steps) {
    if (!m.has(s.task)) m.set(s.task, { id: s.task, dirs: [], steps: [] });
    m.get(s.task).steps.push(s);
  }
  return m;
};
const homeWith = (...lines) => {
  const home = tempDir();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  if (lines.length) writeFileSync(join(home, 'sessions', 'links.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return home;
};

test("a session linked to A that runs a step of B counts its calls after the step to A, under no step (AC-4, D-1)", () => {
  const home = homeWith({ session: S, task: A, since: '2026-11-20T10:00:00.000Z' });
  const of = joinOf({ tasks: tasksWith(stepOf(B, 'S-3', '11:00', '12:00')), home, sessions: new Set([S]) });
  assert.deepEqual(of(S, at('10:30')), { task: A, step: null });
  assert.deepEqual(of(S, at('12:30')), { task: A, step: null });
});

test("a call inside B's step counts to B's step, though the session is linked to A (D-1)", () => {
  const home = homeWith({ session: S, task: A, since: '2026-11-20T10:00:00.000Z' });
  const of = joinOf({ tasks: tasksWith(stepOf(B, 'S-3', '11:00', '12:00')), home, sessions: new Set([S]) });
  assert.deepEqual(of(S, at('11:30')), { task: B, step: 'S-3' });
});

test("the live file's link holds the session after another task's step as the log's does (AC-4, D-1)", () => {
  const home = homeWith();
  writeFileSync(join(home, 'sessions', `${S}.json`), JSON.stringify({ task: A, step: null, since: '2026-11-20T10:00:00.000Z' }));
  const of = joinOf({ tasks: tasksWith(stepOf(B, 'S-3', '11:00', '12:00')), home, sessions: new Set([S]) });
  assert.deepEqual(of(S, at('12:30')), { task: A, step: null });
});

test('a session with no k start link holds the task of the step it last started (AC-5)', () => {
  const home = homeWith();
  const of = joinOf({ tasks: tasksWith(stepOf(A, 'S-1', '09:00', '10:00'), stepOf(B, 'S-3', '11:00', '12:00')), home, sessions: new Set([S]) });
  assert.deepEqual(of(S, at('08:30')), { task: null, step: null });
  assert.deepEqual(of(S, at('10:30')), { task: A, step: null });
  assert.deepEqual(of(S, at('12:30')), { task: B, step: null });
});

test('after the release, a session holds no task until it starts a step, and then the step it last started (AC-2, AC-5)', () => {
  const home = homeWith({ session: S, task: A, since: '2026-11-20T10:00:00.000Z' }, { session: S, task: A, until: '2026-11-20T10:30:00.000Z' });
  const of = joinOf({ tasks: tasksWith(stepOf(A, 'S-1', '09:00', '09:30'), stepOf(B, 'S-3', '11:00', '12:00')), home, sessions: new Set([S]) });
  assert.deepEqual(of(S, at('10:45')), { task: null, step: null });
  assert.deepEqual(of(S, at('12:30')), { task: B, step: null });
});

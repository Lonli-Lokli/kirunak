// k usage reads a sub-step's lines as plans and step lines name them, S-[A-Za-z0-9-]+ (lib/plan.mjs, lib/steps.mjs):
// S-14-M3, S-14-W, S-19-a11y and S-13e-4 each get their own interval, not "no step" (gulnya/usage-sub-step-ids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsOf } from '../lib/usage/tasks.mjs';
import { readWindow } from '../lib/usage/replay/read.mjs';

const S = 'aaaaaaaa-0000-0000-0000-000000000001';
const LINES = [
  `2026-11-02 00:44 S-14-M3 started (session ${S})`,
  '2026-11-02 02:11 S-14-M3 finished',
  `2026-11-02 03:38 S-14-W started (session ${S})`,
  '2026-11-02 07:02 S-14-W finished',
  `2026-11-03 09:00 S-19-a11y started (session ${S})`,
  '2026-11-03 10:00 S-19-a11y failed',
  `2026-11-03 11:00 S-13e-4 started (session ${S})`,
  `2026-11-03 12:00 S-2 started (session ${S})`,
];

test('k usage: a sub-step id gets its own interval, its session named (gulnya/usage-sub-step-ids)', () => {
  const steps = stepsOf('vodar/core', LINES, 'UTC');
  assert.deepEqual(steps.map((s) => [s.step, s.named]), [
    ['S-14-M3', S], ['S-14-W', S], ['S-19-a11y', S], ['S-13e-4', S], ['S-2', S],
  ]);
  const w = steps.find((s) => s.step === 'S-14-W');
  assert.equal(w.start, Date.UTC(2026, 10, 2, 3, 38));
  assert.equal(w.finished, Date.UTC(2026, 10, 2, 7, 2));
});

test('k usage: an undated sub-step line counts as undated in the replay (gulnya/usage-sub-step-ids)', () => {
  const lines = new Set([...LINES, 'S-14-M4 started (session x)']);
  const tasks = new Map([['vodar/core', { id: 'vodar/core', lines, steps: stepsOf('vodar/core', lines, 'UTC') }]]);
  const { undated } = readWindow([], tasks, '2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z');
  assert.equal(undated, 1);
});

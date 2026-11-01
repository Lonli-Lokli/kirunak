// A step started again for its agent keeps its session (gulnya/step-started-for-agent): an orchestrator writes
// "S-n started (session <id>)" and then "S-n started (agent, opus): ..." a minute later, and the second line must not
// cut the session's interval, or its calls and the agents it starts land in no step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsOf } from '../lib/usage/tasks.mjs';

test('a started line naming no session keeps the open interval\'s session', () => {
  const id = 'bb8e04d8-bfe7-4377-8b7c-b8782d93ccdd';
  const ivs = stepsOf('vodar/x', [
    `2026-10-28 08:49 S-13a started (session ${id})`,
    '2026-10-28 08:59 S-13a started (agent, fable): research on how a pour looks',
    '2026-10-28 09:19 S-13a finished: stage.md revised',
  ]);
  assert.equal(ivs.length, 2);
  assert.deepEqual(ivs.map((iv) => iv.named), [id, id]);
  assert.equal(ivs[1].finished != null, true);
});

test('a started line naming another session still takes that session', () => {
  const a = 'aaaaaaaa-0000-0000-0000-000000000000', b = 'bbbbbbbb-0000-0000-0000-000000000000';
  const ivs = stepsOf('vodar/x', [
    `2026-10-28 08:49 S-1 started (session ${a})`,
    `2026-10-28 09:49 S-1 started (session ${b})`,
  ]);
  assert.deepEqual(ivs.map((iv) => iv.named), [a, b]);
});

test('a step started for an agent with nothing open names no session', () => {
  const ivs = stepsOf('vodar/x', ['2026-10-28 08:59 S-2 started (agent, opus): a build']);
  assert.deepEqual(ivs.map((iv) => iv.named), [null]);
});

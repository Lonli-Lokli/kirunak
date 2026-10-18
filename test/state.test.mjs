import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { hashBytes } from '../lib/approval.mjs';
import { STATES, stateOf } from '../lib/state.mjs';

const SRC = join(FIXTURES, 'workspace', 'weather', 'kirunak', 'tasks', 'offline-forecast');
const ASPECTS = ['platforms', 'large-text', 'offline'];

// One folder per state, built from the finished task (task-files.md §4).
function folder(setup) {
  const dir = join(mkdtempSync(join(tmpdir(), 'kirunak-state-')), 'offline-forecast');
  cpSync(SRC, dir, { recursive: true });
  const record = { task: 'weather/offline-forecast', hash: hashBytes(readFileSync(join(dir, 'task.md'))) };
  const put = (name, text) => {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const out = setup({ dir, put, record }) || {};
  return { taskDir: dir, record: out.record === undefined ? record : out.record, aspectIds: ASPECTS, isDone: out.isDone };
}

const REVIEW = '| id | verdict | evidence |\n| --- | --- | --- |\n| AC-1 | met | test X (a.test.mjs:1) |\n';

const CASES = {
  draft: ({ put }) => {
    put('task.md', readFileSync(join(SRC, 'task.md'), 'utf8').replace(' [owner 2026-11-02 Q-2]', ''));
    return { record: null };
  },
  proposed: () => ({ record: null }),
  ready: () => {},
  blocked: ({ put }) => {
    put('plan.md', '---\ntask: weather/offline-forecast\nblocked-by: [weather/other]\n---\n');
    return { isDone: () => false };
  },
  'in progress': ({ put }) => put('progress.md', '2026-11-03 14:02 S-1 started (session 7c1)\n'),
  'in review': ({ put }) => {
    put('progress.md', '2026-11-03 14:02 S-1 started\n');
    put('review.md', REVIEW);
  },
  reviewed: ({ put }) => put('review.md', REVIEW + '\nverdict: met\n'),
  'awaiting owner': ({ put }) => {
    put('review.md', REVIEW + '\nverdict: needs owner (E-1)\n');
    put('checklist.md', '- [ ] E-1 Read: the age line reads naturally (review.md)\n');
  },
  done: ({ put }) => put('done.json', '{"task":"weather/offline-forecast"}\n'),
  'on hold': ({ put }) => put('hold.md', 'Waiting for the provider. 2026-11-04\n'),
  stale: ({ put }) => put('task.md', readFileSync(join(SRC, 'task.md'), 'utf8').replace('three days', 'two days')),
};

test('every state has a fixture', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...STATES].sort());
});

for (const [state, setup] of Object.entries(CASES)) {
  test(`state: ${state}`, () => {
    assert.equal(stateOf({ ...folder(setup), id: 'weather/offline-forecast' }), state);
  });
}

test('a blocker that is done does not block', () => {
  const f = folder(({ put }) => {
    put('plan.md', '---\ntask: weather/offline-forecast\nblocked-by: [weather/other]\n---\n');
    return { isDone: (id) => id === 'weather/other' };
  });
  assert.equal(stateOf(f), 'ready');
});

test('a step waiting on an input no step produces blocks', () => {
  const plan = '### S-1 Cache [agent]\ncovers: all\ninputs: task, docs/none.md\noutputs: steps/S-1/report.md\n';
  assert.equal(stateOf(folder(({ put }) => put('plan.md', plan))), 'blocked');
  assert.equal(stateOf(folder(({ put }) => put('plan.md', plan.replace('docs/none.md', 'intake.md')))), 'ready');
});

test('a step that asks the owner in needs.json is awaiting owner', () => {
  const f = folder(({ put }) => {
    put('progress.md', '2026-11-03 14:02 S-1 started (session 7c1)\n');
    put('steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
  });
  assert.equal(stateOf(f), 'awaiting owner');
});

test('the owner as a blocker blocks', () => {
  const f = folder(({ put }) => put('plan.md', '---\nblocked-by: [owner Q-3]\n---\n'));
  assert.equal(stateOf(f), 'blocked');
});

test('the latest review wins', () => {
  const f = folder(({ put }) => {
    put('review.md', REVIEW + '\nverdict: not met (AC-1)\n');
    put('review-2.md', REVIEW);
  });
  assert.equal(stateOf(f), 'in review');
});

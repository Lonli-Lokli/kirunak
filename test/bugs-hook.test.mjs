import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSession } from '../lib/keeper.mjs';
import { noticeFrom } from '../hooks/kirunak-bugs.mjs';
import { bugsAt } from './board-fixture.mjs';
import { KIRUNAK, makeWorkspace } from './helpers.mjs';

// The SessionStart notice of the bugs (gulnya/kirunak-bugs AC-7, E-7): what a session the owner starts is told.
const START = { session_id: 'abc123', transcript_path: '/tmp/abc123.jsonl', cwd: '/work/weather', hook_event_name: 'SessionStart', source: 'startup' };
const { KIRUNAK_TASK, KIRUNAK_STEP, KIRUNAK_BUG_REVIEW, ...outside } = process.env;
const hook = (home, input, env = {}) =>
  spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'kirunak-bugs.mjs')], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...outside, KIRUNAK_HOME: home, ...env } });
const LINE = '2 bugs wait, 1 with a fix ready: /k-bugs';

test('a session the owner starts or clears is told k waiting\'s line of the bugs, to the terminal and to the model (gulnya/kirunak-bugs AC-7)', async () => {
  const w = await makeWorkspace();
  bugsAt(w);
  for (const source of ['startup', 'clear']) {
    const r = hook(w.home, { ...START, source });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: LINE, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LINE } }, source);
  }
  const r = hook(w.home, { ...START, source: 'resume' });
  assert.deepEqual([r.status, r.stdout], [0, ''], 'a resumed session was told at its start');
});

test('no line when no bug waits, nor for a k run step\'s session or a bug\'s review session (gulnya/kirunak-bugs AC-7, E-7)', async () => {
  const w = await makeWorkspace();
  assert.deepEqual([hook(w.home, START).status, hook(w.home, START).stdout], [0, ''], 'nothing when no bug waits');
  bugsAt(w);
  assert.notEqual(hook(w.home, START).stdout, '');
  for (const env of [{ KIRUNAK_STEP: 'S-1', KIRUNAK_TASK: 'weather/offline-forecast' }, { KIRUNAK_BUG_REVIEW: 'hub/queue-stuck' }]) {
    const r = hook(w.home, START, env);
    assert.deepEqual([r.status, r.stdout], [0, ''], Object.keys(env).join(' '));
  }
  updateSession(w.home, 'abc123', { kind: 'headless', task: 'weather/offline-forecast', step: 'S-1', ttl: '1h' });
  assert.deepEqual([hook(w.home, START).status, hook(w.home, START).stdout], [0, ''], 'a headless session\'s file');
  assert.notEqual(hook(w.home, { ...START, session_id: 'other' }).stdout, '', 'another session is still told');
});

test('the hook never stops a session: bad input, no workspace, nothing printed and exit 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-bugs-hook-'));
  for (const input of ['not json', '', JSON.stringify(START), JSON.stringify({ ...START, session_id: '../x' })]) {
    const r = hook(home, input);
    assert.deepEqual([r.status, r.stdout], [0, ''], input);
  }
});

test('noticeFrom reads the bugs only for a session that is told them', async () => {
  let read = 0;
  const counts = () => (read++, { count: 1, ready: 0 });
  assert.equal(await noticeFrom(START, null, {}, counts), '1 bug waits, 0 with a fix ready: /k-bugs');
  assert.equal(await noticeFrom(START, { kind: 'headless' }, {}, counts), '');
  assert.equal(await noticeFrom(START, null, { KIRUNAK_STEP: 'S-2' }, counts), '');
  assert.equal(await noticeFrom({ ...START, source: 'compact' }, null, {}, counts), '');
  assert.equal(read, 1);
  assert.equal(await noticeFrom(START, null, {}, { count: 0, ready: 0 }), '');
});

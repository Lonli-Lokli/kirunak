import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../lib/handoff.mjs';
import { fromStatusline } from '../hooks/statusline-track.mjs';
import { FIXTURES, KIRUNAK, makeWorkspace } from './helpers.mjs';

const INPUT = readFileSync(join(FIXTURES, 'keeper', 'statusline.json'), 'utf8');
const SID = '5f0c9a1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const hook = (home, stdin) =>
  spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'statusline-track.mjs')], { input: stdin, encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });

test('the session file is written from the status line JSON, and the hook prints nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-statusline-'));
  const r = hook(home, INPUT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'the status line shows only what the user\'s own command prints');
  const file = JSON.parse(readFileSync(join(home, 'sessions', `${SID}.json`), 'utf8'));
  const { seen, ...rest } = file;
  assert.ok(Date.parse(seen));
  assert.deepEqual(rest, {
    kind: 'interactive',
    transcript: `/home/someone/.claude/projects/weather/${SID}.jsonl`,
    model: 'claude-opus-5-5',
    context: 182340,
    ttl: '1h',
    warm: true,
    expiresAt: '2026-11-03T13:00:00.000Z',
    lastCall: '2026-11-03T12:00:00.000Z',
    hitRatio: 0.93,
    cost: { total_cost_usd: 1.2345 },
  });
});

test('k start and the tracker keep each other\'s fields', async () => {
  const w = await makeWorkspace();
  start({ ws: w.ws, id: 'weather/offline-forecast', session: SID, now: new Date('2026-11-03T11:00:00Z') });
  assert.equal(hook(w.home, INPUT).status, 0);
  const file = () => JSON.parse(readFileSync(join(w.home, 'sessions', `${SID}.json`), 'utf8'));
  assert.deepEqual([file().task, file().since, file().context], ['weather/offline-forecast', '2026-11-03T11:00:00.000Z', 182340]);
  start({ ws: w.ws, id: 'weather/offline-forecast', session: SID, now: new Date('2026-11-03T12:30:00Z') });
  assert.deepEqual([file().since, file().expiresAt], ['2026-11-03T12:30:00.000Z', '2026-11-03T13:00:00.000Z']);
});

test('a cold cache, a compaction and a 5-minute lifetime', () => {
  const x = JSON.parse(INPUT);
  const cold = fromStatusline({ ...x, prompt_cache: { ...x.prompt_cache, warm: false, expires_at: null }, context_window: { current_usage: null } }).patch;
  assert.deepEqual([cold.warm, cold.expiresAt, cold.context, 'lastCall' in cold], [false, null, null, false]);
  const five = fromStatusline({ ...x, prompt_cache: { ...x.prompt_cache, ttl: '5m' } }).patch;
  assert.deepEqual([five.ttl, five.lastCall], ['5m', '2026-11-03T12:55:00.000Z']);
  const before = fromStatusline({ session_id: SID, cost: { total_cost_usd: 0 } }).patch;
  assert.deepEqual(Object.keys(before).sort(), ['cost', 'kind', 'seen'], 'before the first response: no cache fields');
});

test('bad input writes nothing and still exits 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-statusline-'));
  for (const stdin of ['', 'not json', '{"session_id":"../../escape"}', '{"cost":{}}']) {
    const r = hook(home, stdin);
    assert.deepEqual([r.status, r.stdout], [0, '']);
  }
  assert.ok(!existsSync(join(home, 'sessions')), 'no session file');
  assert.ok(!existsSync(join(home, '..', 'escape.json')), 'nothing outside the state folder');
});

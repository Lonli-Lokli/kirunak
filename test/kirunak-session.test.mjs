import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSession } from '../lib/keeper.mjs';
import { lineFrom } from '../hooks/kirunak-session.mjs';
import { KIRUNAK } from './helpers.mjs';

// hooks.md's example: a session resumed 90 minutes after its last response.
const RESUME = {
  session_id: 'abc123', transcript_path: '/tmp/abc123.jsonl', cwd: '/work/weather', hook_event_name: 'SessionStart', source: 'resume',
  model: 'claude-opus-5', seconds_since_last_response: 5400, context_tokens: 182340, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396,
};
const hook = (home, input) =>
  spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'kirunak-session.mjs')], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });
const lines = (home) => (existsSync(join(home, 'keeper.jsonl')) ? readFileSync(join(home, 'keeper.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('a resume records a miss or a hit with the context, the session\'s task and lifetime, and prints nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-session-'));
  updateSession(home, 'abc123', { task: 'weather/offline-forecast', step: null, ttl: '1h' });
  const r = hook(home, RESUME);
  assert.deepEqual([r.status, r.stdout], [0, ''], 'a SessionStart hook\'s output would enter the conversation');
  assert.equal(hook(home, { ...RESUME, prompt_cache_likely_expired: false, seconds_since_last_response: 600 }).status, 0);
  const [miss, hit] = lines(home);
  const { ts, ...rest } = miss;
  assert.ok(Date.parse(ts));
  assert.deepEqual(rest, {
    session: 'abc123', task: 'weather/offline-forecast', step: null, kind: 'miss', context: 182340, ttl: '1h', expectedWaitMin: null,
    reason: 'resumed 90 min after its last response', costWeight: null, model: 'claude-opus-5', estimatedCacheWriteUsd: 1.1396,
  });
  assert.deepEqual([hit.kind, hit.reason], ['hit', 'resumed 10 min after its last response']);
});

test('anything but a resume with the cache fields records nothing, and bad input still exits 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-session-'));
  for (const input of [{ ...RESUME, source: 'startup' }, { ...RESUME, source: 'compact' }, { ...RESUME, context_tokens: undefined }, 'not json', '']) {
    const r = hook(home, input);
    assert.deepEqual([r.status, r.stdout], [0, '']);
  }
  assert.deepEqual(lines(home), []);
  assert.equal(lineFrom({ ...RESUME, prompt_cache_likely_expired: 'yes' }), null);
  assert.equal(lineFrom(RESUME).task, null, 'a session with no file has no task');
});

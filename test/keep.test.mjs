import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keep, readLines, updateSession } from '../lib/keeper.mjs';
import { register } from '../plugins/machine-guard-pids.mjs';
import { approvedWorkspace, k } from './helpers.mjs';

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, AC-3, E-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md
`;

const T0 = Date.parse('2026-11-03T12:00:00Z');
const at = (m) => new Date(T0 + m * 60000).toISOString();
function fakeClock() {
  let t = T0;
  return { now: () => new Date(t), sleep: async (ms) => ((t += ms), await new Promise(setImmediate)) };
}

// The invented task approved, an interactive session on it whose last call was 20 minutes ago, and a guard.
async function setup({ expiresAt = at(40), task = true, held = null } = {}) {
  const w = await approvedWorkspace(PLAN);
  w.ws.seams.resourceGuard = { status: () => ({ held, queued: [], estimateMinutes: 0 }), run() {}, claim() {}, release() {}, resources: () => [] };
  updateSession(w.home, 'sess-1', { kind: 'interactive', ...(task ? { task: w.id, step: null } : {}), context: 200000, ttl: '1h', lastCall: at(-20), expiresAt, model: 'claude-opus-5-5' });
  return w;
}

test('a session whose task\'s heavy job is in the guard: k keep ends at expires_at − 5 min, recording the keep-alive', async () => {
  const w = await setup({ held: { session: 'kirunak:weather/offline-forecast', what: 'tests', since: at(-10), estimateMinutes: 90 } });
  const r = await keep({ ws: w.ws, session: 'sess-1', clock: fakeClock() });
  assert.deepEqual([r.action, r.kind, r.at.toISOString()], ['keepalive', 'keepalive', at(35)]);
  assert.match(r.text, /this wake-up reads it again\. While the wait goes on \(heavy, about 45 min\), run `k keep --session sess-1` in the background again/);
  const [line] = readLines(w.home);
  assert.deepEqual([line.ts, line.session, line.task, line.kind, line.context, line.ttl, line.expectedWaitMin, line.costWeight], [at(35), 'sess-1', w.id, 'keepalive', 200000, '1h', 45, 20000]);
  assert.match(readFileSync(join(w.home, 'events.jsonl'), 'utf8'), /"kind":"keep-alive".*"session":"sess-1"/);
});

test('a session whose task waits for the owner is skipped at once', async () => {
  const w = await setup();
  writeFileSync(join(w.p.dir, 'progress.md'), '2026-11-03 11:00 S-1 started (session 7c1)\n');
  mkdirSync(join(w.p.dir, 'steps', 'S-1'), { recursive: true });
  writeFileSync(join(w.p.dir, 'steps', 'S-1', 'needs.json'), JSON.stringify({ owner: 'Three days or a week?' }));
  const r = await keep({ ws: w.ws, session: 'sess-1', clock: fakeClock() });
  assert.deepEqual([r.action, r.text], ['skip', 'no keep-alive for session sess-1: it waits for the owner']);
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.reason, l.costWeight]), [['skip', 'owner', 0]]);
});

test('a step of its task under k run: the wait is the budget minutes it has left; --dry-run records nothing', async () => {
  const w = await setup();
  register(w.ws, process.pid, { task: w.id, step: 'S-1', session: 'x', since: at(-10) });
  const r = await keep({ ws: w.ws, session: 'sess-1', clock: fakeClock(), dryRun: true });
  assert.deepEqual([r.action, r.conversation.waitsFor, r.conversation.expectedWaitMin], ['keepalive', 'k run', 30]);
  assert.equal(r.text, `would end at ${at(35)} for a keep-alive (k run: 30 min expected, under 950 min)`);
  assert.deepEqual(readLines(w.home), []);
});

test('a cold cache is a miss at the write\'s weight; a session waiting for nothing has nothing to keep; no file is refused', async () => {
  const cold = await setup({ expiresAt: at(-1) });
  const r = await keep({ ws: cold.ws, session: 'sess-1', clock: fakeClock() });
  assert.deepEqual([r.kind, r.text], ['miss', `session sess-1's cache went cold at ${at(-1)}: the next turn writes its 200000 tokens again`]);
  assert.equal(readLines(cold.home)[0].costWeight, 400000);
  const idle = await setup({ task: false });
  const none = await keep({ ws: idle.ws, session: 'sess-1', clock: fakeClock() });
  assert.deepEqual([none.action, none.text], ['none', 'nothing to keep for session sess-1: it waits for nothing']);
  assert.deepEqual(readLines(idle.home), []);
  await assert.rejects(keep({ ws: idle.ws, session: 'sess-2', clock: fakeClock() }), (e) => e.code === 1 && /no session file for sess-2/.test(e.message));
});

test('k keep on the command line: the session from --session, --dry-run waits for nothing', async () => {
  const w = await setup({ task: false, expiresAt: new Date(Date.now() + 40 * 60000).toISOString() });
  const r = k(w.home, ['keep', '--session', 'sess-1', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'nothing to keep for session sess-1: it waits for nothing');
  const env = k(w.home, ['keep', '--json'], { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  assert.equal(JSON.parse(env.stdout).action, 'none');
  assert.equal(k(w.home, ['keep'], { CLAUDE_CODE_SESSION_ID: '' }).status, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atResume, CLOCK, fromRun, jobWait, keepWarm, readLines, readSession, track } from '../lib/keeper.mjs';
import pricesDefault from '../plugins/prices-default.mjs';

const T0 = new Date('2026-11-03T12:00:00Z');
const at = (m) => new Date(T0.getTime() + m * 60000).toISOString();
const ws = () => ({ home: mkdtempSync(join(tmpdir(), 'kirunak-warm-')), seams: { prices: pricesDefault().provides.prices }, keeper: { intervalMinutes: 50 } });

// A clock whose sleep moves time on at once.
function fakeClock() {
  let t = T0.getTime();
  return { now: () => new Date(t), sleep: async (ms) => ((t += ms), await new Promise(setImmediate)), advance: (m) => (t += m * 60000) };
}

// A keep-alive's handle, as the runner returns it, already ended with `r`.
const ended = (r) => ({ pid: null, done: Promise.resolve(r) });

// A step's run: 12 calls, its writes to the 1-hour cache.
const RUN = { session_id: 's-1', num_turns: 12, usage: { input_tokens: 2000, cache_creation_input_tokens: 150000, cache_read_input_tokens: 900000, output_tokens: 6000, cache_creation: { ephemeral_1h_input_tokens: 150000 } } };
// A keep-alive: one call that read the context.
const KEEP = {
  session_id: 's-1', num_turns: 1,
  usage: { input_tokens: 3, cache_creation_input_tokens: 120, cache_read_input_tokens: 152000, output_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 120 } },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 152000, cacheCreationInputTokens: 120 } },
};

test('a run record gives the conversation: its end, the lifetime of its writes, the context', () => {
  assert.deepEqual(fromRun(RUN, T0), { kind: 'headless', lastCall: at(0), context: 152000, ttl: '1h', expiresAt: at(60), model: null });
  assert.equal(fromRun(KEEP, T0).model, 'claude-sonnet-5-5', 'the model whose weights price its records');
  assert.equal(fromRun(KEEP, T0).context, 152123, 'one call: input, writes and reads');
  const five = { ...KEEP, usage: { ...KEEP.usage, cache_creation: { ephemeral_5m_input_tokens: 120 } } };
  assert.equal(fromRun(five, T0).expiresAt, at(5));
  assert.equal(fromRun({ num_turns: 1, usage: { cache_read_input_tokens: 10 } }, T0, { ttl: '1h' }).ttl, '1h', 'no writes: the lifetime known before');
  assert.equal(fromRun({ num_turns: 3, usage: { cache_creation_input_tokens: 10 } }, T0, { context: 152000 }).context, 152000);
});

test('the wait for a guard job: its own estimate left, or the queue ahead of it', () => {
  const now = new Date(at(10));
  const status = { held: { session: 'a', since: at(0), estimateMinutes: 30 }, queued: [{ session: 'b', estimateMinutes: 15 }, { session: 'kirunak:x', estimateMinutes: 40 }] };
  assert.equal(jobWait(status, ['a'], now), 20);
  assert.equal(jobWait(status, ['kirunak:x'], now), 75);
  assert.equal(jobWait(status, ['c'], now), null);
  assert.equal(jobWait({ held: null, queued: [] }, ['a'], now), null);
});

test('a two-hour heavy job: a keep-alive at expires_at − 10 min, every 50 minutes, each recorded with its weight; the resume hits', async () => {
  const w = ws();
  const clock = fakeClock();
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: RUN, end: clock.now(), waitsFor: 'heavy', willResume: true });
  let finish;
  const until = new Promise((r) => (finish = r));
  const calls = [];
  const lines = [];
  const r = await keepWarm({
    ws: w, session: 's-1', until, clock, out: (l) => lines.push(l),
    expectedWait: () => 120 - (clock.now() - T0) / 60000,
    keepAlive: () => (calls.push(clock.now().toISOString()), calls.length === 2 && finish(), ended({ exitCode: 0, result: KEEP })),
  });
  assert.deepEqual(calls, [at(50), at(100)]);
  assert.equal(r.kept, 2);
  const file = readSession(w.home, 's-1');
  assert.deepEqual([file.lastCall, file.expiresAt, file.context], [at(100), at(160), 152123]);
  const kept = readLines(w.home);
  assert.deepEqual(kept.map((l) => [l.kind, l.task, l.step, l.ts]), [['keepalive', 'weather/x', 'S-1', at(50)], ['keepalive', 'weather/x', 'S-1', at(100)]]);
  assert.equal(Math.round(kept[0].costWeight * 10) / 10, 0.6 * (3 + 2 * 120 + 0.1 * 152000 + 5 * 2), 'the keep-alive record\'s own weight');
  assert.equal(kept[0].expectedWaitMin, 70);
  assert.equal(lines.length, 2);
  assert.match(readFileSync(join(w.home, 'events.jsonl'), 'utf8'), /"kind":"keep-alive"/);
  clock.advance(5);
  const hit = await atResume(w, 's-1', clock.now());
  assert.deepEqual([hit.kind, Math.round(hit.costWeight)], ['hit', Math.round(0.6 * 0.1 * 152123)], 'at the sonnet weights');
  assert.equal(readSession(w.home, 's-1').waitsFor, null);
});

test('a wait over the break-even is skipped once and kept no more; the resume after it misses', async () => {
  const w = ws();
  const clock = fakeClock();
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: RUN, end: clock.now(), waitsFor: 'heavy', willResume: true });
  let kept = 0;
  const r = await keepWarm({ ws: w, session: 's-1', until: new Promise(() => {}), clock, expectedWait: () => 2000, keepAlive: () => (kept++, ended({ result: KEEP })) });
  assert.equal(kept, 0);
  assert.match(r.ended, /over the break-even, 950 min/);
  clock.advance(120);
  const miss = await atResume(w, 's-1', clock.now());
  assert.deepEqual(readLines(w.home).map((l) => l.kind), ['skip', 'miss']);
  assert.deepEqual([miss.reason, miss.costWeight], [`the cache expired at ${at(60)}`, 2 * 152000]);
});

test('a wait just over the break-even is decided again at the keep-alive time, and kept once it is under', async () => {
  const w = ws();
  const clock = fakeClock();
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: RUN, end: clock.now(), waitsFor: 'heavy', willResume: true });
  let finish;
  const until = new Promise((r) => (finish = r));
  const calls = [];
  await keepWarm({
    ws: w, session: 's-1', until, clock, expectedWait: () => 995 - (clock.now() - T0) / 60000,
    keepAlive: () => (calls.push(clock.now().toISOString()), finish(), ended({ exitCode: 0, result: KEEP })),
  });
  assert.deepEqual(calls, [at(50)], '945 minutes left at the keep-alive time: under 950');
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.expectedWaitMin]), [['skip', 995], ['keepalive', 945]]);
});

test('a 40-minute job under the 5-minute cache whose keep-alives all come cold: one keep-alive, a miss, and the keeping ends', async () => {
  const w = ws();
  const clock = fakeClock();
  const five = { ...RUN, usage: { ...RUN.usage, cache_creation: { ephemeral_5m_input_tokens: 150000 } } };
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: five, end: clock.now(), waitsFor: 'heavy', willResume: true });
  const cold = { ...KEEP, usage: { ...KEEP.usage, cache_creation_input_tokens: 152000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 152000 } } };
  let finish;
  const until = new Promise((r) => (finish = r));
  const calls = [];
  const r = await keepWarm({
    ws: w, session: 's-1', until, clock, expectedWait: () => 40 - (clock.now() - T0) / 60000,
    keepAlive: () => (calls.push(clock.now().toISOString()), clock.now() - T0 >= 40 * 60000 && finish(), ended({ exitCode: 0, result: cold })),
  });
  assert.deepEqual(calls, [at(4.5)], 'not one every 4.5 minutes until the job ends');
  assert.equal(r.kept, 1);
  assert.match(r.ended, /^a keep-alive wrote more than it read \(152000 tokens against 0\)/);
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.reason]), [
    ['keepalive', 'heavy: 35.5 min expected, under 51.75 min'],
    ['miss', 'the keep-alive wrote the context again'],
    ['skip', r.ended],
  ]);
  assert.equal(readSession(w.home, 's-1').expiresAt, at(9.5), 'the cache it wrote is warm until 5 minutes after it');
});

test('a keep-alive with no result stops the keeping', async () => {
  const w = ws();
  const clock = fakeClock();
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: RUN, end: clock.now(), waitsFor: 'heavy', willResume: true });
  const r = await keepWarm({ ws: w, session: 's-1', until: new Promise(() => {}), clock, expectedWait: () => 300, keepAlive: () => ended({ exitCode: 1, result: null }) });
  assert.deepEqual([r.kept, r.ended], [0, 'the keep-alive failed']);
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.reason]), [['keepalive', 'the keep-alive gave no result (exit 1)']]);
});

test('a job that ends before the keep-alive time ends the keeping at once, and no timer is left', async () => {
  const w = ws();
  track(w, { session: 's-1', task: 'weather/x', step: 'S-1', result: RUN, end: new Date(), waitsFor: 'heavy', willResume: true });
  const until = new Promise((r) => setTimeout(r, 30));
  const t = Date.now();
  const r = await keepWarm({ ws: w, session: 's-1', until, clock: CLOCK, expectedWait: () => 10, keepAlive: async () => assert.fail('no keep-alive') });
  assert.deepEqual([r.kept, r.ended], [0, 'the wait ended']);
  assert.ok(Date.now() - t < 5000);
  assert.deepEqual(readLines(w.home), []);
});

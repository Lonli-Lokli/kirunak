import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare, costOf, runFields } from '../lib/cost.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { k, makeWorkspace, RESULT } from './helpers.mjs';

const ID = 'weather/offline-forecast';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const usage = (input, cw5m, cw1h, cr, out) => ({
  input_tokens: input, cache_creation_input_tokens: cw5m + cw1h, cache_read_input_tokens: cr, output_tokens: out,
  cache_creation: { ephemeral_5m_input_tokens: cw5m, ephemeral_1h_input_tokens: cw1h },
});

// S-1: one conversation, run and resumed; its second result carries the whole conversation's totals.
// S-2: a fresh conversation on another model, its per-model fields in snake case.
const RECORDS = {
  'S-1/run-1.json': {
    session_id: A, num_turns: 10, is_error: false, total_cost_usd: 0.5, usage: usage(1000, 0, 20000, 180000, 4000),
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 4000, cacheReadInputTokens: 180000, cacheCreationInputTokens: 20000 } },
  },
  'S-1/run-2.json': {
    session_id: A, num_turns: 5, is_error: false, total_cost_usd: 0.8, usage: usage(500, 0, 10000, 120000, 1000),
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1500, outputTokens: 5000, cacheReadInputTokens: 300000, cacheCreationInputTokens: 30000 } },
  },
  'S-2/run-1.json': {
    session_id: B, num_turns: 2, is_error: false, total_cost_usd: 0.3, usage: usage(100, 50000, 0, 0, 500),
    model_usage: { 'claude-opus-5-5': { input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 50000 } },
  },
  // A run written before it started, whose k run stopped: no result, so no run, calls or money.
  'S-2/run-2.json': { session_id: B, kirunak: { krun: 1, claude: null, started: '2026-11-04T09:31:00.000Z', ended: null, result: false } },
};

// Worked by hand with the default weights (orchestrator.md §6):
//   S-1 at its latest record: 0.6 × (1500 + 2 × 30000 + 0.1 × 300000 + 5 × 5000) = 0.6 × 116500 = 69900
//   S-2: 1 × (100 + 1.25 × 50000 + 0.1 × 0 + 5 × 500) = 65100
//   contexts per call: S-1 run-1 201000 / 10 = 20100 (×10), run-2 130500 / 5 = 26100 (×5), S-2 50100 / 2 = 25050 (×2)
//   17 calls: median the 9th, 20100; p90 the 16th, 26100
const S1 = 0.6 * (1500 + 2 * 30000 + 0.1 * 300000 + 5 * 5000);
const S2 = 100 + 1.25 * 50000 + 5 * 500;

async function fixture() {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  for (const [rel, rec] of Object.entries(RECORDS)) {
    mkdirSync(join(p.dir, 'steps', rel.split('/')[0]), { recursive: true });
    writeFileSync(join(p.dir, 'steps', rel), JSON.stringify(rec));
  }
  writeFileSync(join(p.dir, 'progress.md'), [
    '2026-11-03 14:02 S-1 started (sonnet, session aaaaaaaa)', '2026-11-03 15:10 S-1 finished',
    '2026-11-04 09:00 S-2 started (opus, session bbbbbbbb)', '2026-11-04 09:30 S-2 finished', '',
  ].join('\n'));
  return { ...w, p };
}

test('the run record fields: the documented result, model_usage or modelUsage, the cache split', () => {
  const r = runFields(JSON.parse(RESULT));
  assert.deepEqual([r.sessionId, r.turns, r.isError, r.subtype, r.costUsd], ['7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', 12, false, 'success', 1.0425]);
  assert.deepEqual(r.usage, { input: 3000, output: 8000, cacheRead: 600000, cacheWrite: 40000, write5m: 10000, write1h: 30000 });
  // The model's 40000 written split as usage splits them: a quarter at 5 minutes.
  assert.deepEqual(r.models[0], { model: 'claude-sonnet-5-5', input: 3000, output: 8000, cacheRead: 600000, write5m: 10000, write1h: 30000 });
  assert.deepEqual(runFields(RECORDS['S-2/run-1.json']).models, [{ model: 'claude-opus-5-5', input: 100, output: 500, cacheRead: 0, write5m: 50000, write1h: 0 }]);
});

test('k cost equals the formula worked by hand', async () => {
  const w = await fixture();
  const c = await costOf(w.ws, ID);
  assert.deepEqual(c.steps.map((s) => [s.step, Math.round(s.weight), s.usd, s.calls, s.runs, s.medianContext]), [
    ['S-1', Math.round(S1), 0.8, 15, 2, 20100],
    ['S-2', S2, 0.3, 2, 1, 25050],
  ]);
  assert.equal(Math.round(c.total.weight), Math.round(S1 + S2));
  assert.equal(Math.round(c.total.weight), 135000);
  assert.equal(Math.round(c.total.usd * 100), 110);
  assert.deepEqual([c.total.calls, c.total.medianContext, c.total.p90Context, c.days], [17, 20100, 26100, 2]);
  const r = k(w.home, ['cost', ID]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /weather\/offline-forecast: weight 1\.35e5, 1\.10 USD, 17 calls, median context 20,100/);
  assert.match(r.stdout, /S-1 +weight +6\.99e4 +0\.80 USD +15 calls {2}2 runs/);
  assert.doesNotMatch(r.stdout, /against/, 'no baseline, no comparison');
});

test('k cost --baseline prints only the comparisons, and nothing without a baseline', async () => {
  const w = await fixture();
  const none = k(w.home, ['cost', ID, '--baseline']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, '');

  writeFileSync(join(w.home, 'keeper.jsonl'), [
    { session: A, kind: 'keepalive' }, { session: A, kind: 'miss' }, { session: B, kind: 'hit' }, { session: 'other', kind: 'miss' },
    { session: 'interactive-1', task: ID, kind: 'hit' }, { session: 'interactive-2', task: 'weather/other', kind: 'miss' },
  ].map((x) => JSON.stringify(x) + '\n').join(''));
  const baseline = {
    period: { from: '2026-09-01', to: '2026-09-14' }, contextPerCall: { median: 150000, p90: 400000 },
    over: { threshold: 25000, share: 0.2 }, weightPerRepoDay: { weather: 9.5e6 }, missRate: 0.05,
  };
  writeFileSync(join(w.hub, 'kirunak', 'baseline.json'), JSON.stringify(baseline));
  const module = join(w.hub, 'kirunak', 'workspace.mjs');
  writeFileSync(module, readFileSync(module, 'utf8').replace("plugins: ['./plugins/checklist.mjs'],", "plugins: ['./plugins/checklist.mjs'],\n  baseline: './baseline.json',"));
  const r = k(w.home, ['cost', ID, '--baseline']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'context per call: median 20,100 against 150,000, p90 26,100 against 400,000',
    'calls over 25,000: 41% against 20%',
    'weight: 1.35e5 over 2 working days against 1.90e7 (weather, 9.50e6 a day)',
    'misses: 1 of 3 resumes (33%) against a miss rate of 5%; keep-alives 1',
  ]);
  // A baseline with fewer numbers gives fewer comparisons.
  const c = await costOf(w.ws, ID);
  assert.deepEqual(compare(c, { contextPerCall: { median: 150000 } }), ['context per call: median 20,100 against 150,000']);
  assert.deepEqual(compare(c, { weightPerRepoDay: { hub: 1e6 } }), []);
});

test('an interactive session that names the task is summed', async () => {
  const w = await fixture();
  mkdirSync(join(w.home, 'sessions'), { recursive: true });
  writeFileSync(join(w.home, 'sessions', 's1.json'), JSON.stringify({ task: ID, step: null, cost: { total_cost_usd: 0.42 } }));
  writeFileSync(join(w.home, 'sessions', 's2.json'), JSON.stringify({ task: 'weather/other', cost: { total_cost_usd: 9 } }));
  const c = await costOf(w.ws, ID);
  assert.deepEqual(c.interactive, { sessions: 1, usd: 0.42 });
  assert.match(k(w.home, ['cost', ID]).stdout, /interactive sessions 1, 0\.42 USD/);
});

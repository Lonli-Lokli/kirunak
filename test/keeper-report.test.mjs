import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatReport, isoWeek, report, updateSession } from '../lib/keeper.mjs';
import { k, makeWorkspace } from './helpers.mjs';

const A = 'weather/offline-forecast';
const B = 'hub/queue-board';
// Two tasks over two weeks: k run's lines (weighed), the SessionStart hook's (no weight), one with no task in it.
const LINES = [
  { ts: '2026-11-03T12:55:00Z', session: 's-a', task: A, step: 'S-1', kind: 'keepalive', context: 150000, ttl: '1h', costWeight: 15000 },
  { ts: '2026-11-03T13:50:00Z', session: 's-a', task: A, step: 'S-1', kind: 'keepalive', context: 152000, ttl: '1h', costWeight: 15200 },
  { ts: '2026-11-03T14:10:00Z', session: 's-a', task: A, step: 'S-1', kind: 'hit', context: 152000, ttl: '1h', costWeight: 15200 },
  { ts: '2026-11-04T09:00:00Z', session: 's-i', task: null, kind: 'miss', context: 100000, ttl: '1h', costWeight: null, model: 'claude-opus-5-5' },
  { ts: '2026-11-04T09:30:00Z', session: 's-b', task: B, step: 'S-2', kind: 'skip', reason: 'owner', costWeight: 0 },
  { ts: '2026-11-10T10:00:00Z', session: 's-b', task: B, step: 'S-2', kind: 'miss', context: 80000, ttl: '5m', costWeight: null, model: 'claude-sonnet-5-5' },
  { ts: '2026-11-10T11:00:00Z', session: 's-x', task: B, kind: 'miss', context: null, ttl: null, costWeight: null },
];

test('the report sums keep-alives, misses, hits and skips per task and per week, pricing the lines with no weight', async () => {
  const w = await makeWorkspace();
  writeFileSync(join(w.home, 'keeper.jsonl'), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n{not json\n');
  updateSession(w.home, 's-i', { task: A, kind: 'interactive' });
  const r = await report(w.ws);
  assert.deepEqual(r.tasks.map((x) => x.key), [B, A]);
  const a = r.tasks.find((x) => x.key === A);
  assert.deepEqual({ ...a }, { key: A, keepalives: 2, keepWeight: 30200, misses: 1, missWeight: 200000, hits: 1, skips: 0, unpriced: 0 });
  const b = r.tasks.find((x) => x.key === B);
  assert.deepEqual([b.misses, b.missWeight, b.skips, b.unpriced], [2, 0.6 * 1.25 * 80000, 1, 1], 'a 5-minute miss at the sonnet weights');
  assert.deepEqual(r.weeks.map((x) => [x.key, x.keepalives, x.misses, x.hits, x.skips]), [['2026-W45', 2, 1, 1, 1], ['2026-W46', 0, 2, 0, 0]]);
  assert.equal(formatReport(r).split('\n')[2], `  ${A}: 2 keep-alives, weight 3.02e4; 1 miss, weight 2.00e5; 1 hit; 0 skips`);
});

test('k keeper report on the command line, and with nothing recorded', async () => {
  const w = await makeWorkspace();
  assert.equal(k(w.home, ['keeper', 'report']).stdout.trim(), 'no keep-alive, miss, hit or skip recorded yet');
  writeFileSync(join(w.home, 'keeper.jsonl'), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = k(w.home, ['keeper', 'report']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^per task\n {2}\(no task\): 0 keep-alives, weight 0; 1 miss, weight 2\.00e5; 0 hits; 0 skips\n/);
  assert.match(out.stdout, /\n {2}hub\/queue-board: .*2 misses.*\(1 without a context to price\)\n/);
  assert.equal(JSON.parse(k(w.home, ['keeper', 'report', '--json']).stdout).weeks.length, 2);
  assert.equal(k(w.home, ['keeper', 'nope']).status, 2);
  assert.equal(isoWeek(new Date(2027, 0, 1)), '2026-W53');
});

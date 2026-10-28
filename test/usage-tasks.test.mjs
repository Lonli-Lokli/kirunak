// k usage's weight per kirunak task and step (gulnya/k-usage AC-2, D-3): tasks.txt, tasks.tsv and the printed tail,
// from invented transcripts, step lines, a run record and two session files; never this machine's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { k, makeWorkspace, RESULT } from './helpers.mjs';
import { weight } from '../lib/usage/common.mjs';

const FROM = '2026-10-18T14:00:00.000Z', TO = '2026-10-25T15:00:00.000Z';
const id = (n) => `${String(n).repeat(8)}-0000-0000-0000-00000000000${n}`;
const I = id(1), H = id(2), K = id(3), L = id(4), N = id(5), M = id(6);

// Each call: 10 input, 2000 written for 5 minutes, 50000 read, 300 out; 9010 Opus-input tokens on Opus.
const call = (ts, mid, model = 'claude-opus-5-5') => JSON.stringify({
  type: 'assistant', timestamp: ts, requestId: `r-${mid}`, entrypoint: 'cli',
  message: { id: mid, model, role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 } } },
});
const user = (ts) => JSON.stringify({ type: 'user', timestamp: ts, entrypoint: 'cli', message: { role: 'user', content: 'go' } });
const OPUS = 9010, SONNET = 0.6 * OPUS, FABLE = 2.5 * OPUS, HAIKU = 0.2 * OPUS;

// The week: I, an interactive session of weather/offline-forecast, runs S-1 (its scout agent outliving the step) and,
// a day apart, S-3, with calls before, between and after; H is S-2's k run session, named by its run record only; K
// is S-4's, named by the keeper's file only; L joins the task by k start's link at 08:00; N is in no task; M runs
// hub/tidy's S-1. Step lines in UTC (the child runs with TZ=UTC).
async function week() {
  const w = await makeWorkspace();
  const task = join(w.weather, 'kirunak', 'tasks', 'offline-forecast');
  writeFileSync(join(task, 'progress.md'), [
    `2026-10-20 09:00 S-1 started (opus, session weather-offline-forecast-${I.slice(0, 8)})`,
    '2026-10-20 10:00 S-1 finished',
    '2026-10-20 12:00 S-2 started (fable, k run)',
    '2026-10-20 13:00 S-2 finished',
    `2026-10-21 09:00 S-3 started (opus, session ${I})`,
    '2026-10-21 10:00 S-3 finished',
    '2026-10-23 09:00 S-4 started (haiku, k run)',
  ].join('\n') + '\n');
  mkdirSync(join(task, 'steps', 'S-2'), { recursive: true });
  writeFileSync(join(task, 'steps', 'S-2', 'run-1.json'), JSON.stringify({ ...JSON.parse(RESULT), session_id: H }));
  const tidy = join(w.hub, 'kirunak', 'tasks', 'tidy');
  mkdirSync(tidy, { recursive: true });
  writeFileSync(join(tidy, 'progress.md'), `2026-10-24 09:00 S-1 started (opus, session ${M})\n`);
  mkdirSync(join(w.home, 'sessions'), { recursive: true });
  writeFileSync(join(w.home, 'sessions', `${K}.json`), JSON.stringify({ kind: 'headless', task: 'weather/offline-forecast', step: 'S-4', pid: 1 }));
  writeFileSync(join(w.home, 'sessions', `${L}.json`), JSON.stringify({ task: 'weather/offline-forecast', step: null, since: '2026-10-22T08:00:00.000Z' }));
  writeFileSync(join(w.home, 'sessions', `${N}.json`), JSON.stringify({ cache: { at: 1 } })); // the statusline's: no task

  const config = mkdtempSync(join(tmpdir(), 'kirunak-claude-'));
  const proj = join(config, 'projects', `${realpathSync(w.root).replace(/[^a-zA-Z0-9]/g, '-')}-weather`);
  mkdirSync(join(proj, I, 'subagents'), { recursive: true });
  const put = (f, lines) => writeFileSync(join(proj, f), [user(lines[0][0]), ...lines.map(([ts, mid, model]) => call(ts, mid, model))].join('\n') + '\n');
  put(`${I}.jsonl`, [['2026-10-19T08:00:00.000Z', 'i0'], ['2026-10-20T09:30:00.000Z', 'i1'], ['2026-10-20T11:00:00.000Z', 'i2'], ['2026-10-21T09:30:00.000Z', 'i3']]);
  put(join(I, 'subagents', 'agent-x1.jsonl'), [['2026-10-20T09:40:00.000Z', 'a1', 'claude-sonnet-5'], ['2026-10-20T10:30:00.000Z', 'a2', 'claude-sonnet-5']]);
  writeFileSync(join(proj, I, 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'scout', description: 'find it' }));
  put(`${H}.jsonl`, [['2026-10-20T12:10:00.000Z', 'h1', 'claude-fable-5'], ['2026-10-20T12:20:00.000Z', 'h2', 'claude-fable-5']]);
  put(`${K}.jsonl`, [['2026-10-23T09:10:00.000Z', 'k1', 'claude-haiku-5']]);
  put(`${L}.jsonl`, [['2026-10-22T07:00:00.000Z', 'l0'], ['2026-10-22T09:00:00.000Z', 'l1']]);
  put(`${N}.jsonl`, [['2026-10-22T10:00:00.000Z', 'n1'], ['2026-10-22T11:00:00.000Z', 'n2'], ['2026-10-22T12:00:00.000Z', 'n3']]);
  put(`${M}.jsonl`, [['2026-10-24T09:10:00.000Z', 'm1']]);
  const out = join(w.root, 'review');
  const r = k(w.home, ['usage', '--from', FROM, '--to', TO, '--out', out], { CLAUDE_CONFIG_DIR: config, TZ: 'UTC' });
  return { w, out, r };
}

test('k usage weighs the week per task and step, heaviest first, no task last, the rows summing to the week (AC-2)', async () => {
  const { out, r } = await week();
  assert.equal(r.status, 0, r.stderr);
  const summary = readFileSync(join(out, 'summary.txt'), 'utf8'), tasks = readFileSync(join(out, 'tasks.txt'), 'utf8');
  assert.equal(r.stdout, `${summary}\n${tasks}`, 'the summary printed, then the tasks');
  assert.match(summary, /^calls 15 \(main 13, agents 2\)/m);

  const rows = tasks.trim().split('\n').slice(1).map((l) => /^(\s*)(\S.*?)\s+([\d.]+)M\s+([\d.]+)%\s+(\d+) calls$/.exec(l))
    .map((m) => [m[1] ? `  ${m[2]}` : m[2], Number(m[5])]);
  assert.deepEqual(rows, [
    ['weather/offline-forecast', 9],
    ['  S-2', 2], // H by its run record: Fable
    ['  S-1', 3], // I in S-1 and its agent's two calls, the one after S-1's end too
    ['  no step', 2], // I between its steps, and L after k start's link
    ['  S-3', 1],
    ['  S-4', 1], // K by the keeper's file: Haiku
    ['hub/tidy', 1],
    ['  S-1', 1],
    ['no task', 5], // I before its first step, L before its link, and N's three
  ]);
  assert.match(tasks, /^by task and step, heaviest first: .* calls \(15\)\n/);

  const tsv = readFileSync(join(out, 'tasks.tsv'), 'utf8').trim().split('\n');
  assert.equal(tsv[0], `# generated by k usage --from ${FROM} --to ${TO} (gulnya/k-usage AC-2): a row per task and step, so the weights sum to the week's; never edited by hand`);
  assert.equal(tsv[1], 'task\tstep\tweight\tcalls');
  const leaf = tsv.slice(2).map((l) => l.split('\t'));
  const of = (t, s) => leaf.find(([a, b]) => a === t && b === s);
  assert.deepEqual(leaf.map(([t, s]) => `${t} ${s}`), ['weather/offline-forecast S-2', 'weather/offline-forecast S-1', 'weather/offline-forecast no step',
    'weather/offline-forecast S-3', 'weather/offline-forecast S-4', 'hub/tidy S-1', 'no task ']);
  assert.deepEqual(of('weather/offline-forecast', 'S-1').slice(2), [String(Math.round(OPUS + 2 * SONNET)), '3']);
  assert.deepEqual(of('weather/offline-forecast', 'S-2').slice(2), [String(Math.round(2 * FABLE)), '2']);
  assert.deepEqual(of('weather/offline-forecast', 'S-4').slice(2), [String(Math.round(HAIKU)), '1']);
  assert.deepEqual(of('no task', '').slice(2), [String(5 * OPUS), '5']);

  // The rows sum to the week's weight: every call of calls.jsonl, weighed as the summary weighs it.
  const calls = readFileSync(join(out, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.kind === 'call');
  const total = calls.reduce((s, c) => s + weight(c), 0);
  assert.equal(leaf.reduce((s, l) => s + Number(l[3]), 0), calls.length);
  assert.ok(Math.abs(leaf.reduce((s, l) => s + Number(l[2]), 0) - total) < leaf.length, 'the rows sum to the week, to rounding');
  assert.match(tasks, new RegExp(`share of the week's ${(total / 1e6).toFixed(1)}M`));
});

test('k usage: a week with no task and no calls prints the no-task row alone', async () => {
  const w = await makeWorkspace({ finished: false });
  const config = mkdtempSync(join(tmpdir(), 'kirunak-claude-'));
  mkdirSync(join(config, 'projects'), { recursive: true });
  const out = join(w.root, 'empty');
  const r = k(w.home, ['usage', '--from', FROM, '--to', TO, '--out', out], { CLAUDE_CONFIG_DIR: config, TZ: 'UTC' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(out, 'tasks.txt'), 'utf8'), /\nno task\s+0\.0M\s+0\.0%\s+0 calls\n$/);
  assert.deepEqual(readFileSync(join(out, 'tasks.tsv'), 'utf8').trim().split('\n').slice(1), ['task\tstep\tweight\tcalls', 'no task\t\t0\t0']);
});

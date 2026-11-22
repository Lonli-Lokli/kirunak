// k usage splits each task's no-step weight by what the session was doing (gulnya/usage-improve-11-22 AC-11):
// calls.jsonl's mark rows (a command line, a Skill call, a Bash call running a k or git command) and the kind each
// no-step call takes from the session's latest mark before it, in tasks.txt and tasks.tsv; from invented transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { k, makeWorkspace, tempDir } from './helpers.mjs';

const FROM = '2026-11-16T00:00:00.000Z', TO = '2026-11-23T00:00:00.000Z';
const S = '11111111-0000-0000-0000-000000000001', A = '22222222-0000-0000-0000-000000000002';
const T = 'weather/offline-forecast';
const OPUS = 9010;

let n = 0;
// A call (9010 Opus-input tokens), its content the blocks given (a text by default).
const call = (ts, content = [{ type: 'text', text: 'ok' }]) => {
  n++;
  return JSON.stringify({
    type: 'assistant', timestamp: ts, requestId: `r-${n}`, entrypoint: 'cli',
    message: { id: `m-${n}`, model: 'claude-opus-5-5', role: 'assistant', content,
      usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 } } },
  });
};
const user = (ts, content) => JSON.stringify({ type: 'user', timestamp: ts, entrypoint: 'cli', message: { role: 'user', content } });
const command = (ts, name) => user(ts, `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>`);
const tool = (name, input) => [{ type: 'tool_use', id: `t-${n + 1}`, name, input }];
const bash = (ts, cmd) => call(ts, tool('Bash', { command: cmd, description: 'x' }));

// S holds the task by k start's link from 07:00 on the 18th; its day, each no-step call's kind after it.
async function day() {
  const w = await makeWorkspace();
  const task = join(w.weather, 'kirunak', 'tasks', 'offline-forecast');
  writeFileSync(join(task, 'progress.md'), [
    `2026-11-18 13:00 S-1 started (opus, session ${S})`,
    '2026-11-18 14:00 S-1 finished',
  ].join('\n') + '\n');
  mkdirSync(join(w.home, 'sessions'), { recursive: true });
  writeFileSync(join(w.home, 'sessions', `${S}.json`), JSON.stringify({ task: T, step: null, since: '2026-11-18T07:00:00.000Z' }));

  const config = tempDir('kirunak-claude-');
  const proj = join(config, 'projects', `${realpathSync(w.root).replace(/[^a-zA-Z0-9]/g, '-')}-weather`);
  mkdirSync(join(proj, S, 'subagents'), { recursive: true });
  const d = (hm) => `2026-11-18T${hm}:00.000Z`;
  writeFileSync(join(proj, `${S}.jsonl`), [
    user(d('07:20'), 'hello'),
    call(d('07:30')), // other: no mark yet
    command(d('08:00'), 'k-intake'),
    call(d('08:01')), // intake
    call(d('09:00'), tool('Skill', { skill: 'k-done' })), // k-done: the Skill call takes its own mark
    call(d('09:05')), // k-done
    bash(d('10:00'), 'cd ~/sources/weather && k step finish weather/offline-forecast S-0'), // step follow-up
    call(d('10:05')), // step follow-up
    bash(d('11:00'), 'git merge --no-ff task/offline-forecast'), // review and merge
    call(d('11:05')), // review and merge
    command(d('12:00'), 'clear'),
    call(d('12:05')), // other: a /clear resets
    call(d('13:30')), // S-1
    call(d('14:30')), // step follow-up: S-1 ended before it, no mark between
    bash(d('15:00'), 'k bug review weather/offline-forecast'), // review and merge
    call(d('15:10')), // review and merge
    user(d('16:00'), '<bash-input>k accept weather/offline-forecast</bash-input>'),
    call(d('16:05')), // k-done: the owner's own k accept
    command(d('17:00'), 'k-start'),
    call(d('17:05')), // other: k-start resets
  ].join('\n') + '\n');
  // An agent's own Skill call marks only the agent: S's kind at the agent's first call stays the main session's.
  writeFileSync(join(proj, S, 'subagents', `agent-${A}.jsonl`), [
    user(d('08:10'), 'find it'),
    call(d('08:10'), tool('Skill', { skill: 'k-done' })), // intake, S's mark at 08:00
    call(d('08:20')), // intake
  ].join('\n') + '\n');
  writeFileSync(join(proj, S, 'subagents', `agent-${A}.meta.json`), JSON.stringify({ agentType: 'scout', description: 'find it' }));
  const out = join(w.root, 'review');
  const r = k(w.home, ['usage', '--from', FROM, '--to', TO, '--out', out], { CLAUDE_CONFIG_DIR: config, TZ: 'UTC' });
  return { out, r };
}

test('calls.jsonl writes a mark row for a command line, a Skill call and a Bash call running a k or git command (AC-11)', async () => {
  const { out, r } = await day();
  assert.equal(r.status, 0, r.stderr);
  const rows = readFileSync(join(out, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // Each transcript's in its own order, the transcripts in the folder's: sorted by where and when.
  const marks = rows.filter((x) => x.kind === 'mark').map((x) => [x.ts.slice(11, 16), x.sub ? 'agent' : 'main', x.what]).sort((p, q) => (p[1] + p[0] < q[1] + q[0] ? -1 : 1));
  assert.deepEqual(marks, [
    ['08:10', 'agent', 'skill k-done'],
    ['08:00', 'main', '/k-intake'], ['09:00', 'main', 'skill k-done'], ['10:00', 'main', 'k step finish'], ['11:00', 'main', 'git merge'],
    ['12:00', 'main', '/clear'], ['15:00', 'main', 'k bug review'], ['16:00', 'main', 'k accept'], ['17:00', 'main', '/k-start'],
  ]);
  assert.ok(rows.filter((x) => x.kind === 'mark').every((x) => x.session === S && typeof x.proj === 'string'));
  // Every other reader reads only the calls and compactions: the summary counts the 17 calls, and writes.txt no mark.
  assert.match(readFileSync(join(out, 'summary.txt'), 'utf8'), /^calls 17 \(main 15, agents 2\)/m);
  assert.doesNotMatch(readFileSync(join(out, 'writes.txt'), 'utf8'), /NaN|undefined/);
});

test("tasks.txt splits a task's no-step row into its five kinds under it, and tasks.tsv has a kind column (AC-11)", async () => {
  const { out, r } = await day();
  assert.equal(r.status, 0, r.stderr);
  const tasks = readFileSync(join(out, 'tasks.txt'), 'utf8');
  const rows = tasks.trim().split('\n').slice(1).map((l) => /^(\s*\S.*?)\s+([\d.]+)M\s+([\d.]+)%\s+(\d+) calls$/.exec(l)).map((m) => [m[1], Number(m[4])]);
  assert.deepEqual(rows, [
    [T, 17],
    ['  no step', 16],
    ['    intake', 3], // 08:01 and the agent's two calls
    ['    review and merge', 4], // the merge's call, 11:05, k bug review's call, 15:10
    ['    k-done', 3], // the Skill's call, 09:05, 16:05
    ['    step follow-up', 3], // k step finish's call, 10:05, 14:30 after S-1
    ['    other', 3], // 07:30 before any mark, 12:05 after /clear, 17:05 after k-start
    ['  S-1', 1],
    ['no task', 0],
  ]);

  const tsv = readFileSync(join(out, 'tasks.tsv'), 'utf8').trim().split('\n');
  assert.equal(tsv[1], 'task\tstep\tkind\tweight\tcalls');
  const leaf = tsv.slice(2).map((l) => l.split('\t'));
  assert.deepEqual(leaf.map((l) => [l[0], l[1], l[2], Number(l[4])]), [
    [T, 'no step', 'intake', 3], [T, 'no step', 'review and merge', 4], [T, 'no step', 'k-done', 3], [T, 'no step', 'step follow-up', 3],
    [T, 'no step', 'other', 3], [T, 'S-1', '', 1], ['no task', '', '', 0],
  ]);
  // The five kinds sum to the task's no-step row, in calls and in weight.
  const kinds = leaf.filter((l) => l[1] === 'no step');
  assert.equal(kinds.reduce((s, l) => s + Number(l[4]), 0), 16);
  assert.equal(kinds.reduce((s, l) => s + Number(l[3]), 0), 16 * OPUS);
});

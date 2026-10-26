import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_FRESH_S, attribute, decide, IDLE_MIN, LAG, lastUsage, limitOf, OVERSHOOT, projectRoot, runningAgents, SLACK, thresholdOf,
  updateRecord, userWindow, windowOf, windowSetting,
} from '../hooks/compact-rules.mjs';
import { factsOf } from '../hooks/kirunak-compact.mjs';
import { boundarySince, runningBy } from '../lib/steps.mjs';
import { makeRepos, writeJson } from './fixtures/compact/repos.mjs';

// The step boundary and the PreCompact hook (design/orchestrator.md §5).

const HOOK = fileURLToPath(new URL('../hooks/kirunak-compact.mjs', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/compact/', import.meta.url));
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const MODEL = 'claude-opus-5-5';

// Transcript lines with only what the hook reads.
const assistant = (ctx, model = MODEL, extra = {}) =>
  JSON.stringify({ type: 'assistant', ...extra, message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: ctx - 102, output_tokens: 5 } } });
const toolResult = (bytes) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(bytes) }] } });
const writeTranscript = (path, lines) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
};

// ---- §1 The step boundary (R1.1-R1.4, E-2) ----

test('runningBy: two steps started in the same minute hold the boundary until the second finishes (E-2)', () => {
  const dir = makeRepos().top;
  const text = fixture('progress-overlap.md');
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-3']);
  assert.deepEqual(runningBy(`${text}2026-01-05 23:58 S-3 finished\n`, ['s-main'], dir), []);
});

test('runningBy: the chain\'s old id holds, a by-hand or k run start does not, needs.json pauses, failed closes', () => {
  const dir = makeRepos().top;
  const text = fixture('progress-mixed.md');
  assert.deepEqual(runningBy(text, ['s-main', 's-old'], dir), ['S-1', 'S-4', 'S-6']);
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-4', 'S-6']);
  writeJson(join(dir, 'steps', 'S-4', 'needs.json'), { owner: 'which one?' });
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-6']);
  assert.deepEqual(runningBy(`${text}2026-01-05 11:00 S-4 resumed (session k-run-2)\n`, ['s-main'], join(dir, 'none')), ['S-4', 'S-6']);
  assert.deepEqual(runningBy(text, [], dir), []);
  assert.deepEqual(runningBy('', ['s-main'], dir), []);
});

test('boundarySince: a line after the first block that leaves none of the chain running, in file order (R1.4)', () => {
  const dir = makeRepos().top;
  const head = '2026-01-05 10:00 S-1 started (session s-main)\n';
  const lines = (text) => text.split('\n').length - 1;
  const same = `${head}2026-01-05 10:40 S-1 finished\n2026-01-05 10:40 S-2 started (session s-main)\n`;
  assert.equal(boundarySince(same, ['s-main'], dir, { line: lines(head) }), true, 'finished and started in the same minute');
  assert.equal(boundarySince(same, ['s-main'], dir, { line: lines(same) }), false, 'the gap before the first block');
  const overlap = `${head}2026-01-05 10:05 S-2 started (session s-main)\n`;
  const later = `${overlap}2026-01-05 10:30 S-1 finished\n2026-01-05 10:31 S-3 started (session s-main)\n2026-01-05 10:50 S-2 failed: red\n`;
  assert.equal(boundarySince(later, ['s-main'], dir, { line: lines(overlap) }), false, 'overlapping steps: the gap never opens');
  const other = `${head}2026-01-05 10:10 S-9 started (session s-other)\n2026-01-05 10:20 S-1 finished\n2026-01-05 10:20 S-2 started (session s-main)\n`;
  assert.equal(boundarySince(other, ['s-main'], dir, { line: lines(head) }), true, 'another session\'s step holds nothing');
  writeJson(join(dir, 'steps', 'S-2', 'needs.json'), { owner: 'which one?' });
  const paused = `${overlap}2026-01-05 10:30 S-1 finished\n2026-01-05 10:31 S-3 started (session s-main)\n`;
  assert.equal(boundarySince(paused, ['s-main'], dir, { line: lines(overlap) }), true, 'a paused step is not running');
  assert.equal(boundarySince(same, ['s-main'], dir, null), false);
});

test('boundarySince: progress.md shorter than at the block, or no line recorded, counts the lines stamped after its minute (R1.4)', () => {
  const dir = makeRepos().top;
  const pad = (x) => String(x).padStart(2, '0');
  const at = new Date(2026, 0, 5, 10, 20, 30);
  const stamp = (min) => `2026-01-05 ${pad(at.getHours())}:${pad(min)}`;
  const text = (min) => `${stamp(0)} S-1 started (session s-main)\n${stamp(min)} S-1 finished\n${stamp(min)} S-2 started (session s-main)\n`;
  assert.equal(boundarySince(text(21), ['s-main'], dir, { at: at.toISOString(), line: 40 }), true);
  assert.equal(boundarySince(text(20), ['s-main'], dir, { at: at.toISOString(), line: 40 }), false, 'the block\'s own minute is before it');
  assert.equal(boundarySince(text(21), ['s-main'], dir, { at: at.toISOString(), line: null }), true);
  assert.equal(boundarySince(text(21), ['s-main'], dir, { at: 'not a time', line: null }), false);
});

test('runningBy: a 2,000-line progress.md in under 5 ms', () => {
  const dir = makeRepos().top;
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`2026-01-05 10:00 S-${i} started (session s-main)`, `2026-01-05 10:01 S-${i} finished`);
  const text = `${lines.join('\n')}\n2026-01-05 11:00 S-9999 started (session s-main)\n`;
  runningBy(text, ['s-main'], dir);
  const t0 = performance.now();
  const got = runningBy(text, ['s-main'], dir);
  const ms = performance.now() - t0;
  assert.deepEqual(got, ['S-9999']);
  assert.ok(ms < 5, `${ms.toFixed(2)} ms`);
});

// ---- §2 The context, the model, the window, the threshold (R2.1-R2.7) ----

test('lastUsage: the newest main-thread entry, passing over a synthetic one and a sidechain one', () => {
  const r = makeRepos();
  const path = join(r.top, 't.jsonl');
  writeFileSync(path, fixture('transcript.jsonl'));
  assert.deepEqual(lastUsage(path), { ctx: 152203, model: MODEL });
  writeFileSync(path, '{"type":"user","message":{"content":"no usage"}}\n');
  assert.equal(lastUsage(path), null);
  assert.equal(lastUsage(join(r.top, 'missing.jsonl')), null);
  assert.equal(lastUsage(null), null);
});

test('lastUsage: two 300 KB tool results after the last assistant entry are read past in the second read', () => {
  const path = join(makeRepos().top, 't.jsonl');
  writeTranscript(path, [assistant(90000), assistant(140000), toolResult(300 * 1024), toolResult(300 * 1024)]);
  assert.deepEqual(lastUsage(path), { ctx: 140000, model: MODEL });
  writeTranscript(path, [assistant(140000), toolResult(1100 * 1024)]);
  assert.equal(lastUsage(path), null);
});

test('lastUsage: an agent\'s own transcript, every entry a sidechain one, is read with sidechain; the main\'s reading passes over them', () => {
  const path = join(makeRepos().top, 'agent-a1.jsonl');
  const side = { isSidechain: true };
  writeTranscript(path, [assistant(120000, MODEL, side), assistant(180000, MODEL, side)]);
  assert.equal(lastUsage(path), null, 'the main\'s reading skips every sidechain entry');
  assert.deepEqual(lastUsage(path, { sidechain: true }), { ctx: 180000, model: MODEL });
  writeTranscript(path, [assistant(140000), assistant(9000, MODEL, side)]);
  assert.deepEqual(lastUsage(path), { ctx: 140000, model: MODEL }, 'a trailing sidechain entry of the main transcript');
  writeTranscript(path, [assistant(170000, MODEL, side), toolResult(300 * 1024)]);
  assert.deepEqual(lastUsage(path, { sidechain: true }), { ctx: 170000, model: MODEL }, 'the second read keeps the option');
});

test('windowOf: the ladder\'s 1M models, [1m] ids, and 200k for any other', () => {
  for (const id of ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-x-4[1m]']) assert.equal(windowOf(id), 1_000_000, id);
  assert.equal(windowOf('claude-other-4'), 200_000);
  assert.equal(windowOf(null), 200_000);
});

test('projectRoot: a repo\'s root, its subdirectory and its worktree give the main checkout; outside git and home give cwd', () => {
  const r = makeRepos();
  assert.equal(projectRoot(r.app), r.app);
  assert.equal(projectRoot(r.sub), r.app);
  assert.equal(projectRoot(r.worktree), r.app);
  assert.equal(projectRoot(r.plain), r.plain);
  assert.equal(projectRoot(r.sub, { homeDir: r.app }), r.sub);
  assert.equal(projectRoot(r.worktree, { mode: 'cwd' }), r.worktree);
});

test('windowSetting: env, per-model over top-level, local over shared over user, the root\'s file over a leftover, none', () => {
  const r = makeRepos();
  const base = { cwd: r.app, configDir: r.configDir, model: MODEL, roots: [r.app] };
  assert.deepEqual(windowSetting({ ...base, env: {} }), { window: 183000, from: { kind: 'local', file: join(r.app, '.claude', 'settings.local.json'), key: 'autoCompactWindow' }, kirunak: true, root: r.app });
  const env = windowSetting({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } });
  assert.deepEqual([env.window, env.from.kind, env.kirunak], [300000, 'env', false]);
  writeJson(join(r.app, '.claude', 'settings.local.json'), { autoCompactWindow: 183000, modelSettings: { [MODEL]: { autoCompactWindow: 200000 } } });
  const per = windowSetting({ ...base, env: {} });
  assert.deepEqual([per.window, per.from.key], [200000, `modelSettings.${MODEL}.autoCompactWindow`]);
  let asked = 0;
  windowSetting({ ...base, env: {}, model: () => (asked++, MODEL) });
  assert.equal(asked, 1, 'the model is asked for when a file has modelSettings');
  writeJson(join(r.sub, '.claude', 'settings.local.json'), { autoCompactWindow: 400000 });
  assert.equal(windowSetting({ ...base, cwd: r.sub, env: {} }).window, 200000, 'the root\'s file wins over a leftover');
  rmSync(join(r.app, '.claude', 'settings.local.json'));
  const left = windowSetting({ ...base, cwd: r.sub, env: {} });
  assert.deepEqual([left.window, left.from.kind, left.kirunak], [400000, 'local', true]);
  writeJson(join(r.plain, '.claude', 'settings.json'), { autoCompactWindow: 350000 });
  const shared = windowSetting({ ...base, cwd: r.plain, env: {} });
  assert.deepEqual([shared.window, shared.from.kind, shared.kirunak], [350000, 'shared', false]);
  const user = windowSetting({ ...base, cwd: r.worktree, env: {} });
  assert.deepEqual([user.window, user.from.kind, user.kirunak], [500000, 'user', false]);
  rmSync(join(r.configDir, 'settings.json'));
  assert.deepEqual(windowSetting({ ...base, cwd: r.worktree, env: {} }).from, { kind: 'none', file: null, key: null });
  const other = windowSetting({ ...base, cwd: r.other, env: {} });
  assert.deepEqual([other.window, other.from.kind, other.kirunak], [250000, 'local', false]);
});

test('thresholdOf clamps to [100,000, the model\'s window]; limitOf takes the number, else the user\'s, under the model\'s point', () => {
  assert.equal(thresholdOf(183000, 1_000_000), 150000);
  assert.equal(thresholdOf(50000, 1_000_000), 100000 - SLACK);
  assert.equal(thresholdOf(500000, 200_000), 200_000 - SLACK);
  assert.equal(thresholdOf(null, 1_000_000), 1_000_000 - SLACK);
  assert.equal(limitOf({ midStepLimit: 'user', user: 500000, wModel: 1_000_000 }), 500000);
  assert.equal(limitOf({ midStepLimit: 300000, user: 500000, wModel: 1_000_000 }), 300000);
  assert.equal(limitOf({ midStepLimit: 167000, user: 500000, wModel: 1_000_000 }), 167000, 'the default, under the user\'s window');
  assert.equal(limitOf({ midStepLimit: 167000, user: 500000, wModel: 200_000 }), 67000);
  assert.equal(limitOf({ midStepLimit: 'user', user: 1_000_000, wModel: 1_000_000 }), 867000, 'a 1M model\'s point less SLACK and LAG');
  assert.equal(limitOf({ midStepLimit: 'user', user: 500000, wModel: 200_000 }), 67000);
  const r = makeRepos({ user: { autoCompactWindow: 500000, modelSettings: { [MODEL]: { autoCompactWindow: 400000 } } } });
  assert.equal(userWindow({ configDir: r.configDir, model: MODEL, wModel: 1_000_000 }).window, 400000);
  assert.equal(userWindow({ configDir: r.configDir, model: 'claude-other-4', wModel: 200_000 }).window, 500000);
  assert.deepEqual(userWindow({ configDir: join(r.top, 'none'), model: MODEL, wModel: 1_000_000 }), { window: 1_000_000, from: { kind: 'none', key: null } });
});

// ---- §3 Whose compaction it is (R3.3) ----

test('attribute: the five rows, the edge at exactly T - LAG, and a closed turn ten minutes ago', () => {
  const T = 150000;
  const now = Date.parse('2026-01-05T12:00:00Z');
  const open = { state: 'open', at: '2026-01-05T11:59:00Z' };
  const ago = (min) => ({ state: 'closed', at: new Date(now - min * 60_000).toISOString() });
  assert.deepEqual(attribute({ turn: null, ctx: T, T, now }), { main: true, row: 1, why: null });
  assert.equal(attribute({ turn: null, ctx: T - LAG - 1, T, now }).why, 'below threshold');
  assert.equal(attribute({ turn: open, ctx: T, T, agents: [{ id: 'a1', ctx: T + OVERSHOOT }], now }).why, 'agent past threshold');
  assert.equal(attribute({ turn: open, ctx: T, T, agents: [{ id: 'a1', ctx: T + OVERSHOOT - 1 }], now }).main, true);
  assert.equal(attribute({ turn: open, ctx: T - LAG - 1, T, now }).row, 3);
  assert.deepEqual(attribute({ turn: open, ctx: T - LAG, T, now }), { main: true, row: 5, why: null });
  assert.equal(attribute({ turn: ago(10), ctx: T, T, now }).why, 'turn closed');
  assert.equal(attribute({ turn: ago(IDLE_MIN), ctx: T, T, now }).main, true, 'closed long enough for idle compaction');
  assert.equal(attribute({ turn: ago(10), ctx: 0, T, agents: [], now }).row, 4);
  assert.equal(attribute({ turn: open, ctx: T, T, agents: [{ id: 'a1', ctx: T + OVERSHOOT, stale: true }], now }).main, true, 'a stale record never counts');
});

test('runningAgents (R3.2): the records with no end, a transcript written within AGENT_FRESH_S read for its context, an older or missing one stale', () => {
  const top = makeRepos().top;
  const transcript = join(top, 'projects', 'p', 's-main.jsonl');
  const sub = (id) => join(top, 'projects', 'p', 's-main', 'subagents', `agent-${id}.jsonl`);
  writeTranscript(sub('a1'), [assistant(210000, MODEL, { isSidechain: true })]);
  const written = statSync(sub('a1')).mtimeMs;
  const record = { agents: { a1: { ended: null }, a2: { ended: null }, a3: { ended: '2026-01-05T10:00:00.000Z' }, '../x': { ended: null } } };
  const at = (now) => runningAgents(record, { transcript, session: 's-main', now });
  assert.deepEqual(at(written + AGENT_FRESH_S * 1000), [{ id: 'a1', ctx: 210000 }, { id: 'a2', ctx: null, stale: true }]);
  assert.deepEqual(at(written + AGENT_FRESH_S * 1000 + 1), [{ id: 'a1', ctx: null, stale: true }, { id: 'a2', ctx: null, stale: true }]);
  assert.deepEqual(runningAgents(null, { transcript, session: 's-main' }), []);
});

// ---- §4 The rule table, pure: each row reads only what it needs ----

test('decide: the rows in the table\'s order, each fact read only when its row is reached', async () => {
  const no = (name) => () => assert.fail(`${name} was read`);
  const base = { trigger: 'auto', config: { compact: { enabled: true } }, session: 's-main', window: { kirunak: true }, ctx: 160000, attribution: { main: true }, limit: 500000, task: 'app/demo', running: ['S-2'], passed: false };
  const row = async (f) => {
    const d = await decide({ ...base, ...f });
    return [d.decision, d.row, d.why, d.expect];
  };
  assert.deepEqual(await row({ trigger: 'manual', config: no('config') }), ['allow', 'R4.2', 'manual', true]);
  assert.deepEqual(await row({ config: null, window: no('window') }), ['allow', 'R4.3', 'state unreadable', false]);
  assert.deepEqual(await row({ config: { compact: { enabled: false } } }), ['allow', 'R4.3', 'state unreadable', false]);
  assert.deepEqual(await row({ session: '../x' }), ['allow', 'R4.3', 'state unreadable', false]);
  assert.deepEqual(await row({ window: { kirunak: false }, ctx: no('ctx') }), ['allow', 'R4.3a', "user's window", false]);
  assert.deepEqual(await row({ ctx: null, attribution: no('attribution') }), ['allow', 'R4.4', 'ctx unknown', false]);
  assert.deepEqual(await row({ attribution: { main: false, why: 'turn closed' }, limit: no('limit') }), ['allow', 'R4.5', 'turn closed', false]);
  assert.deepEqual(await row({ ctx: 500000, task: no('task') }), ['allow', 'R4.6', 'limit', true]);
  assert.deepEqual(await row({ task: null, idle: false, running: no('running') }), ['block', 'R4.7', 'no task', false]);
  assert.deepEqual(await row({ task: null, idle: true, running: no('running') }), ['allow', 'R4.7a', 'idle, no task', true]);
  assert.deepEqual(await row({ idle: no('idle') }), ['block', 'R4.8', 'running', false], 'a session holding a task keeps its rule');
  const d = await decide({ ...base, running: async () => ['S-2', 'S-3'] });
  assert.equal(d.reason, 'kirunak: S-2, S-3 are running; the compaction waits for the step boundary');
  assert.deepEqual(await row({ running: null }), ['allow', 'R4.3', 'state unreadable', false]);
  assert.deepEqual(await row({ running: [], passed: no('passed') }), ['allow', 'R4.9', 'boundary', true]);
  assert.deepEqual(await row({ passed: async () => true }), ['allow', 'R4.8a', 'boundary passed', true]);
});

// ---- §4 The hook, run as Claude Code runs it: the event on stdin, a scratch KIRUNAK_HOME and config folder ----

const STARTED = '2026-01-05 10:00 S-2 started (session s-main)\n';

// A home as k install writes it: config.json with the workspace repo `app` and its `compact` block, session
// s-main on task app/demo, the task's progress.md, a transcript whose last call is `ctx`, the user's settings file.
function makeHome({ ctx = 160000, model = MODEL, progress = STARTED, session = { task: 'app/demo', step: 'S-2' }, compact = {}, user, record = null } = {}) {
  const r = makeRepos(user === undefined ? {} : { user });
  const home = join(r.top, 'home');
  writeJson(join(home, 'escalate', 'config.json'), {
    repos: { app: r.app },
    compact: { enabled: true, handoverSize: 150000, window: 183000, midStepLimit: 'user', roots: [r.app], ...compact },
  });
  if (session) writeJson(join(home, 'sessions', 's-main.json'), session);
  if (record) writeJson(join(home, 'escalate', 's-main.json'), record);
  const dir = join(r.app, 'kirunak', 'tasks', 'demo');
  mkdirSync(dir, { recursive: true });
  if (progress != null) writeFileSync(join(dir, 'progress.md'), progress);
  const transcript = join(r.top, 'projects', 'p', 's-main.jsonl');
  if (ctx != null) writeTranscript(transcript, [assistant(ctx, model)]);
  const input = (extra = {}) => ({
    session_id: 's-main', transcript_path: transcript, cwd: r.app, prompt_id: 'p1', hook_event_name: 'PreCompact', trigger: 'auto',
    custom_instructions: null, ...extra,
  });
  const log = () => (existsSync(join(home, 'compact.log')) ? readFileSync(join(home, 'compact.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const expected = () => (existsSync(join(home, 'compact', 's-main.json')) ? JSON.parse(readFileSync(join(home, 'compact', 's-main.json'), 'utf8')).expect ?? null : null);
  return { ...r, home, dir, transcript, input, log, expected };
}

// The environment without this session's own kirunak and compaction settings, so a test never reads the real ones.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^KIRUNAK_|^CLAUDE_CODE_AUTO_COMPACT_WINDOW$|^CLAUDE_CONFIG_DIR$/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function run(h, input = h.input(), env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input), cwd: h.top, encoding: 'utf8',
    env: cleanEnv({ KIRUNAK_HOME: h.home, CLAUDE_CONFIG_DIR: h.configDir, ...env }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return { out: r.stdout ? JSON.parse(r.stdout) : null, line: h.log().at(-1) ?? null };
}

const allowed = (r, why) => {
  assert.equal(r.out, null, 'an allow prints nothing');
  assert.equal(r.line.decision, 'allow');
  assert.equal(r.line.why, why);
};

test('R4.8: a step the session started is running: blocked with the reason, logged with every field (AC-4)', () => {
  const h = makeHome();
  const r = run(h);
  assert.deepEqual(r.out, { decision: 'block', reason: 'kirunak: S-2 is running; the compaction waits for the step boundary' });
  assert.deepEqual(Object.keys(r.line), ['ts', 'session', 'cwd', 'trigger', 'ctx', 'model', 'window', 'T', 'limit', 'turn', 'agents', 'steps', 'decision', 'row', 'why']);
  assert.deepEqual({ ...r.line, ts: null }, {
    ts: null, session: 's-main', cwd: h.app, trigger: 'auto', ctx: 160000, model: MODEL,
    window: { value: 183000, from: { kind: 'local', file: join(h.app, '.claude', 'settings.local.json'), key: 'autoCompactWindow' } },
    T: 150000, limit: 500000, turn: null, agents: [], steps: ['S-2'], decision: 'block', row: 'R4.8', why: 'running',
  });
  assert.equal(h.expected(), null);
});

test('R4.9: no step of the session running is a boundary: allowed, and expect recorded (AC-1)', () => {
  const h = makeHome({ progress: `${STARTED}2026-01-05 10:30 S-2 finished\n` });
  const r = run(h);
  allowed(r, 'boundary');
  assert.deepEqual(r.line.steps, []);
  const e = h.expected();
  assert.deepEqual({ ...e, at: null }, { at: null, why: 'boundary', ctx: 160000 });
  assert.equal(e.at, r.line.ts);
});

test('R4.8 and R1.2: a step started under the chain\'s old id holds the block; one of another session does not', () => {
  const old = '2026-01-05 10:00 S-2 started (session s-old)\n';
  assert.equal(run(makeHome({ progress: old, session: { task: 'app/demo', previous: ['s-old'] } })).out.decision, 'block');
  allowed(run(makeHome({ progress: old })), 'boundary');
});

test('R4.1: in a k run step the hook reads and writes nothing, though everything else says block (E-6, O-1)', () => {
  const h = makeHome();
  const r = run(h, h.input(), { KIRUNAK_STEP: 'S-2' });
  assert.deepEqual(r, { out: null, line: null });
  assert.equal(existsSync(join(h.home, 'compact')), false);
});

test('R4.2: a manual /compact is allowed while a step runs, and expect recorded (E-4)', () => {
  const h = makeHome();
  allowed(run(h, h.input({ trigger: 'manual', custom_instructions: 'keep the plan' })), 'manual');
  assert.equal(h.expected().why, 'manual');
});

test('R4.3: no config, a corrupt one, compact switched off, a bad id, an unknown repo, unreadable input: allowed (E-7)', () => {
  const gone = makeHome();
  rmSync(join(gone.home, 'escalate', 'config.json'));
  allowed(run(gone), 'state unreadable');
  const corrupt = makeHome();
  writeFileSync(join(corrupt.home, 'escalate', 'config.json'), '{ not json');
  allowed(run(corrupt), 'state unreadable');
  allowed(run(makeHome({ compact: { enabled: false } })), 'state unreadable');
  const bad = makeHome();
  allowed(run(bad, bad.input({ session_id: '../s-main' })), 'state unreadable');
  allowed(run(makeHome({ session: { task: 'nope/demo' } })), 'state unreadable');
  const raw = makeHome();
  allowed(run(raw, 'not json'), 'state unreadable');
});

test('R4.3a: outside the workspace\'s roots, with the environment variable, or no window in the repo\'s file: never blocked (E-10)', () => {
  const h = makeHome();
  const plain = run(h, h.input({ cwd: h.plain }));
  allowed(plain, "user's window");
  assert.deepEqual([plain.line.window.value, plain.line.window.from.kind, plain.line.ctx], [500000, 'user', null]);
  const other = run(h, h.input({ cwd: h.other }));
  allowed(other, "user's window");
  assert.deepEqual([other.line.window.value, other.line.window.from.kind], [250000, 'local']);
  const env = run(h, h.input(), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '183000' });
  allowed(env, "user's window");
  assert.equal(env.line.window.from.kind, 'env');
  assert.equal(run(h, h.input({ cwd: h.sub })).out.decision, 'block', 'a subdirectory reads the root\'s file');
  assert.equal(run(h, h.input({ cwd: h.worktree })).out.decision, 'block', 'a worktree reads the main checkout\'s file');
  rmSync(join(h.app, '.claude', 'settings.local.json'));
  allowed(run(h), "user's window");
  assert.equal(h.expected(), null, 'no expect outside the handover');
});

test('R4.4: no usage in the transcript: allowed, since the limit cannot be bounded (E-7, E-1)', () => {
  allowed(run(makeHome({ ctx: null })), 'ctx unknown');
});

test('R4.5: below the threshold with the turn open, a turn closed ten minutes ago, an agent past it: allowed (E-6)', () => {
  const at = new Date().toISOString();
  allowed(run(makeHome({ ctx: 40000, record: { turn: { state: 'open', at } } })), 'below threshold');
  allowed(run(makeHome({ record: { turn: { state: 'closed', at: new Date(Date.now() - 10 * 60_000).toISOString() } } })), 'turn closed');
  const agent = (ended) => {
    const h = makeHome({ record: { turn: { state: 'open', at }, agents: { a1: { type: 'general-purpose', at, ended } } } });
    writeTranscript(join(h.top, 'projects', 'p', 's-main', 'subagents', 'agent-a1.jsonl'), [assistant(200000, MODEL, { isSidechain: true })]);
    return run(h);
  };
  const past = agent(null);
  allowed(past, 'agent past threshold');
  assert.deepEqual(past.line.agents, [{ id: 'a1', ctx: 200000 }]);
  assert.equal(agent(at).out.decision, 'block', 'an agent that ended is not counted');
});

test('R3.2: agent records whose ends were never written, their transcripts long untouched, do not take the main\'s fire past T', () => {
  const at = new Date().toISOString();
  const agents = Object.fromEntries(['a1', 'a2', 'a3'].map((id) => [id, { type: 'general-purpose', at: '2026-01-04T23:00:00.000Z', ended: null }]));
  const h = makeHome({ ctx: 464000, progress: `${STARTED}2026-01-05 10:30 S-2 finished\n`, record: { turn: { state: 'open', at }, agents } });
  const sub = (id) => join(h.top, 'projects', 'p', 's-main', 'subagents', `agent-${id}.jsonl`);
  const old = new Date(Date.now() - (AGENT_FRESH_S + 60) * 1000);
  for (const [id, ctx] of [['a1', 190000], ['a2', 206000]]) {
    writeTranscript(sub(id), [assistant(ctx, MODEL, { isSidechain: true })]);
    utimesSync(sub(id), old, old);
  }
  const stale = run(h);
  allowed(stale, 'boundary');
  assert.equal(stale.line.row, 'R4.9');
  assert.deepEqual(stale.line.agents, ['a1', 'a2', 'a3'].map((id) => ({ id, ctx: null, stale: true })), 'two past T + OVERSHOOT, one with no transcript');
  assert.equal(h.expected().why, 'boundary', 'the main\'s compaction, so SessionStart puts the task back');
  const now = new Date();
  utimesSync(sub('a2'), now, now);
  const fresh = run(h);
  allowed(fresh, 'agent past threshold');
  assert.deepEqual(fresh.line.agents[1], { id: 'a2', ctx: 206000 }, 'written within AGENT_FRESH_S, an agent past T + OVERSHOOT still is');
});

test('R4.6: past the mid-step limit: the user\'s window, the workspace\'s number, none set, a per-model window (E-1, E-3, D-2)', () => {
  const user = run(makeHome({ ctx: 500000 }));
  allowed(user, 'limit');
  assert.equal(user.line.limit, 500000);
  assert.equal(run(makeHome({ ctx: 499000 })).out.decision, 'block');
  allowed(run(makeHome({ ctx: 320000, compact: { midStepLimit: 300000 } })), 'limit');
  const none = run(makeHome({ ctx: 600000, user: {} }));
  assert.deepEqual([none.out.decision, none.line.limit], ['block', 867000]);
  const per = run(makeHome({ ctx: 420000, user: { autoCompactWindow: 500000, modelSettings: { [MODEL]: { autoCompactWindow: 400000 } } } }));
  assert.deepEqual([per.line.decision, per.line.limit], ['allow', 400000]);
});

test('R4.6 on a 200k model: the limit below the threshold, so at most one request is held (E-8)', () => {
  const held = run(makeHome({ ctx: 60000, model: 'claude-other-4' }));
  assert.deepEqual([held.out.decision, held.line.T, held.line.limit], ['block', 150000, 67000]);
  allowed(run(makeHome({ ctx: 67000, model: 'claude-other-4' })), 'limit');
});

test('R4.6, R4.8, R4.7: the default limit of 167,000 holds a step and a session with no task at 160k, both let through at 167k (E-1, E-3, D-2)', () => {
  const at = (ctx, extra = {}) => run(makeHome({ ctx, compact: { midStepLimit: 167000 }, user: { autoCompactWindow: 500000 }, ...extra }));
  const mid = at(160000);
  assert.deepEqual([mid.out.decision, mid.line.row, mid.line.T, mid.line.limit], ['block', 'R4.8', 150000, 167000], 'the band between the threshold and the limit holds');
  const past = at(167000);
  allowed(past, 'limit');
  assert.deepEqual([past.line.row, past.line.limit], ['R4.6', 167000], 'the user\'s 500,000 is not the limit');
  const free = at(160000, { session: null });
  assert.deepEqual([free.out.decision, free.line.row], ['block', 'R4.7']);
  allowed(at(167000, { session: null }), 'limit');
  const small = at(167000, { model: 'claude-other-4' });
  assert.deepEqual([small.line.decision, small.line.limit], ['allow', 67000], 'on a 200k model the model\'s point still bounds it (E-8)');
});

test('R4.7: a session with no task in a workspace repo is held to the limit, as today (E-3)', () => {
  const r = run(makeHome({ session: { step: null } }));
  assert.deepEqual(r.out, { decision: 'block', reason: 'kirunak: this session holds no task; the compaction waits for the mid-step limit' });
  assert.equal(run(makeHome({ session: null })).line.why, 'no task');
});

test('R4.7a: in a session with no task, an idle compaction (the turn closed IDLE_MIN ago) is let through, as today (E-3)', () => {
  const closed = (min) => ({ turn: { state: 'closed', at: new Date(Date.now() - min * 60_000).toISOString() } });
  const h = makeHome({ session: { step: null }, record: closed(IDLE_MIN) });
  const r = run(h);
  allowed(r, 'idle, no task');
  assert.deepEqual([r.line.row, r.line.turn, h.expected().why], ['R4.7a', 'closed', 'idle, no task']);
  assert.equal(run(makeHome({ session: null, record: closed(IDLE_MIN + 5) })).line.why, 'idle, no task');
  assert.equal(run(makeHome({ session: null, record: { turn: { state: 'open', at: new Date(Date.now() - 60 * 60_000).toISOString() } } })).line.why, 'no task');
  assert.equal(run(makeHome({ record: closed(IDLE_MIN + 5) })).out.decision, 'block', 'a session holding a task keeps R4.8');
});

// ---- R1.4: a boundary no fire saw, after the first block ----

test('R1.4: after a block, S-2 finished and S-3 started in the same minute is a boundary passed: allowed once, the record cleared', () => {
  const h = makeHome();
  const rec = () => JSON.parse(readFileSync(join(h.home, 'compact', 's-main.json'), 'utf8'));
  assert.equal(run(h).out.decision, 'block');
  const first = rec().blocked;
  assert.equal(first.line, 1);
  assert.equal(first.at, h.log().at(-1).ts);
  writeFileSync(join(h.dir, 'progress.md'), `${STARTED}2026-01-05 10:40 S-2 finished\n2026-01-05 10:40 S-3 started (session s-main)\n`);
  const r = run(h);
  allowed(r, 'boundary passed');
  assert.deepEqual([r.line.row, r.line.steps, h.expected().why], ['R4.8a', ['S-3'], 'boundary passed']);
  assert.equal(rec().blocked, undefined, 'an allow clears it');
  assert.equal(run(h).out.decision, 'block', 'S-3 runs: a new first block');
  assert.equal(rec().blocked.line, 3);
});

test('R1.4: overlapping steps whose gap never opens stay blocked; the first block\'s record is kept, not moved', () => {
  const h = makeHome({ progress: `${STARTED}2026-01-05 10:05 S-3 started (session s-main)\n` });
  const rec = () => JSON.parse(readFileSync(join(h.home, 'compact', 's-main.json'), 'utf8'));
  assert.equal(run(h).out.decision, 'block');
  const first = rec().blocked;
  appendFileSync(join(h.dir, 'progress.md'), '2026-01-05 10:30 S-2 finished\n2026-01-05 10:31 S-4 started (session s-main)\n2026-01-05 10:50 S-3 finished\n');
  const r = run(h);
  assert.deepEqual([r.out.decision, r.line.why, r.line.steps], ['block', 'running', ['S-4']]);
  assert.deepEqual(rec().blocked, first);
});

test('R1.4: a boundary before the first block holds nothing: S-2 finished and S-3 started before it, S-3 still running', () => {
  const h = makeHome({ progress: `${STARTED}2026-01-05 10:30 S-2 finished\n2026-01-05 10:30 S-3 started (session s-main)\n` });
  assert.equal(run(h).out.decision, 'block');
  assert.equal(run(h).out.decision, 'block');
  appendFileSync(join(h.dir, 'progress.md'), '2026-01-05 10:45 S-4 started (session s-main)\n');
  assert.deepEqual([run(h).out.decision, h.log().at(-1).why], ['block', 'running']);
});

test('R1.4: a block with the context under T records nothing (an agent\'s fire held with the main\'s, R3.4); the first at T does', () => {
  const h = makeHome({ ctx: 120000, record: { turn: { state: 'open', at: new Date().toISOString() } } });
  assert.equal(run(h).out.decision, 'block');
  assert.equal(existsSync(join(h.home, 'compact', 's-main.json')), false);
  appendFileSync(join(h.dir, 'progress.md'), '2026-01-05 10:40 S-2 finished\n2026-01-05 10:40 S-3 started (session s-main)\n');
  writeTranscript(h.transcript, [assistant(160000)]);
  assert.deepEqual([run(h).out.decision, h.log().at(-1).why], ['block', 'running'], 'the gap came before the main was due');
  assert.equal(JSON.parse(readFileSync(join(h.home, 'compact', 's-main.json'), 'utf8')).blocked.line, 3);
});

test('R1.4: a session with no task records its first block too; the limit\'s allow clears it', () => {
  const h = makeHome({ session: { step: null } });
  const rec = () => JSON.parse(readFileSync(join(h.home, 'compact', 's-main.json'), 'utf8'));
  assert.equal(run(h).line.why, 'no task');
  assert.deepEqual(Object.keys(rec().blocked), ['at', 'line']);
  assert.equal(rec().blocked.line, null, 'progress.md not read');
  writeTranscript(h.transcript, [assistant(500000)]);
  allowed(run(h), 'limit');
  assert.equal(rec().blocked, undefined);
});

// ---- compact/<session>.json: one read, change and write at a time (R6.6) ----

test('updateRecord: merged under the lock; nothing written for null; a held lock skips the write, a stale one is taken over', () => {
  const path = join(makeRepos().top, 'home', 'compact', 's-main.json');
  const lock = `${path}.lock`;
  assert.deepEqual(updateRecord(path, (r) => ({ ...r, expect: { why: 'boundary' } })), { expect: { why: 'boundary' } });
  assert.deepEqual(updateRecord(path, (r) => ({ ...r, fire: { put: true } })), { expect: { why: 'boundary' }, fire: { put: true } });
  assert.equal(existsSync(lock), false, 'the lock released');
  let seen = null;
  assert.deepEqual(updateRecord(path, (r) => ((seen = r), null)), { expect: { why: 'boundary' }, fire: { put: true } });
  assert.deepEqual(seen, JSON.parse(readFileSync(path, 'utf8')));
  mkdirSync(lock);
  const t0 = performance.now();
  assert.deepEqual(updateRecord(path, () => ({ lost: true })), { lost: true }, 'the change still decides');
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).lost, undefined, 'another writer holds it: skipped');
  assert.ok(existsSync(lock), 'another\'s lock is left');
  utimesSync(lock, new Date(Date.now() - 3000), new Date(Date.now() - 3000));
  updateRecord(path, (r) => ({ ...r, taken: true }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).taken, true, 'a crashed writer\'s lock taken over');
  assert.equal(existsSync(lock), false);
});

test('R6.6: the PreCompact hook writes expect under the lock: with another writer holding it, the allow stands and the write waits', () => {
  const h = makeHome({ progress: `${STARTED}2026-01-05 10:30 S-2 finished\n` });
  mkdirSync(join(h.home, 'compact', 's-main.json.lock'), { recursive: true });
  allowed(run(h), 'boundary');
  assert.equal(h.expected(), null);
  rmSync(join(h.home, 'compact', 's-main.json.lock'), { recursive: true });
  run(h);
  assert.equal(h.expected().why, 'boundary');
});

// ---- The numbers (§12): the hook's wall time ----

const best = (n, fn) => Math.min(...Array.from({ length: n }, () => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}));

test('the hook on a 1 MB transcript tail with a step running takes under 150 ms', (t) => {
  const h = makeHome();
  writeTranscript(h.transcript, [assistant(160000), toolResult(300 * 1024), toolResult(300 * 1024), toolResult(300 * 1024)]);
  const wall = best(5, () => assert.equal(run(h).out.decision, 'block'));
  t.diagnostic(`hook wall time, 1 MB tail, best of 5: ${wall.toFixed(1)} ms`);
  assert.ok(wall < 150, `${wall.toFixed(1)} ms`);
});

// A few milliseconds, which a loaded machine can pass (the full suite once took 5.44): only with KIRUNAK_TIMING=1.
test('the E-10 path takes under 5 ms in-process, best of 5 run one after another', { skip: process.env.KIRUNAK_TIMING !== '1' }, async (t) => {
  const h = makeHome();
  const env = { CLAUDE_CONFIG_DIR: h.configDir };
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const d = await decide(factsOf(h.input({ cwd: h.plain }), h.home, env).facts);
    assert.equal(d.why, "user's window");
    times.push(performance.now() - t0);
  }
  const e10 = Math.min(...times);
  t.diagnostic(`E-10 path in-process, best of 5: ${e10.toFixed(2)} ms`);
  assert.ok(e10 < 5, `${e10.toFixed(2)} ms`);
});

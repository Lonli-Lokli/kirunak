import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_FRESH_S, BOUNDARY_WAIT_S, boundaryIn, CAP, CLEAR_S, cut, EXPECT_S, IDLE_MIN, LAG, labelOf, lastOf, OVERSHOOT, PARTS_S, planFor,
  PRUNE_DAYS, SLACK, stateText, waitingLines,
} from '../hooks/compact-rules.mjs';
import { makeRepos, writeJson } from './fixtures/compact/repos.mjs';
import { makeWorkspace } from './helpers.mjs';

// The task put back after a compaction and after /clear (design/orchestrator.md §5, R5.1-R5.5).

// ---- The docs: orchestrator.md §5's numbers name each constant with the value the hooks use ----

test('orchestrator.md §5\'s numbers name every constant of the handover with its value', () => {
  const doc = readFileSync(fileURLToPath(new URL('../design/orchestrator.md', import.meta.url)), 'utf8');
  const numbers = /\*\*The numbers\.\*\*[\s\S]*?\n\n/.exec(doc)?.[0].replace(/\s+/g, ' ') ?? '';
  const all = { SLACK, LAG, OVERSHOOT, AGENT_FRESH_S, IDLE_MIN, CAP, EXPECT_S, BOUNDARY_WAIT_S, CLEAR_S, PARTS_S, PRUNE_DAYS };
  for (const [name, v] of Object.entries(all)) assert.ok(numbers.includes(`\`${name}\` = ${v.toLocaleString('en-US')}`), name);
});

// ---- The parts' text (R5.1) ----

const numbered = (n, width = 30) => `${Array.from({ length: n }, (_, i) => `line ${String(i).padStart(3, '0')} ${'y'.repeat(width)}`).join('\n')}\n`;

test('cut and lastOf: whole up to exactly CAP; over it, within CAP at a line end or start, naming the whole file', () => {
  const exact = `${'x'.repeat(CAP - 1)}\n`;
  assert.equal(cut(exact, CAP, '/r/task.md'), exact);
  assert.equal(lastOf(exact, CAP, '/r/progress.md'), exact);
  const text = numbered(400);
  const c = cut(text, CAP, '/r/plan.md');
  assert.ok(c.length <= CAP, `${c.length}`);
  assert.match(c, /\n… cut at 9,500 characters; the whole file: \/r\/plan\.md$/);
  assert.ok(text.startsWith(c.slice(0, c.lastIndexOf('\n') + 1)));
  const l = lastOf(text, CAP, '/r/progress.md');
  const [first, ...rest] = l.split('\n');
  assert.ok(l.length <= CAP, `${l.length}`);
  assert.equal(first, '… cut at 9,500 characters, its last lines kept; the whole file: /r/progress.md');
  assert.match(rest[0], /^line \d{3} y+$/);
  assert.ok(text.endsWith(rest.join('\n')));
  assert.equal(cut('z'.repeat(20000), CAP, 'f').length, CAP);
  assert.equal(lastOf('z'.repeat(20000), CAP, 'f').length, CAP);
});

const block = (id, size) => `### ${id} Step ${id} [agent]\nwhat: ${'w'.repeat(size)}\n\n`;
const planOf = (size) => `---\ntask: app/demo\n---\n\nThe header.\n\n${['S-1', 'S-2', 'S-3', 'S-4'].map((id) => block(id, size)).join('')}`;
const STATES = new Map([['S-1', { state: 'done' }], ['S-2', { state: 'running' }], ['S-3', 'ready'], ['S-4', 'pending']]);
const ids = (text) => [...text.matchAll(/^### (S-\d+)/gm)].map((m) => m[1]);

test('planFor: the header and the steps not finished; over CAP the running and ready ones; still over, cut', () => {
  const fits = planFor(planOf(2000), STATES, '/r/plan.md');
  assert.ok(fits.startsWith('---\ntask: app/demo\n---\n\nThe header.\n\n### S-2 '));
  assert.deepEqual(ids(fits), ['S-2', 'S-3', 'S-4']);
  assert.match(fits, /\n\n… left out, the blocks of S-1; the whole file: \/r\/plan\.md$/);
  const over = planFor(planOf(3200), STATES, '/r/plan.md');
  assert.deepEqual(ids(over), ['S-2', 'S-3']);
  assert.ok(over.length <= CAP, `${over.length}`);
  assert.match(over, /… left out, the blocks of S-1, S-4; the whole file: \/r\/plan\.md$/);
  const cutPlan = planFor(planOf(5000), STATES, '/r/plan.md');
  assert.ok(cutPlan.length <= CAP, `${cutPlan.length}`);
  assert.match(cutPlan, /\n… cut at [\d,]+ characters; the whole file: \/r\/plan\.md\n… left out, the blocks of S-1, S-4; /);
  assert.deepEqual(ids(planFor(planOf(100), new Map(), '/r/plan.md')), ['S-1', 'S-2', 'S-3', 'S-4']);
  assert.equal(planFor('# no steps\n', STATES, '/r/plan.md'), '# no steps\n');
});

test('labelOf, waitingLines (only the task\'s rows, each with what k says) and boundaryIn (R5.2)', () => {
  assert.equal(labelOf('plan', 'compact'), 'kirunak, after a compaction (part 3 of 4): plan');
  assert.equal(labelOf('state', 'clear'), 'kirunak, after /clear (part 1 of 4): state');
  const w = {
    stopped: [{ id: 'app/demo', lines: ['Demo (app/demo): S-2 is waiting for your answer', 'why: which file?'] }, { id: 'app/other', lines: ['x'] }],
    approve: [{ id: 'app/demo', why: null }],
    amendments: [{ id: 'app/demo', amendment: 'A-1', name: 'a wider scope', refuse: 'A-1 is not complete\nand more' }],
    accept: [{ id: 'app/other', why: null }],
  };
  assert.deepEqual(waitingLines(w, 'app/demo'), [
    'Demo (app/demo): S-2 is waiting for your answer', 'why: which file?', 'to approve: can approve',
    'amendment A-1: a wider scope, not yet: A-1 is not complete',
  ]);
  assert.deepEqual(waitingLines(w, 'app/none'), []);
  assert.deepEqual(waitingLines(null, 'app/demo'), []);
  const since = Date.parse('2026-01-05T11:57:00.000Z');
  const mark = (at, extra = {}) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted', ...extra });
  const reply = JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(boundaryIn(`cut line\n${reply}\n${mark('2026-01-05T11:59:00.000Z')}\n`, since), '2026-01-05T11:59:00.000Z', 'its time');
  assert.equal(boundaryIn(`${mark('2026-01-05T11:59:00.000Z')}\n${reply}\n`, since), null);
  assert.equal(boundaryIn(`${reply}\n${mark('2026-01-05T11:56:59.000Z')}\n`, since), null);
  assert.equal(boundaryIn(`${reply}\n${mark('2026-01-05T11:59:00.000Z', { isSidechain: true })}\n`, since), null);
  assert.equal(boundaryIn('', since), null);
});

test('stateText: three sentences, the task, the running steps, k\'s text or its failure, the agents and the shells', () => {
  const f = {
    source: 'compact', task: 'app/demo', title: 'A demo task', dir: '/r/app/kirunak/tasks/demo', session: 's-main', chain: ['s-old'],
    running: [{ step: 'S-2', since: '2026-01-05 10:00' }], status: 'no lock\nrunning steps: 0 of 2\nsession s-main: app/demo',
    waiting: ['to approve: can approve'], home: '/r/home',
    agents: [{ id: 'a1', type: 'Explore', description: 'find the parser', outputFile: '/r/tasks/a1.output', at: '2026-01-05T10:05:00.000Z', by: null }],
    shells: { at: '2026-01-05T10:06:00.000Z', list: [{ id: 'b1', type: 'shell', status: 'running', command: 'node heavy-lock.mjs run -- make test' }] },
  };
  const lines = stateText(f).split('\n');
  assert.equal(lines[0], 'This is the same session, after a compaction, still on app/demo.');
  assert.match(lines[1], /^The parts task, plan and progress hold its task\.md, plan\.md and progress\.md /);
  assert.match(lines[2], /^Go on from progress\.md's last line: start no step again, and ask the owner nothing already answered\.$/);
  assert.deepEqual(lines.slice(4), [
    'task: app/demo: A demo task', 'folder: /r/app/kirunak/tasks/demo', 'session: s-main, earlier ids s-old',
    'running steps of this session: S-2 (started 2026-01-05 10:00)', 'k status --session s-main:', '  no lock',
    '  running steps: 0 of 2', '  session s-main: app/demo', 'k waiting, the lines of this task:', '  to approve: can approve',
    'running agents:', '  find the parser: Explore, id a1, launched 2026-01-05T10:05:00.000Z; output /r/tasks/a1.output',
    'background shell tasks at the last Stop (2026-01-05T10:06:00.000Z):', '  b1 running: node heavy-lock.mjs run -- make test',
  ]);
  const bare = stateText({ ...f, source: 'clear', from: 's-old', chain: [], running: [], status: { failed: 'no workspace' }, waiting: { failed: 'no workspace' }, agents: [], shells: null });
  assert.match(bare, /^This is the same session, after \/clear \(it was session s-old\), still on app\/demo\.\n/);
  for (const l of ['running steps of this session: none, a step boundary', '  k status failed: no workspace', '  k waiting failed: no workspace', 'running agents:\n  none', 'background shell tasks at the last Stop:\n  none']) {
    assert.ok(bare.includes(l), l);
  }
  assert.ok(!bare.includes('quiet agents'), 'no quiet agents, no line for them');
  const quiet = stateText({ ...f, quiet: [{ id: 'a2', type: 'Plan', description: 'review the diff', written: new Date(2026, 0, 5, 7, 12, 40).getTime() }] });
  assert.ok(quiet.includes('; output /r/tasks/a1.output\nquiet agents (finished, or waiting on a long tool):\n  review the diff: Plan, id a2, no end recorded, quiet since 07:12\nbackground'), quiet);
});

// ---- The hook, run as Claude Code runs it: the event on stdin, one part per entry, a scratch KIRUNAK_HOME ----

const HOOK = fileURLToPath(new URL('../hooks/kirunak-compact.mjs', import.meta.url));
const PARTS4 = ['state', 'task', 'plan', 'progress'];
const TASK = '---\nid: app/demo\ntitle: A demo task\n---\n\n## Goal\nA made-up goal.\n';
const PLAN = `---\ntask: app/demo\n---\n\nThe header.\n\n${[['S-1', ''], ['S-2', 'needs: S-1\n'], ['S-3', 'needs: S-2\n']]
  .map(([id, needs]) => `### ${id} Step ${id} [agent]\n${needs}outputs: steps/${id}/report.md\nwhat: step ${id}\n\n`).join('')}`;
const PROGRESS = '2026-01-05 09:00 S-1 started (session s-main)\n2026-01-05 09:30 S-1 finished\n2026-01-05 10:00 S-2 started (session s-main)\n';
const SESSION = { task: 'app/demo', step: 'S-2', since: '2026-01-05T09:00:00.000Z', previous: ['s-older'] };
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

// A home as k install and k start write it: config.json naming the repo `app`, session s-main on app/demo, the task's
// three files, `expect` written `expect` seconds ago (null: none), the escalation record, a transcript whose last
// entry is an assistant reply ten minutes old.
function makeHome({ session = SESSION, expect = 5, record = null } = {}) {
  const r = makeRepos();
  const home = join(r.top, 'home');
  writeJson(join(home, 'escalate', 'config.json'), { repos: { app: r.app } });
  if (session) writeJson(join(home, 'sessions', 's-main.json'), session);
  if (record) writeJson(join(home, 'escalate', 's-main.json'), record);
  if (expect != null) writeJson(join(home, 'compact', 's-main.json'), { expect: { at: ago(expect), why: 'boundary', ctx: 160000 } });
  const dir = join(r.app, 'kirunak', 'tasks', 'demo');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of [['task.md', TASK], ['plan.md', PLAN], ['progress.md', PROGRESS]]) writeFileSync(join(dir, name), text);
  const transcript = join(r.top, 'projects', 'p', 's-main.jsonl');
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: ago(600), message: { model: 'm', usage: { input_tokens: 1 } } })}\n`);
  const input = (extra = {}) => ({ session_id: 's-main', transcript_path: transcript, cwd: r.app, hook_event_name: 'SessionStart', source: 'compact', model: 'm', ...extra });
  const json = (rel) => (existsSync(join(home, rel)) ? JSON.parse(readFileSync(join(home, rel), 'utf8')) : null);
  const log = () => (existsSync(join(home, 'compact.log')) ? readFileSync(join(home, 'compact.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { ...r, home, dir, transcript, input, json, log };
}

// The environment without this session's own kirunak settings, so a test never reads the real ones.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^KIRUNAK_|^CLAUDE_CONFIG_DIR$/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

// One hook entry, `--part <part>` (none for SessionEnd): the part's additionalContext, or null when it printed nothing.
function run(h, part, input = h.input(), env = {}) {
  const r = spawnSync(process.execPath, [HOOK, ...(part ? ['--part', part] : [])], {
    input: typeof input === 'string' ? input : JSON.stringify(input), cwd: h.top, encoding: 'utf8',
    env: cleanEnv({ KIRUNAK_HOME: h.home, ...env }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  return out.additionalContext;
}
const all = (h, input) => PARTS4.map((p) => run(h, p, input));
const NONE = [null, null, null, null];

// One hook entry started now and left to run, as Claude Code starts the four at once: its text (null for none) and
// how long it took from the start, in ms.
function start(h, part, input = h.input()) {
  const begun = Date.now();
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [HOOK, '--part', part], { cwd: h.top, env: cleanEnv({ KIRUNAK_HOME: h.home }) });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => {
      out += b;
    });
    p.stderr.on('data', (b) => {
      err += b;
    });
    p.on('error', fail);
    p.on('close', (code) => {
      try {
        assert.equal(code, 0, err);
        assert.equal(err, '');
        done({ text: out ? JSON.parse(out).hookSpecificOutput.additionalContext : null, ms: Date.now() - begun });
      } catch (e) {
        fail(e);
      }
    });
    p.stdin.end(JSON.stringify(input));
  });
}
const together = (h, input) => Promise.all(PARTS4.map((p) => start(h, p, input)));
const after = (ms, fn) => new Promise((done) => setTimeout(() => done(fn()), ms));
const boundaryAt = (at) => `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted' })}\n`;

test('SessionStart compact after the PreCompact hook\'s allow: four labelled parts within CAP, expect consumed (R5.1, R5.2, AC-5, AC-11)', () => {
  const h = makeHome({
    record: {
      agents: {
        a1: { type: 'Explore', description: 'find the parser', outputFile: '/r/a1.output', at: ago(60), ended: null },
        a2: { type: 'Plan', description: 'ended already', at: ago(120), ended: ago(30) },
        a3: { type: 'general-purpose', description: 'review the diff', outputFile: '/r/a3.output', at: ago(9000), ended: null },
        a4: { type: 'general-purpose', description: 'no transcript', at: ago(9000), ended: null },
      },
      tasks: { at: ago(20), list: [{ id: 'b1', type: 'shell', status: 'running', command: 'node heavy-lock.mjs run -- make test' }, { id: 'a1', type: 'subagent', status: 'running' }] },
    },
  });
  // R3.2: a1's transcript written just now runs; a3's, untouched past AGENT_FRESH_S, is quiet; a4 has none.
  const sub = (id) => join(h.top, 'projects', 'p', 's-main', 'subagents', `agent-${id}.jsonl`);
  mkdirSync(join(sub('a1'), '..'), { recursive: true });
  for (const id of ['a1', 'a3']) writeFileSync(sub(id), '{}\n');
  const quietSince = new Date(Date.now() - (AGENT_FRESH_S + 3600) * 1000);
  utimesSync(sub('a3'), quietSince, quietSince);
  const hhmm = `${String(quietSince.getHours()).padStart(2, '0')}:${String(quietSince.getMinutes()).padStart(2, '0')}`;
  const parts = all(h);
  for (const [i, t] of parts.entries()) {
    assert.ok(t.startsWith(`kirunak, after a compaction (part ${i + 1} of 4): ${PARTS4[i]}\n`), t.slice(0, 60));
    assert.ok(t.length - t.indexOf('\n') - 1 <= CAP);
  }
  const [state, task, plan, progress] = parts;
  assert.equal(task, `kirunak, after a compaction (part 2 of 4): task\nthe file ${join(h.dir, 'task.md')}:\n${TASK}`);
  assert.equal(progress, `kirunak, after a compaction (part 4 of 4): progress\nthe file ${join(h.dir, 'progress.md')}:\n${PROGRESS}`);
  assert.deepEqual(ids(plan), ['S-2', 'S-3']);
  assert.match(plan, /\n… left out, the blocks of S-1; the whole file: .*plan\.md$/);
  assert.ok(state.includes('\ntask: app/demo: A demo task\n'));
  assert.ok(state.includes('\nrunning steps of this session: S-2 (started 2026-01-05 10:00)\n'));
  assert.match(state, /\nk status --session s-main:\n {2}k status failed: .*no workspace/);
  assert.match(state, /\nk waiting, the lines of this task:\n {2}k waiting failed: .*no workspace/);
  assert.ok(state.includes('\nrunning agents:\n  find the parser: Explore, id a1, launched '));
  assert.ok(state.includes(`; output /r/a1.output\nquiet agents (finished, or waiting on a long tool):\n  review the diff: general-purpose, id a3, no end recorded, quiet since ${hhmm}\nbackground shell tasks`), state);
  assert.ok(!state.includes('ended already'));
  assert.ok(!state.includes('id a4'), 'a record with no transcript is left out');
  assert.ok(state.endsWith('\n  b1 running: node heavy-lock.mjs run -- make test'));
  const rec = h.json('compact/s-main.json');
  assert.equal(rec.expect, undefined);
  assert.deepEqual({ ...rec.fire, at: null }, { at: null, source: 'compact', put: true, why: 'expect boundary', boundaryAt: null });
  const line = h.log().at(-1);
  assert.deepEqual([line.event, line.put, line.why, line.boundary, line.chars], ['SessionStart', true, 'expect boundary', null, state.length]);
});

test('a manual /compact: the parts are put back, and a part run before the state part reads expect itself (E-4, R5.4)', () => {
  const h = makeHome();
  writeJson(join(h.home, 'compact', 's-main.json'), { expect: { at: ago(3), why: 'manual', ctx: 90000 } });
  assert.match(run(h, 'progress'), /^kirunak, after a compaction \(part 4 of 4\): progress\n/);
  assert.equal(h.json('compact/s-main.json').expect.why, 'manual');
  assert.match(run(h, 'state'), /^kirunak, after a compaction \(part 1 of 4\): state\nThis is the same session, after a compaction, still on app\/demo\.\n/);
  assert.equal(h.log().at(-1).why, 'expect manual');
});

test('an agent\'s compaction: an expect or boundary over 180 s old gives nothing; the main\'s boundary gives the parts (R5.2, E-6)', async () => {
  const stale = makeHome({ expect: EXPECT_S + 1 });
  const old = makeHome({ expect: null });
  appendFileSync(old.transcript, boundaryAt(ago(EXPECT_S + 5)));
  for (const parts of await Promise.all([together(stale), together(old)])) assert.deepEqual(parts.map((p) => p.text), NONE);
  assert.equal(stale.json('compact/s-main.json').expect, undefined);
  assert.deepEqual([old.log().at(-1).put, old.log().at(-1).why], [false, "not the main's"]);
  const seen = makeHome({ expect: null });
  const at = ago(10);
  appendFileSync(seen.transcript, boundaryAt(at));
  assert.ok(all(seen).every((t) => typeof t === 'string'));
  assert.deepEqual([seen.log().at(-1).why, seen.log().at(-1).boundary], ['boundary seen', at]);
});

test('R5.2a: the main transcript\'s boundary written about 1 s after the four parts start: all four put back', async () => {
  const h = makeHome({ expect: null });
  let at = null;
  const [parts] = await Promise.all([together(h), after(1000, () => {
    at = new Date().toISOString();
    appendFileSync(h.transcript, boundaryAt(at));
  })]);
  for (const [i, p] of parts.entries()) {
    assert.ok(p.text?.startsWith(`kirunak, after a compaction (part ${i + 1} of 4): ${PARTS4[i]}\n`), `${PARTS4[i]}: ${p.text}`);
    assert.ok(p.ms >= 900, `${PARTS4[i]} decided after ${p.ms} ms, before the boundary was written`);
    if (PARTS4[i] !== 'state') assert.ok(p.ms < BOUNDARY_WAIT_S * 1000, `${PARTS4[i]} waited ${p.ms} ms`);
  }
  const line = h.log().at(-1);
  assert.deepEqual([line.put, line.why, line.boundary], [true, 'boundary seen', at]);
  assert.equal(h.json('compact/s-main.json').fire.boundaryAt, at);
});

test('R5.2a: no expect and no boundary ever written: nothing put back, the four parts done in about BOUNDARY_WAIT_S', async () => {
  const h = makeHome({ expect: null });
  const parts = await together(h);
  assert.deepEqual(parts.map((p) => p.text), NONE);
  for (const p of parts) assert.ok(p.ms >= BOUNDARY_WAIT_S * 1000 - 250 && p.ms < BOUNDARY_WAIT_S * 1000 + 3000, `${p.ms} ms`);
  assert.deepEqual([h.log().at(-1).put, h.log().at(-1).why, h.log().at(-1).boundary], [false, "not the main's", null]);
});

test('R5.2a: a waiting part takes the state part\'s fire once it is written; a session with no task waits for nothing', async () => {
  const h = makeHome({ expect: null });
  const fire = { source: 'compact', put: true, why: 'boundary seen', boundaryAt: ago(1) };
  const [task] = await Promise.all([start(h, 'task'), after(1000, () => writeJson(join(h.home, 'compact', 's-main.json'), { fire: { ...fire, at: new Date().toISOString() } }))]);
  assert.match(task.text, /^kirunak, after a compaction \(part 2 of 4\): task\nthe file /);
  assert.ok(task.ms >= 900 && task.ms < BOUNDARY_WAIT_S * 1000, `${task.ms} ms`);
  const none = makeHome({ session: null, expect: null });
  const state = await start(none, 'state');
  assert.equal(state.text, null);
  assert.ok(state.ms < BOUNDARY_WAIT_S * 1000 - 1000, `${state.ms} ms`);
  assert.equal(none.log().at(-1).why, 'no task');
});

test('one boundary is the main\'s once: a second state part on the same transcript tail, after expect or not, gives nothing (R5.2, E-6)', () => {
  const mark = (at) => `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted' })}\n`;
  for (const expect of [null, 5]) {
    const h = makeHome({ expect });
    const at = ago(10);
    appendFileSync(h.transcript, mark(at));
    assert.ok(run(h, 'state'), `the main's, expect ${expect}`);
    assert.equal(h.json('compact/s-main.json').fire.boundaryAt, at);
    assert.equal(run(h, 'state'), null, 'an agent\'s compaction within 180 s of the main\'s');
    assert.deepEqual([h.log().at(-1).put, h.log().at(-1).why], [false, 'boundary already put back']);
    assert.deepEqual([run(h, 'task'), run(h, 'plan'), run(h, 'progress')], [null, null, null], 'the other parts take its decision');
    writeJson(join(h.home, 'compact', 's-main.json'), { ...h.json('compact/s-main.json'), fire: { ...h.json('compact/s-main.json').fire, at: ago(30), put: true } });
    assert.equal(run(h, 'task'), null, 'a part past PARTS_S compares the boundary itself');
    appendFileSync(h.transcript, mark(ago(2)));
    assert.ok(run(h, 'state'), 'a newer boundary is a new compaction');
  }
});

test('nothing in a k run step, after startup, for an unknown part or unreadable input, a session with no task, a task folder gone (E-6, E-5)', () => {
  const h = makeHome();
  assert.equal(run(h, 'state', h.input(), { KIRUNAK_STEP: 'S-2' }), null);
  assert.deepEqual([h.json('compact/s-main.json').expect.why, h.log()], ['boundary', []]);
  assert.equal(run(h, 'state', h.input({ source: 'startup' })), null);
  assert.equal(run(h, 'state', h.input({ agent_id: 'a1', agent_type: 'Explore' })), null);
  assert.equal(run(h, 'nope'), null);
  assert.equal(run(h, 'state', 'not json'), null);
  assert.ok(h.json('compact/s-main.json').expect);
  const none = makeHome({ session: null });
  assert.deepEqual(all(none), NONE);
  assert.equal(none.log().at(-1).why, 'no task');
  const gone = makeHome({ session: { task: 'app/missing' } });
  assert.deepEqual(all(gone), NONE);
  assert.equal(gone.log().at(-1).why, 'task folder unknown');
});

const endOf = (h, extra = {}) => ({ session_id: 's-main', transcript_path: h.transcript, cwd: h.app, hook_event_name: 'SessionEnd', reason: 'clear', ...extra });
const startAs = (h, extra = {}) => h.input({ session_id: 's-new', transcript_path: join(h.top, 'projects', 'p', 's-new.jsonl'), source: 'clear', model: undefined, ...extra });

test('SessionEnd on /clear: a session holding a task writes cleared.json; another reason writes nothing; after k-done it is removed (R5.3, E-5)', () => {
  const h = makeHome({ expect: null });
  assert.equal(run(h, null, endOf(h, { reason: 'logout' })), null);
  assert.equal(h.json('compact/cleared.json'), null);
  assert.equal(run(h, null, endOf(h)), null);
  const c = h.json('compact/cleared.json');
  assert.deepEqual({ ...c, at: null }, { from: 's-main', task: 'app/demo', step: 'S-2', since: SESSION.since, previous: ['s-older'], at: null, cwd: h.app, ppid: process.pid });
  assert.deepEqual([h.log().at(-1).event, h.log().at(-1).task], ['SessionEnd', 'app/demo']);
  rmSync(join(h.home, 'sessions', 's-main.json'));
  run(h, null, endOf(h));
  assert.equal(h.json('compact/cleared.json'), null);
  assert.deepEqual(all(h, startAs(h)), NONE);
  assert.equal(h.log().at(-1).why, 'nothing cleared');
});

test('SessionStart clear within 120 s joins the old id: the chain, clearedTo, cleared.json gone, the parts after /clear (R5.3, E-5)', () => {
  const h = makeHome({ expect: null });
  run(h, null, endOf(h));
  const start = startAs(h);
  assert.match(run(h, 'task', start), /^kirunak, after \/clear \(part 2 of 4\): task\nthe file /);
  const state = run(h, 'state', start);
  assert.match(state, /^kirunak, after \/clear \(part 1 of 4\): state\nThis is the same session, after \/clear \(it was session s-main\), still on app\/demo\.\n/);
  assert.ok(state.includes('\nsession: s-new, earlier ids s-older, s-main\n'));
  assert.ok(state.includes('\nrunning steps of this session: S-2 (started 2026-01-05 10:00)\n'));
  assert.deepEqual(h.json('sessions/s-new.json'), { task: 'app/demo', step: 'S-2', since: SESSION.since, previous: ['s-older', 's-main'] });
  assert.equal(h.json('sessions/s-main.json').clearedTo, 's-new');
  assert.equal(h.json('compact/cleared.json'), null);
  assert.deepEqual({ ...h.json('compact/s-new.json').joined, at: null }, { at: null, from: 's-main', task: 'app/demo', previous: ['s-older', 's-main'] });
  assert.match(run(h, 'plan', start), /^kirunak, after \/clear \(part 3 of 4\): plan\n/);
  assert.match(run(h, 'progress', start), /^kirunak, after \/clear \(part 4 of 4\): progress\n/);
  assert.deepEqual([h.log().at(-1).why, h.log().at(-1).from], ['joined', 's-main']);
});

test('SessionStart clear refuses cleared.json 121 s old or from another folder; another parent process joins and is logged (R5.3)', () => {
  const h = makeHome({ expect: null });
  const cleared = (extra) => writeJson(join(h.home, 'compact', 'cleared.json'), {
    from: 's-main', task: 'app/demo', step: 'S-2', since: null, previous: [], at: ago(CLEAR_S + 1), cwd: h.app, ppid: process.pid, ...extra,
  });
  cleared();
  assert.deepEqual(all(h, startAs(h)), NONE);
  assert.equal(h.log().at(-1).why, 'cleared too long ago');
  assert.equal(h.json('compact/cleared.json'), null);
  cleared({ at: ago(5), cwd: h.plain });
  assert.deepEqual(all(h, startAs(h)), NONE);
  assert.equal(h.log().at(-1).why, 'another folder');
  assert.equal(h.json('sessions/s-new.json'), null);
  cleared({ at: ago(5), ppid: 1 });
  assert.ok(run(h, 'state', startAs(h)));
  assert.equal(h.log().at(-1).why, 'joined, another parent process');
});

test('R6.6: the state part decides under the lock: with another writer holding it, the parts still come and nothing is written', () => {
  const h = makeHome();
  const lock = join(h.home, 'compact', 's-main.json.lock');
  mkdirSync(lock);
  assert.match(run(h, 'state'), /^kirunak, after a compaction \(part 1 of 4\): state\n/);
  assert.deepEqual([h.json('compact/s-main.json').expect.why, h.json('compact/s-main.json').fire], ['boundary', undefined]);
  rmSync(lock, { recursive: true });
  assert.ok(run(h, 'state'));
  assert.deepEqual([h.json('compact/s-main.json').expect, h.json('compact/s-main.json').fire.why], [undefined, 'expect boundary']);
  run(h, null, { session_id: 's-main', transcript_path: h.transcript, cwd: h.app, hook_event_name: 'SessionEnd', reason: 'clear' });
  const start = h.input({ session_id: 's-new', transcript_path: join(h.top, 'projects', 'p', 's-new.jsonl'), source: 'clear', model: undefined });
  mkdirSync(join(h.home, 'compact', 's-new.json.lock'));
  assert.ok(run(h, 'state', start), 'joined');
  assert.equal(h.json('compact/s-new.json'), null, 'joined is written under the lock');
});

test('R1.4: the main\'s compaction clears the first block\'s record; an agent\'s leaves it', () => {
  const blocked = { at: ago(300), line: 3 };
  const h = makeHome();
  writeJson(join(h.home, 'compact', 's-main.json'), { ...h.json('compact/s-main.json'), blocked });
  assert.ok(run(h, 'state'));
  assert.equal(h.json('compact/s-main.json').blocked, undefined);
  const agent = makeHome({ expect: null });
  writeJson(join(agent.home, 'compact', 's-main.json'), { blocked });
  assert.equal(run(agent, 'state'), null);
  assert.deepEqual(agent.json('compact/s-main.json').blocked, blocked);
});

test('prune: the state part removes compact/*.json untouched for 14 days; newer ones and compact.log stay (R5.5)', () => {
  const h = makeHome();
  const aged = (path, days) => utimesSync(path, new Date(Date.now() - days * 86_400_000), new Date(Date.now() - days * 86_400_000));
  const [old, recent, log] = [join(h.home, 'compact', 's-old.json'), join(h.home, 'compact', 's-recent.json'), join(h.home, 'compact.log')];
  writeJson(old, { fire: {} });
  writeJson(recent, { fire: {} });
  writeFileSync(log, '{}\n');
  aged(old, PRUNE_DAYS + 1);
  aged(recent, PRUNE_DAYS - 1);
  aged(log, 60);
  run(h, 'task');
  assert.ok(existsSync(old));
  run(h, 'state');
  assert.deepEqual([existsSync(old), existsSync(recent), existsSync(log)], [false, true, true]);
});

test('the state part carries k status --session and the task\'s lines of k waiting from a workspace (AC-11)', async () => {
  const before = process.env.KIRUNAK_HOME;
  try {
    const w = await makeWorkspace();
    writeJson(join(w.home, 'escalate', 'config.json'), { repos: { weather: w.weather } });
    writeJson(join(w.home, 'sessions', 's-main.json'), { task: 'weather/offline-forecast' });
    writeJson(join(w.home, 'compact', 's-main.json'), { expect: { at: ago(2), why: 'boundary', ctx: 1 } });
    const input = { session_id: 's-main', transcript_path: join(w.root, 'none.jsonl'), cwd: w.weather, hook_event_name: 'SessionStart', source: 'compact' };
    const state = run({ home: w.home, top: w.root }, 'state', input);
    assert.match(state, /\nk status --session s-main:\n {2}no lock\n {2}running steps: 0 of \d+\n {2}session s-main: weather\/offline-forecast\n/);
    assert.match(state, /\nk waiting, the lines of this task:\n {2}to approve: (can approve|not yet: .+)\n/);
  } finally {
    if (before === undefined) delete process.env.KIRUNAK_HOME;
    else process.env.KIRUNAK_HOME = before;
  }
});

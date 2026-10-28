import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lock, review } from '../lib/bug-review.mjs';
import { checkBugText, drop, fixLine, list, quadDamagePath, reviewLockPath, reviewing } from '../lib/bugs.mjs';
import { start as intakeStart } from '../lib/intake.mjs';
import {
  claim, FIX_ENV, keepAwake, OWNER_STOP, OWNER_WHY, preview, progressCommand, progressOf, progressText, pushLine, release, run, runsDir, start,
  state, statusLine, stop, STOP_SIGNAL, stopPath, summaryOf, summaryText, workBug,
} from '../lib/quad-damage.mjs';
import { events, gitCommitAll, gitInit, k, makeWorkspace, sh } from './helpers.mjs';

// gulnya/quad-damage S-3: Quad Damage's run, its run file, its limits gate, its summary and its status.

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const T0 = new Date(2026, 9, 27, 23, 40, 5);
const DEAD = 2 ** 22 + 12345;
// A live pid that is not this process's: the test runner that started it.
const OTHER = process.ppid;
const epoch = (d) => Math.floor(d.getTime() / 1000);
const reading = (five, week = 50, { overage = false, resetsAt = new Date(2026, 9, 28, 1, 15, 0) } = {}) =>
  ({ fiveHour: { used: five, resetsAt: epoch(resetsAt) }, week: { used: week, resetsAt: epoch(new Date(2026, 10, 1, 15, 0, 0)) }, overage });

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const bugText = (id, written, mark) => `---
id: ${id}
title: Bug ${id.split('/')[1]}
written: ${written}
quad-damage: ${mark}
---

## Who raised it
> the map shows yesterday's tiles
owner, ${written}, session 5f0c2a

## Why
After a refresh the map keeps the old tiles; open the map, refresh, and the tiles stay.

## What was found
- the tile cache never expires [file src/Tiles.kt]

## Questions
1. Should the cache expire hourly?
   Proposed: hourly, as the forecast refreshes hourly
`;

// The invented workspace with three bugs in hub: a and c marked yes, b no, in the list's order a, b, c; the limits
// log named in the workspace.
async function qdWorkspace() {
  const w = await makeWorkspace();
  for (const [slug, written, mark] of [['a', '2026-10-20', 'yes'], ['b', '2026-10-21', 'no'], ['c', '2026-10-22', 'yes']]) {
    put(join(w.hub, 'kirunak', 'bugs', `${slug}.md`), bugText(`hub/${slug}`, written, mark));
  }
  w.ws.bugs = { ...w.ws.bugs, limitsLog: join(w.root, 'limits.log') };
  return w;
}

// A clock that sleep moves on, and a runner that hands out the readings in turn.
function seams(readings = []) {
  let t = T0.getTime();
  const slept = [];
  return {
    slept,
    now: () => new Date(t),
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    runner: { limits: async () => (readings.length ? readings.shift() : { error: 'no reading left' }) },
    caffeinate: () => null,
  };
}

const writeRun = (home, run) => put(quadDamagePath(home), JSON.stringify(run) + '\n');
const writeLock = (home, id, pid) => put(reviewLockPath(home, id), JSON.stringify({ pid, started: '2026-10-27T22:00:00.000Z' }) + '\n');
const summaryFile = (r) => readFileSync(join(r.folder, 'summary.md'), 'utf8');
const progressFile = (folder) => readFileSync(join(folder, 'progress.log'), 'utf8');
// progress.log's lines without their HH:MM (AC-16).
const progressLines = (folder) => progressFile(folder).trimEnd().split('\n').map((l) => l.replace(/^\d\d:\d\d /, ''));

test('run: the marked bugs in the list\'s order, the work\'s outcome, the lock and the run file let go', async () => {
  const w = await qdWorkspace();
  const s = seams();
  const awake = [];
  const work = async () => ({ outcome: 'waits', why: 'a stub' });
  const r = await run({ ws: w.ws, ...s, work, caffeinate: (pid) => awake.push(pid) });
  assert.deepEqual(awake, [process.pid]);
  assert.equal(r.folder, join(runsDir(w.home), '2026-10-27T23-40-05'));
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'waits'], ['hub/c', 'waits']]);
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 2 wait, 0 not reached\n' +
    '- hub/a: waits: a stub\n- hub/c: waits: a stub\n');
  assert.equal(existsSync(quadDamagePath(w.home)), false);
  assert.equal(state(w.home), null);
  assert.equal(reviewing(w.home, 'hub/a'), null);
  assert.equal(existsSync(reviewLockPath(w.home, 'hub/a')), false);
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /^23:40:05 Quad Damage runs: pid \d+, via shell\n23:40:05 hub\/a: taken\n/);
  // The stub starts no session, so neither bug has a started line (AC-16).
  assert.equal(progressFile(r.folder), '23:40 hub/a: waits: a stub\n23:40 hub/c: waits: a stub\n' +
    '23:40 Quad Damage done: 0 merged, 2 wait, 0 not reached\n', 'AC-16');
  assert.equal(JSON.parse(readFileSync(join(r.folder, 'state.json'), 'utf8')).bugs.length, 2);
  const e = events(w.home).at(-1);
  assert.deepEqual({ ...e, time: null }, { time: null, kind: 'quad-damage', via: 'shell', folder: r.folder, merged: 0, waits: 2, notReached: 0, stopped: null });

  // A second run in the same minute gets a folder of its own.
  const again = await run({ ws: w.ws, ...seams() });
  assert.equal(again.folder, join(runsDir(w.home), '2026-10-27T23-40-05-2'));
});

test('run: the 5-hour window at 90% pauses until its reset and a minute, then the bug goes on (AC-9)', async () => {
  const w = await qdWorkspace();
  const s = seams([reading(91), reading(5), reading(10, 60)]);
  const seen = [];
  const work = async (ctx) => {
    assert.equal(ctx.folder.startsWith(runsDir(w.home)), true);
    assert.equal(existsSync(ctx.dir), true);
    assert.equal(reviewing(w.home, ctx.bug.id).pid, process.pid);
    const held = list(w.ws).find((x) => x.id === ctx.bug.id);
    assert.deepEqual({ ...held.quadDamageRun, since: null }, { phase: 'fixing', try: 1, since: null, waitUntil: null });
    assert.equal(fixLine(held), 'Quad Damage: fixing, try 1', 'the run\'s phase, not the lock\'s "reviewing" (S-5)');
    assert.equal(list(w.ws).find((x) => x.id === 'hub/b').quadDamageRun, null);
    const r = await ctx.beforeSession();
    seen.push(r.fiveHour.used);
    assert.equal(state(w.home).phase, 'fixing');
    ctx.setPhase('reviewing');
    assert.equal(statusLine(state(w.home)), `Quad Damage runs: ${ctx.bug.id}, reviewing since 01:16`);
    return { outcome: 'merged', sha: `${ctx.bug.slug}bcdef1234567`, repo: 'hub' };
  };
  const during = [];
  const sleep = async (ms) => {
    during.push(statusLine(state(w.home)), state(w.home).waitUntil.slice(11, 16));
    await s.sleep(ms);
  };
  const r = await run({ ws: w.ws, ...s, sleep, work });
  assert.deepEqual(seen, [5, 10]);
  assert.deepEqual(s.slept, [(95 + 1) * 60 * 1000 - 5 * 1000]);
  assert.deepEqual(during, ['Quad Damage waits for the 5-hour window until 01:15', '01:15']);
  assert.equal(summaryFile(r), "Quad Damage, 23:40 to 01:16: 2 merged, 0 wait, 0 not reached\n- hub/a: merged abcdef1 into hub's master\n" +
    "- hub/c: merged cbcdef1 into hub's master\n");
  const logged = readFileSync(join(w.root, 'limits.log'), 'utf8').trim().split('\n').map((l) => l.split('\t').slice(1));
  assert.deepEqual(logged, [['50', '91', 'quad-damage'], ['50', '5', 'quad-damage'], ['60', '10', 'quad-damage']]);
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /hub\/a: the 5-hour window is at 91%: waiting until 01:15 and a minute/);
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /hub\/a: merged abcdef123456 into hub\n/);
  // AC-16: the pause and its end, the merges and the end in progress.log, and never a reading of the limits.
  // The bug starts once the window lets its first session go.
  assert.equal(progressFile(r.folder), '23:40 Quad Damage paused for the 5-hour window until 01:15\n' +
    '01:16 Quad Damage goes on\n01:16 hub/a: started\n01:16 hub/a: review clean, merged abcdef1 into hub\n01:16 hub/c: started\n' +
    '01:16 hub/c: review clean, merged cbcdef1 into hub\n01:16 Quad Damage done: 2 merged, 0 wait, 0 not reached\n');
  assert.doesNotMatch(progressFile(r.folder), /%|limits/);
});

test('run: the week at 98%, extra usage or a failed reading stops it, the bugs left not reached (AC-10)', async () => {
  const cases = [
    [[reading(10, 98)], "the week's limit reached 98%"],
    [[reading(10, 97.99), reading(10, 98.5)], "the week's limit reached 98%"],
    [[reading(10, 50, { overage: true })], 'the plan is in extra usage'],
    [[{ error: 'the turn carried no rate_limit_event' }], 'the limits reading failed: the turn carried no rate_limit_event'],
    [[{ fiveHour: null }], 'the limits reading failed: it gave no windows'],
  ];
  for (const [readings, why] of cases) {
    const w = await qdWorkspace();
    const s = seams(readings);
    const reached = [];
    const work = async (ctx) => {
      await ctx.beforeSession();
      reached.push(ctx.bug.id);
      return { outcome: 'merged', sha: '1234567890', repo: 'hub' };
    };
    const r = await run({ ws: w.ws, ...s, work });
    const merged = reached.length;
    assert.equal(r.stopped, why, why);
    assert.equal(summaryFile(r), `Quad Damage, 23:40 to 23:40: ${merged} merged, 0 wait, ${2 - merged} not reached; stopped: ${why}\n` +
      (merged ? "- hub/a: merged 1234567 into hub's master\n- hub/c: not reached\n" : '- hub/a: not reached\n- hub/c: not reached\n'), why);
    assert.equal(state(w.home), null);
    assert.equal(reviewing(w.home, 'hub/a'), null);
    assert.equal(progressLines(r.folder).at(-1), `Quad Damage stopped: ${why}`, `AC-16: ${why}`);
    assert.doesNotMatch(progressFile(r.folder), /limits:|5-hour/);
    // A bug the limits stop before its first session never started (AC-16).
    assert.doesNotMatch(progressFile(r.folder), merged ? /hub\/c: started/ : /started/, `AC-16: ${why}`);
  }
  // A runner with no reading stops it as well.
  const w = await qdWorkspace();
  const r = await run({ ws: w.ws, ...seams(), runner: {}, work: async (ctx) => ctx.beforeSession() });
  assert.equal(r.stopped, 'the limits reading failed: the runner has no limits reading');
});

test('run: a bug\'s started line says a fix ready goes to review, and a retry first says its try (AC-16)', async () => {
  const w = await qdWorkspace();
  const phases = { 'hub/a': ['reviewing', 1], 'hub/c': ['fixing', 2] };
  const work = async (ctx) => {
    ctx.setPhase(...phases[ctx.bug.id]);
    await ctx.beforeSession();
    await ctx.beforeSession();
    return { outcome: 'waits', why: 'a stub' };
  };
  const r = await run({ ws: w.ws, ...seams([reading(10, 50), reading(10, 50), reading(10, 50), reading(10, 50)]), work });
  assert.deepEqual(progressLines(r.folder), ['hub/a: started, fix ready, to review', 'hub/a: waits: a stub',
    "hub/c: started, try 2 from its review's findings", 'hub/c: waits: a stub', 'Quad Damage done: 0 merged, 2 wait, 0 not reached']);
});

test('run: the work\'s stop ends the run; its outcome is kept; a work that throws leaves its bug waiting', async () => {
  let w = await qdWorkspace();
  let r = await run({ ws: w.ws, ...seams(), work: async () => ({ stop: 'the session hit extra usage' }) });
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 0 wait, 2 not reached; stopped: the session hit extra usage\n' +
    '- hub/a: not reached\n- hub/c: not reached\n');
  w = await qdWorkspace();
  r = await run({ ws: w.ws, ...seams(), work: async () => ({ outcome: 'waits', why: 'AC-4: a choice of the owner\'s', stop: 'out of time' }) });
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 1 wait, 1 not reached; stopped: out of time\n' +
    "- hub/a: waits: AC-4: a choice of the owner's\n- hub/c: not reached\n");
  w = await qdWorkspace();
  r = await run({ ws: w.ws, ...seams(), work: async (ctx) => { if (ctx.bug.id === 'hub/a') throw new Error('boom'); return {}; } });
  assert.equal(r.stopped, null);
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 2 wait, 0 not reached\n- hub/a: waits: its work failed: boom\n' +
    '- hub/c: waits: its work gave no outcome\n');
  assert.equal(reviewing(w.home, 'hub/a'), null);
});

test('run: a bug marked during the run joins it; a bug another live pid holds is passed over, being reviewed', async () => {
  const w = await qdWorkspace();
  writeLock(w.home, 'hub/a', OTHER);
  const taken = [];
  const work = async (ctx) => {
    taken.push(ctx.bug.id);
    if (ctx.bug.id === 'hub/c') put(join(w.hub, 'kirunak', 'bugs', 'd.md'), bugText('hub/d', '2026-10-23', 'yes'));
    // relock() takes the bug's lock again after a review let it go.
    writeFileSync(reviewLockPath(w.home, ctx.bug.id), JSON.stringify({ pid: DEAD }));
    ctx.relock();
    assert.equal(reviewing(w.home, ctx.bug.id).pid, process.pid);
    return { outcome: 'waits', why: 'not ready' };
  };
  const r = await run({ ws: w.ws, ...seams(), work });
  assert.deepEqual(taken, ['hub/c', 'hub/d']);
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 3 wait, 0 not reached\n- hub/a: waits: being reviewed\n' +
    '- hub/c: waits: not ready\n- hub/d: waits: not ready\n');
  assert.equal(reviewing(w.home, 'hub/a').pid, OTHER);
});

test('claim: a second run while the first lives is refused, naming it; a dead one is taken over (E-3)', async () => {
  const w = await qdWorkspace();
  writeRun(w.home, { pid: OTHER, started: '2026-10-27T21:00:00+00:00', by: 'owner', via: 'mod', bug: 'hub/a', phase: 'fixing', try: 2 });
  const refused = (e) => e.code === 1 && e.message === `Quad Damage runs already: pid ${OTHER}, started 2026-10-27T21:00:00+00:00, on hub/a ` +
    '(fixing, try 2); a second one waits until it ends, and k bugs quad-damage --status shows it';
  assert.throws(() => claim(w.home), refused);
  await assert.rejects(run({ ws: w.ws, ...seams() }), refused);
  assert.throws(() => start({ ws: w.ws }), refused);
  assert.throws(() => preview({ ws: w.ws }), refused);
  assert.equal(state(w.home).pid, OTHER);
  const cli = k(w.home, ['bugs', 'quad-damage']);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, new RegExp(`Quad Damage runs already: pid ${OTHER}`));
  writeRun(w.home, { pid: OTHER, started: '2026-10-27T21:00:00+00:00' });
  assert.throws(() => claim(w.home), /pid \d+, started 2026-10-27T21:00:00\+00:00, between bugs; a second one waits/);

  // Its own pid, or the pid that hands it on, is the run's.
  writeRun(w.home, { pid: OTHER, started: 'S', folder: '/f' });
  assert.deepEqual(claim(w.home, { pid: 77, from: OTHER }), { pid: 77, started: 'S', folder: '/f' });
  release(w.home, 78);
  assert.equal(existsSync(quadDamagePath(w.home)), true);
  release(w.home, 77);
  assert.equal(existsSync(quadDamagePath(w.home)), false);

  writeRun(w.home, { pid: DEAD, started: '2026-10-27T21:00:00+00:00', bug: 'hub/a', phase: 'fixing', try: 1 });
  const r = await run({ ws: w.ws, ...seams() });
  assert.equal(r.bugs.length, 2);
  writeFileSync(quadDamagePath(w.home), 'not json');
  assert.equal(claim(w.home, { now: T0 }).started.slice(0, 16), '2026-10-27T23:40');
});

test('drop, intake and Review & merge refuse a bug the run holds, naming the run (E-4)', async () => {
  const w = await qdWorkspace();
  writeRun(w.home, { pid: OTHER, started: '2026-10-27T23:40:05+00:00', bug: 'hub/a', phase: 'fixing', try: 1 });
  writeLock(w.home, 'hub/a', OTHER);
  assert.throws(() => drop({ ws: w.ws, id: 'hub/a', why: 'no longer seen' }),
    (e) => e.code === 1 && e.message === `the bug hub/a cannot be dropped: Quad Damage is on it (pid ${OTHER}, started ` +
      '2026-10-27T22:00:00.000Z) and may merge its fix and close it; it is free once the run moves on, and k bugs quad-damage --status shows the run');
  assert.throws(() => drop({ ws: w.ws, id: 'hub/a', why: 'no longer seen', dryRun: true }), /Quad Damage is on it/);
  assert.throws(() => lock(w.home, 'hub/a'), (e) => e.code === 1 && e.message === `hub/a is in Quad Damage's run: pid ${OTHER}, started ` +
    "2026-10-27T22:00:00.000Z; Review & merge waits until the run moves on, and k bugs quad-damage --status shows it");
  assert.equal(existsSync(join(w.hub, 'kirunak', 'bugs', 'a.md')), true);

  put(join(w.weather, 'kirunak', 'bugs', 'wind-alerts.md'), bugText('weather/wind-alerts', '2026-10-20', 'yes'));
  writeLock(w.home, 'weather/wind-alerts', OTHER);
  await assert.rejects(intakeStart({ ws: w.ws, id: 'weather/wind-alerts', from: 'kirunak/bugs/wind-alerts.md' }),
    (e) => e.code === 1 && e.message === `the bug weather/wind-alerts cannot start its intake: Quad Damage is on it (pid ${OTHER}, ` +
      'started 2026-10-27T22:00:00.000Z) and may merge its fix and close it; it is free once the run moves on, and k bugs quad-damage ' +
      '--status shows the run');
  assert.equal(existsSync(join(w.weather, 'kirunak', 'tasks', 'wind-alerts')), false);

  // Held by a Review & merge, not the run: the review is named, as before.
  writeRun(w.home, { pid: DEAD, started: 'S' });
  assert.throws(() => drop({ ws: w.ws, id: 'hub/a', why: 'no longer seen' }),
    (e) => e.message === `the bug hub/a cannot be dropped: its Review & merge runs (pid ${OTHER}, started 2026-10-27T22:00:00.000Z) and ` +
      'may merge its fix and close it; k bugs shows its result once it ends');
});

test('status: the run, its bug and phase, or its wait; and the rows (AC-12)', async () => {
  const w = await qdWorkspace();
  assert.equal(statusLine(null), 'Quad Damage is not running');
  const base = { pid: OTHER, started: '2026-10-27T23:40:05+00:00', by: 'owner', via: 'shell', folder: '/f' };
  assert.equal(statusLine({ ...base, bug: 'hub/a', phase: 'fixing', try: 1, since: '2026-10-27T23:41:00+00:00' }),
    'Quad Damage runs: hub/a, fixing (try 1) since 23:41');
  assert.equal(statusLine({ ...base, bug: 'hub/a', phase: 'reviewing', try: 2, since: '2026-10-28T00:52:00+00:00' }),
    'Quad Damage runs: hub/a, reviewing since 00:52');
  assert.equal(statusLine({ ...base, bug: 'hub/a', phase: 'waiting', try: 1, waitUntil: '2026-10-28T01:15:00+00:00' }),
    'Quad Damage waits for the 5-hour window until 01:15');
  assert.equal(statusLine({ ...base, bug: null }), 'Quad Damage runs, between bugs, since 23:40');

  assert.equal(k(w.home, ['bugs', 'quad-damage', '--status']).stdout, 'Quad Damage is not running\n');
  writeRun(w.home, { ...base, bug: 'hub/c', phase: 'fixing', try: 2, since: '2026-10-27T23:41:00+00:00' });
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--status']).stdout, 'Quad Damage runs: hub/c, fixing (try 2) since 23:41\n');
  const json = JSON.parse(k(w.home, ['bugs', 'quad-damage', '--status', '--json']).stdout);
  assert.equal(json.run.bug, 'hub/c');
  assert.equal(json.line, 'Quad Damage runs: hub/c, fixing (try 2) since 23:41');
  assert.deepEqual(list(w.ws).map((r) => [r.id, r.quadDamageRun]), [['hub/a', null], ['hub/b', null], ['hub/c', { phase: 'fixing', try: 2, since: '2026-10-27T23:41:00+00:00', waitUntil: null }]]);
  assert.match(k(w.home, ['bugs']).stdout, /hub\/c .* Quad Damage: fixing, try 2/);
  const row = { reviewing: { pid: OTHER }, fixReady: true };
  assert.equal(fixLine({ ...row, quadDamageRun: { phase: 'reviewing', try: 1 } }), 'Quad Damage: reviewing');
  assert.equal(fixLine({ ...row, quadDamageRun: { phase: 'waiting', try: 1, waitUntil: '2026-10-28T01:15:00+00:00' } }),
    'Quad Damage: waiting for the 5-hour window until 01:15');
  assert.equal(fixLine({ ...row, quadDamageRun: null }), 'reviewing', 'the owner\'s review, as before');
  writeRun(w.home, { ...base, pid: DEAD, bug: 'hub/c', phase: 'fixing', try: 2 });
  assert.equal(list(w.ws).find((r) => r.id === 'hub/c').quadDamageRun, null);
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--status']).stdout, 'Quad Damage is not running\n');
  assert.equal(k(w.home, ['bugs', 'quad-damage', 'x', '--status']).status, 2);
});

test('summary: its shapes, the push line, and --summary of the latest run or a folder (AC-13)', async () => {
  const bugs = [
    { id: 'hub/a', outcome: 'merged', sha: '0123456789abcdef', repo: 'kirunak' },
    { id: 'hub/b', outcome: 'waits', why: 'the review found two things twice' },
    { id: 'hub/c', outcome: 'not-reached' },
  ];
  const text = summaryText({ started: '2026-10-27T23:40:05+00:00', ended: '2026-10-28T03:02:00+00:00', bugs, stopped: "the week's limit reached 98%" });
  assert.equal(text, "Quad Damage, 23:40 to 03:02: 1 merged, 1 wait, 1 not reached; stopped: the week's limit reached 98%\n" +
    "- hub/a: merged 0123456 into kirunak's master\n- hub/b: waits: the review found two things twice\n- hub/c: not reached\n");
  assert.equal(pushLine(text), "Quad Damage, 23:40 to 03:02: 1 merged, 1 wait, 1 not reached; stopped: the week's limit reached 98%. " +
    'hub/a merged; hub/b waits: the review found two things twice; hub/c not reached');
  const many = summaryText({ started: 'T', ended: 'T', bugs: Array.from({ length: 20 }, (_, i) => ({ id: `hub/bug-${i}`, outcome: 'waits', why: 'a reason long enough to be cut in the push line' })) });
  const push = pushLine(many);
  assert.equal(push.length, 200);
  assert.equal(push.endsWith('…'), true);
  assert.match(push, /hub\/bug-0 waits: a reason long enough to be cut in the p…; hub\/bug-1/);

  const w = await qdWorkspace();
  const none = k(w.home, ['bugs', 'quad-damage', '--summary']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no Quad Damage run yet/);
  const first = await run({ ws: w.ws, ...seams() });
  const later = await run({ ws: w.ws, ...seams(), now: () => new Date(2026, 9, 28, 9, 0, 0), work: async () => ({ stop: 'enough' }) });
  const out = k(w.home, ['bugs', 'quad-damage', '--summary']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, `${summaryFile(later)}kirunak-push: ${pushLine(summaryFile(later))}\n`);
  assert.equal(out.stdout.split('\n').at(-2), 'kirunak-push: Quad Damage, 09:00 to 09:00: 0 merged, 0 wait, 2 not reached; stopped: enough. ' +
    'hub/a not reached; hub/c not reached');
  for (const folder of ['2026-10-27T23-40-05', first.folder]) {
    assert.equal(k(w.home, ['bugs', 'quad-damage', '--summary', folder]).stdout, `${summaryFile(first)}kirunak-push: ${pushLine(summaryFile(first))}\n`);
  }
  assert.equal(summaryOf(w.home).folder, later.folder);
  mkdirSync(join(runsDir(w.home), '2026-10-29T08-00-00'));
  writeRun(w.home, { pid: OTHER, started: 'S', folder: join(runsDir(w.home), '2026-10-29T08-00-00') });
  assert.throws(() => summaryOf(w.home), /no Quad Damage summary in .*2026-10-29T08-00-00: its run goes on \(pid \d+\), and k bugs quad-damage --status shows it/);
});

test('progress: --progress prints the lines after n at once, waits for the next, and at the end prints the summary as --summary does (AC-16)', async () => {
  assert.equal(progressCommand('/h/bugs/quad-damage/2026-10-27T23-40-05', 4), 'k bugs quad-damage --progress /h/bugs/quad-damage/2026-10-27T23-40-05 --after 4');
  assert.equal(progressCommand("/h/a folder/it's", 0), "k bugs quad-damage --progress '/h/a folder/it'\\''s' --after 0");

  // A run that goes on: the whole lines after n, and the command for the next wait.
  const w = await qdWorkspace();
  const folder = join(runsDir(w.home), '2026-10-28T09-00-00');
  put(join(folder, 'progress.log'), '09:00 hub/a: started\n09:04 hub/a: fix committed 1234567\n09:05 hub/a: rev');
  writeRun(w.home, { pid: process.pid, started: '2026-10-28T09:00:00', folder });
  const now = await progressOf(w.home, folder, 0, { sleep: async () => assert.fail('no wait: two lines are there') });
  assert.deepEqual(now, { folder, after: 2, lines: ['09:00 hub/a: started', '09:04 hub/a: fix committed 1234567'], ended: false,
    next: progressCommand(folder, 2), summary: null, push: null });
  assert.equal(progressText(now), `09:00 hub/a: started\n09:04 hub/a: fix committed 1234567\nkirunak-next: ${progressCommand(folder, 2)}`);
  assert.equal((await progressOf(w.home, null, 1)).lines[0], '09:04 hub/a: fix committed 1234567', 'the latest run with no folder named');

  // Nothing new yet: it reads again every poll until a whole line comes.
  const slept = [];
  const waited = await progressOf(w.home, folder, 2, { poll: 7, sleep: async (ms) => {
    slept.push(ms);
    if (slept.length === 2) put(join(folder, 'progress.log'), `${progressFile(folder)}iew found something, try 2\n`);
  } });
  assert.deepEqual(slept, [7, 7]);
  assert.deepEqual([waited.lines, waited.next], [['09:05 hub/a: review found something, try 2'], progressCommand(folder, 3)]);

  // The run ends while it waits: its last lines, then its summary and push line.
  const summary = "Quad Damage, 09:00 to 09:40: 1 merged, 0 wait, 0 not reached\n- hub/a: merged 7654321 into hub's master\n";
  const ended = await progressOf(w.home, folder, 3, { poll: 1, sleep: async () => {
    put(join(folder, 'progress.log'), `${progressFile(folder)}09:40 hub/a: review clean, merged 7654321 into hub\n09:40 Quad Damage done: 1 merged, 0 wait, 0 not reached\n`);
    put(join(folder, 'summary.md'), summary);
  } });
  assert.equal(ended.ended, true);
  assert.equal(ended.next, null);
  assert.equal(progressText(ended), '09:40 hub/a: review clean, merged 7654321 into hub\n09:40 Quad Damage done: 1 merged, 0 wait, 0 not reached\n' +
    `${summary}kirunak-push: ${pushLine(summary)}`);
  // The k verb, as the session runs it: the summary just as --summary prints it.
  const out = k(w.home, ['bugs', 'quad-damage', '--progress', folder, '--after', '5']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, k(w.home, ['bugs', 'quad-damage', '--summary', folder]).stdout);
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--progress', folder, '--after', '4']).stdout.split('\n')[0], '09:40 Quad Damage done: 1 merged, 0 wait, 0 not reached');

  // A run killed before its summary, or a run file that names another run: it ends at once and says so.
  const killed = join(runsDir(w.home), '2026-10-28T10-00-00');
  put(join(killed, 'progress.log'), '10:00 hub/c: started\n');
  writeRun(w.home, { pid: process.pid, started: '2026-10-28T10:00:00', folder });
  const other = await progressOf(w.home, killed, 1, { sleep: async () => assert.fail('no wait: another run holds the run file') });
  assert.deepEqual([other.ended, other.lines, other.summary], [true, [], null]);
  writeRun(w.home, { pid: DEAD, started: '2026-10-28T10:00:00', folder: killed });
  const gone = await progressOf(w.home, killed, 0, { sleep: async () => assert.fail('no wait: its pid is dead') });
  assert.equal(progressText(gone), `10:00 hub/c: started\nQuad Damage ended with no summary: its process is gone; ${join(killed, 'run.log')} shows how far it got\n` +
    'kirunak-push: Quad Damage ended with no summary: its process is gone');

  await assert.rejects(progressOf(w.home, 'nowhere'), /no Quad Damage run in .*nowhere/);
  for (const args of [['--after', 'x'], ['--after', '-1'], ['--after', '1.5'], [folder, killed, '--after', '0']]) {
    assert.equal(k(w.home, ['bugs', 'quad-damage', '--progress', ...args]).status, 2, args.join(' '));
  }
});

test('k bugs quad-damage: refused with no marked bug; else a detached run that really works its bug, its pid, log and folder', async () => {
  const w = await fixWorkspace([['c', '2026-10-22', '']]);
  const marked = readFileSync(join(w.hub, 'kirunak', 'bugs', 'c.md'), 'utf8');
  writeFileSync(join(w.hub, 'kirunak', 'bugs', 'c.md'), marked.replace('quad-damage: yes', 'quad-damage: no'));
  const none = k(w.home, ['bugs', 'quad-damage']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no bug is marked quad-damage: yes, so a run would take none/);
  assert.equal(existsSync(quadDamagePath(w.home)), false);
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--dry-run']).status, 1);

  writeFileSync(join(w.hub, 'kirunak', 'bugs', 'c.md'), marked);
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--dry-run']).stdout, 'would start Quad Damage on 1 marked bug: hub/c\n');
  assert.equal(existsSync(runsDir(w.home)), false);
  const script = join(w.root, 'script.json');
  writeFileSync(script, JSON.stringify({ fixes: [fixed()], verdicts: ['clean'] }));
  const r = k(w.home, ['bugs', 'quad-damage', '--json', '--via', 'mod'], { FAKE_SCRIPT: script });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.bugs, ['hub/c']);
  assert.equal(out.log, join(out.folder, 'run.log'));
  assert.equal(dirname(out.folder), runsDir(w.home));
  for (let i = 0; i < 400 && !existsSync(join(out.folder, 'summary.md')); i++) await new Promise((done) => setTimeout(done, 50));
  for (let i = 0; i < 100 && existsSync(quadDamagePath(w.home)); i++) await new Promise((done) => setTimeout(done, 50));
  assert.match(readFileSync(join(out.folder, 'summary.md'), 'utf8'), /^Quad Damage, \d\d:\d\d to \d\d:\d\d: 1 merged, 0 waits?, 0 not reached\n- hub\/c: merged [0-9a-f]{7} into hub's master\n/);
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: one hour\n', 'the fake fix merged');
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'c.md')), false, 'the bug closed');
  assert.equal(existsSync(quadDamagePath(w.home)), false);
  const log = readFileSync(out.log, 'utf8');
  assert.match(log, /^--- Quad Damage, \S+ \(via mod\)\n/);
  assert.match(log, new RegExp(`Quad Damage runs: pid ${out.pid}, via mod`));
  assert.deepEqual(readdirSync(runsDir(w.home)), [out.folder.split('/').pop()]);
  assert.equal(k(w.home, ['bugs', 'quad-damage', 'x']).status, 2);
  // AC-16: its progress, and the session's wait on it, which ends at once with the summary.
  assert.match(progressFile(out.folder), /^\d\d:\d\d hub\/c: started\n\d\d:\d\d hub\/c: fix committed [0-9a-f]{7}\n\d\d:\d\d hub\/c: review clean, merged [0-9a-f]{7} into hub\n\d\d:\d\d Quad Damage done: 1 merged, 0 wait, 0 not reached\n$/);
  const waited = k(w.home, ['bugs', 'quad-damage', '--progress', out.folder, '--after', '0']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.stdout, `${progressFile(out.folder)}${k(w.home, ['bugs', 'quad-damage', '--summary']).stdout}`);
});

test('keepAwake: caffeinate -i -w on macOS, nothing elsewhere (E-2)', () => {
  assert.equal(keepAwake(123, { platform: 'linux' }), null);
  const c = keepAwake(123, { platform: 'darwin', bin: '/usr/bin/true' });
  assert.deepEqual(c.spawnargs, ['/usr/bin/true', '-i', '-w', '123']);
});

// --- gulnya/quad-damage S-4: one bug's work, with the fake runner of fixtures/quad-damage (no claude anywhere) ---

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'quad-damage', 'fake-runner.mjs');
const NOBODY = () => [];
// What a fixing session and a review start without (gulnya/headless-tools AC-1), kirunak's default.
const DENIED = ['Agent', 'Artifact', 'Workflow', 'AskUserQuestion', 'Skill', 'ScheduleWakeup', 'SendFeedback', 'ReportFindings', 'ListAgents', 'ReadNotifications'];
const FIXED = 'FIXED\nWhy: the cache expires hourly\n- bug/a: the fix\n';
const fixed = (text = 'cache: one hour\n') => ({ commit: { file: 'tiles.txt', text }, report: FIXED });

// A workspace whose hub holds tiles.txt and the bugs [slug, written, front lines], all marked yes and committed; kirunak's
// own checkout a scratch repo holding tiles.txt too; the fake runner its plugin (the CLI's) and `w.runner` (a test's,
// playing `script`); the heavy lock named with <session>.
async function fixWorkspace(bugs = [['a', '2026-10-20', '']], script = {}) {
  const w = await makeWorkspace();
  const self = join(w.root, 'kirunak-self');
  mkdirSync(self);
  gitInit(self);
  writeFileSync(join(self, 'tiles.txt'), 'cache: forever\n');
  gitCommitAll(self);
  writeFileSync(w.modulePath, readFileSync(w.modulePath, 'utf8')
    .replace("queue: './queue.md',", `queue: './queue.md',\n  kirunakRoot: ${JSON.stringify(self)},`)
    .replace("plugins: ['./plugins/checklist.mjs']", "plugins: ['./plugins/checklist.mjs', './plugins/fake-runner.mjs']"));
  const plugin = join(w.hub, 'kirunak', 'plugins', 'fake-runner.mjs');
  copyFileSync(FAKE, plugin);
  writeFileSync(join(w.hub, 'tiles.txt'), 'cache: forever\n');
  for (const [slug, written, front] of bugs) {
    put(join(w.hub, 'kirunak', 'bugs', `${slug}.md`), bugText(`hub/${slug}`, written, 'yes').replace('quad-damage: yes', `${front}quad-damage: yes`));
  }
  gitCommitAll(w.hub, 'the bugs');
  w.self = realpathSync(self);
  w.ws.kirunakRoot = w.self;
  w.ws.bugs = { ...w.ws.bugs, heavyLock: 'heavy run --session <session> --' };
  w.hubRoot = w.ws.repos.find((r) => r.name === 'hub').root;
  w.runner = (await import(pathToFileURL(plugin).href)).fake(script);
  return w;
}

const fixRun = (w, more = {}) => run({ ws: w.ws, ...seams(), runner: w.runner, work: (ctx) => workBug({ ...ctx, processes: NOBODY, ...more }) });
const fixes = (w) => w.runner.steps.filter((s) => s.env[FIX_ENV]);
const reviewsRun = (w) => w.runner.steps.filter((s) => s.env.KIRUNAK_BUG_REVIEW);
const gitIn = (root, ...args) => sh(root, 'git', args).trim();

test('fixed, then clean: the fixing session as AC-4/AC-14 say, the review merges and closes the bug', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', '']], { fixes: [fixed()], verdicts: ['clean'] });
  const r = await fixRun(w);
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome, b.repo]), [['hub/a', 'merged', 'hub']]);
  assert.equal(r.stopped, null);
  const [fix] = fixes(w);
  assert.equal(fix.cwd, w.hubRoot);
  assert.deepEqual(fix.addDirs, [r.folder]);
  assert.equal(fix.model, 'opus');
  assert.deepEqual(fix.disallowedTools, DENIED, 'gulnya/headless-tools AC-1: the tools loaded whole it cannot use');
  assert.equal('tools' in fix, false, 'no --tools: every deferred tool stays loadable through ToolSearch (E-1)');
  assert.equal(fix.maxTurns, 150);
  assert.equal('maxBudgetUsd' in fix, false);
  assert.equal(fix.env[FIX_ENV], 'hub/a');
  assert.equal(typeof fix.onMessage, 'function');
  assert.match(fix.brief, /^# Quad Damage: the bug hub\/a, try 1$/m);
  assert.ok(fix.brief.includes(`never bare: \`heavy run --session ${fix.sessionId} --\``), 'AC-14: its own session id in the heavy lock');
  assert.ok(fix.brief.includes(`Your report goes to ${join(r.folder, 'hub', 'a', 'fix-1.md')}.\n\n1. Read the bug`));
  assert.ok(!/\{\{\w+\}\}/.test(fix.brief), 'every placeholder filled');
  assert.ok(!fix.brief.includes('This is the retry'));
  const [rv] = reviewsRun(w);
  assert.ok(rv.brief.includes(`\`heavy run --session ${rv.sessionId} --\``), 'AC-14: the review\'s own session id too');
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a.md')), false);
  assert.equal(existsSync(`${w.hubRoot}-quad-a`), false, 'its worktree removed');
  assert.match(gitIn(w.hubRoot, 'log', '-1', '--format=%s'), /^kirunak: close the bug hub\/a: bug\/a merged into hub's master/);
  assert.equal(summaryFile(r).split('\n')[1], `- hub/a: merged ${r.bugs[0].sha.slice(0, 7)} into hub's master`);
  const log = readFileSync(join(r.folder, 'run.log'), 'utf8');
  assert.match(log, /hub\/a: fixing, try 1: session \S+ in /);
  const head = /hub\/a: fixing, try 1: 3 tool calls, exit 0; bug\/a at ([0-9a-f]{12}), 1 ahead of master\n/.exec(log)?.[1];
  assert.ok(head, log);
  assert.match(log, new RegExp(`hub/a: merged ${r.bugs[0].sha.slice(0, 12)} into hub\n`));
  assert.deepEqual(progressLines(r.folder), ['hub/a: started', `hub/a: fix committed ${head.slice(0, 7)}`,
    `hub/a: review clean, merged ${r.bugs[0].sha.slice(0, 7)} into hub`, 'Quad Damage done: 1 merged, 0 wait, 0 not reached'], 'AC-16');
  assert.match(log, /hub\/a: review: merged, kirunak\/bugs\/a\/review-1\.md\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8')).calls, 3);
  assert.equal(existsSync(reviewLockPath(w.home, 'hub/a')), false);
});

test('the run\'s log has each session\'s cost and first call; the workspace\'s list of tools denied, Agent always in it (gulnya/headless-tools AC-1, AC-3)', async () => {
  const usage = (input, read, write) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 40 });
  const w = await fixWorkspace([['a', '2026-10-20', '']], {
    fixes: [{ ...fixed(), first: usage(6, 0, 15306), cost: 0.704 }], verdicts: [{ verdict: 'clean', first: usage(3, 11000, 4321), cost: 1.1 }],
  });
  w.ws.bugs = { ...w.ws.bugs, disallowedTools: ['Skill', 'WebFetch'] };
  const r = await fixRun(w);
  assert.equal(r.bugs[0].outcome, 'merged');
  assert.deepEqual(fixes(w)[0].disallowedTools, ['Agent', 'Skill', 'WebFetch']);
  assert.deepEqual(reviewsRun(w)[0].disallowedTools, ['Agent', 'Skill', 'WebFetch']);
  assert.equal('tools' in reviewsRun(w)[0], false);
  const log = readFileSync(join(r.folder, 'run.log'), 'utf8');
  assert.match(log, /hub\/a: fixing, try 1: 3 tool calls, exit 0, \$0\.70, first call 15,312 tokens \(input 6, cache read 0, cache write 15,306\); bug\/a at [0-9a-f]{12}, 1 ahead of master\n/);
  assert.match(log, /hub\/a: review: merged, kirunak\/bugs\/a\/review-1\.md; \$1\.10, first call 15,324 tokens \(input 3, cache read 11,000, cache write 4,321\)\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8')).firstCall, { input: 6, cacheRead: 0, cacheWrite: 15306 });
});

test('skipped: the mark set to no, the reason under What was found, the bug file committed alone; FAILED and an empty FIXED wait', async () => {
  const skip = { calls: 2, report: 'SKIPPED\nWhy: the fix needs the owner\'s choice [of the hour]\n' };
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['b', '2026-10-21', ''], ['c', '2026-10-22', '']], {
    fixes: [skip, { calls: 4, report: 'FAILED\nWhy: the test cannot see the cache\n' }, { calls: 4, report: FIXED }],
  });
  writeFileSync(join(w.hubRoot, 'notes.txt'), 'the owner\'s work in progress\n');
  const r = await fixRun(w);
  assert.deepEqual(r.bugs, [
    { id: 'hub/a', outcome: 'waits', why: 'skipped, quad-damage now no: the fix needs the owner\'s choice (of the hour)' },
    { id: 'hub/b', outcome: 'waits', why: 'its fixing session failed: the test cannot see the cache; what holds is on bug/b in hub' },
    { id: 'hub/c', outcome: 'waits', why: 'its report says FIXED, but bug/c in hub has no commit ahead of master at a head no review refused' },
  ]);
  const text = readFileSync(join(w.hubRoot, 'kirunak', 'bugs', 'a.md'), 'utf8');
  assert.match(text, /^quad-damage: no$/m);
  assert.ok(text.includes(`- the tile cache never expires [file src/Tiles.kt]\n- Quad Damage skipped it on 2026-10-27: the fix needs the owner's choice (of the hour) [file ${join(r.folder, 'hub', 'a', 'fix-1.md')}]\n\n## Questions`));
  assert.deepEqual(checkBugText(text, 'hub/a'), []);
  assert.equal(gitIn(w.hubRoot, 'log', '-1', '--format=%s'), 'kirunak: bug hub/a: Quad Damage skipped it, quad-damage: no');
  assert.equal(gitIn(w.hubRoot, 'show', '--name-only', '--format=', 'HEAD'), 'kirunak/bugs/a.md');
  assert.equal(gitIn(w.hubRoot, 'status', '--porcelain'), '?? notes.txt');
  assert.equal(list(w.ws).find((b) => b.id === 'hub/a').quadDamage, false);
  assert.equal(reviewsRun(w).length, 0, 'no review after SKIPPED, FAILED or FIXED with nothing ahead');
  assert.deepEqual(progressLines(r.folder), [
    'hub/a: started', 'hub/a: skipped: the fix needs the owner\'s choice (of the hour)',
    'hub/b: started', 'hub/b: failed: the test cannot see the cache',
    'hub/c: started', 'hub/c: waits: its report says FIXED, but bug/c in hub has no commit ahead of master at a head no review refused',
    'Quad Damage done: 0 merged, 3 wait, 0 not reached',
  ], 'AC-16');
});

test('findings, then the retry from them, then clean: merged; the retry\'s brief names the review and its head (AC-7)', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', '']], { fixes: [fixed(), fixed('cache: as the forecast\n')], verdicts: ['findings', 'clean'] });
  const r = await fixRun(w);
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'merged']]);
  const [, retry] = fixes(w);
  const head1 = /^head: (\S+)$/m.exec(reviewsRun(w)[0].brief)[1];
  assert.match(retry.brief, /^# Quad Damage: the bug hub\/a, try 2$/m);
  assert.ok(retry.brief.includes(`This is the retry after a review: kirunak/bugs/a/review-1.md (${join(w.hubRoot, 'kirunak', 'bugs', 'a', 'review-1.md')}) judged the head ${head1} of bug/a`), retry.brief);
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: as the forecast\n');
  assert.equal(reviewsRun(w).length, 2);
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a')), false, 'closed with its reviews');
  const said = progressLines(r.folder);
  assert.deepEqual(said.map((l) => l.replace(/\b[0-9a-f]{7}\b/, '<sha>')), ['hub/a: started', 'hub/a: fix committed <sha>',
    'hub/a: review found something, try 2', 'hub/a: fix committed <sha>', 'hub/a: review clean, merged <sha> into hub',
    'Quad Damage done: 1 merged, 0 wait, 0 not reached'], 'AC-16');
  assert.notEqual(said[1], said[3], 'the retry\'s own commit');
});

test('findings twice: the bug waits with both reviews and the run goes on; a conflict merges nothing (E-5)', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], {
    fixes: [fixed(), fixed('cache: as the forecast\n'), { ...fixed(), master: { file: 'tiles.txt', text: 'cache: a day\n' } }],
    verdicts: ['findings', 'findings'],
  });
  const master = gitIn(w.hubRoot, 'rev-parse', 'master');
  const r = await fixRun(w);
  assert.deepEqual(r.bugs, [
    { id: 'hub/a', outcome: 'waits', why: 'refused twice by its reviews: kirunak/bugs/a/review-1.md and kirunak/bugs/a/review-2.md' },
    { id: 'hub/c', outcome: 'waits', why: 'bug/c no longer merges onto master (tiles.txt): kirunak/bugs/c/review-1.md' },
  ]);
  assert.equal(r.stopped, null);
  for (const n of [1, 2]) assert.match(readFileSync(join(w.hubRoot, 'kirunak', 'bugs', 'a', `review-${n}.md`), 'utf8'), /^verdict: findings$/m);
  assert.match(readFileSync(join(w.hubRoot, 'kirunak', 'bugs', 'c', 'review-1.md'), 'utf8'), /^verdict: conflict$/m);
  assert.equal(reviewsRun(w).length, 2, 'a conflict runs no review session');
  assert.equal(fixes(w).length, 3);
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: a day\n', 'nothing merged');
  assert.deepEqual(gitIn(w.hubRoot, 'log', '--format=%s', `${master}..master`).split('\n'), [
    'kirunak: the bug hub/c: bug/c no longer merges onto master, review-1.md', 'master moves on',
    'kirunak: review-2.md of the bug hub/a: findings', 'kirunak: review-1.md of the bug hub/a: findings',
  ]);
  for (const id of ['hub/a', 'hub/c']) assert.equal(existsSync(reviewLockPath(w.home, id)), false);

  // Taken again, a bug refused twice waits at once, and a conflict at its head is no retry either.
  const again = await fixRun(w);
  assert.deepEqual(again.bugs.map((b) => b.why), [
    'refused twice by its reviews: kirunak/bugs/a/review-1.md and kirunak/bugs/a/review-2.md',
    `its review kirunak/bugs/c/review-1.md refused the head ${gitIn(w.hubRoot, 'rev-parse', 'bug/c').slice(0, 12)} (conflict)`,
  ]);
  assert.equal(w.runner.steps.length, 5, 'no session for either');
});

test('the 150th call\'s result ends the session, and so do its minutes: the bug waits with its branch (AC-11)', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], {
    fixes: [{ calls: 160, sleep: 30, ...fixed() }, { calls: 2, sleep: 30, ...fixed() }],
  });
  const t = Date.now();
  const r = await fixRun(w, { limit: { calls: 150, minutes: 0.005 } });
  assert.ok(Date.now() - t < 10000, 'killed, not waited for');
  assert.deepEqual(r.bugs, [
    { id: 'hub/a', outcome: 'waits', why: 'its fixing session, try 1, reached 150 tool calls; what holds is on bug/a in hub' },
    { id: 'hub/c', outcome: 'waits', why: 'its fixing session, try 1, reached 0.005 minutes; what holds is on bug/c in hub' },
  ]);
  const a = JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8'));
  assert.deepEqual([a.calls, a.ended, a.exit], [150, 'calls', 143]);
  assert.equal(JSON.parse(readFileSync(join(r.folder, 'hub', 'c', 'fix-1.json'), 'utf8')).ended, 'minutes');
  assert.equal(reviewsRun(w).length, 0);
  assert.deepEqual(readdirSync(join(w.home, 'running')), [], 'each session unregistered');
});

test('a fix ready goes straight to review (E-1); a head a review refused takes its retry first (AC-7)', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-19', '']], { fixes: [fixed('cache: as the forecast\n')], verdicts: ['clean', 'clean'] });
  for (const slug of ['a', 'c']) {
    const tree = `${w.hubRoot}-quad-${slug}`;
    gitIn(w.hubRoot, 'worktree', 'add', '-q', '-b', `bug/${slug}`, tree, 'master');
    writeFileSync(join(tree, `${slug}.txt`), 'the fix\n');
    gitCommitAll(tree, 'the fix');
  }
  const headC = gitIn(w.hubRoot, 'rev-parse', 'bug/c');
  put(join(w.hubRoot, 'kirunak', 'bugs', 'c', 'review-1.md'), `---\nverdict: findings\nhead: ${headC}\nbase: x\n---\n\n## Findings\n1. c.txt:1: wrong\n`);
  gitCommitAll(w.hubRoot, 'the owner\'s review of c');
  assert.deepEqual(list(w.ws).map((b) => [b.id, b.fixReady]), [['hub/a', true], ['hub/c', false]]);
  const r = await fixRun(w);
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'merged'], ['hub/c', 'merged']]);
  assert.deepEqual(w.runner.steps.map((s) => (s.env[FIX_ENV] ? `fix ${s.env[FIX_ENV]}` : `review ${s.env.KIRUNAK_BUG_REVIEW}`)), ['review hub/a', 'fix hub/c', 'review hub/c']);
  assert.match(fixes(w)[0].brief, /^# Quad Damage: the bug hub\/c, try 2$/m);
  assert.ok(fixes(w)[0].brief.includes(`kirunak/bugs/c/review-1.md (${join(w.hubRoot, 'kirunak', 'bugs', 'c', 'review-1.md')}) judged the head ${headC} of bug/c`));
  assert.deepEqual(progressLines(r.folder).slice(0, 2), ['hub/a: started, fix ready, to review', `hub/a: review clean, merged ${r.bugs[0].sha.slice(0, 7)} into hub`], 'AC-16');
});

test('a fix in another repo than the bug\'s: run there with the bug\'s repo added, merged there, the bug closed in its own (E-6)', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', 'fix-repo: kirunak\n']], { fixes: [fixed()], verdicts: ['clean'] });
  const r = await fixRun(w);
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome, b.repo]), [['hub/a', 'merged', 'kirunak']]);
  const [fix] = fixes(w);
  assert.equal(fix.cwd, w.self);
  assert.deepEqual(fix.addDirs, [w.hubRoot, r.folder]);
  assert.match(fix.brief, /^Its fix repo: kirunak, at /m);
  assert.equal(readFileSync(join(w.self, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: forever\n');
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a.md')), false);
  assert.match(summaryFile(r), /- hub\/a: merged [0-9a-f]{7} into kirunak's master\n/);
});

test('E-7 and overage: no tool call or the login gone stops the run, the bug not reached; overage in the stream ends the session', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], { fixes: [{ calls: 0, turns: 1, report: null }] });
  let r = await fixRun(w);
  assert.equal(r.stopped, 'a fixing session made no tool call (exit 0: done)');
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'not-reached'], ['hub/c', 'not-reached']]);
  assert.match(summaryFile(r), /; stopped: a fixing session made no tool call/);

  w.runner = (await import(pathToFileURL(join(w.hub, 'kirunak', 'plugins', 'fake-runner.mjs')).href)).fake({
    fixes: [{ calls: 0, turns: 1, report: null, messages: [{ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Please run /login' }] } }] }],
  });
  r = await fixRun(w);
  assert.equal(r.stopped, 'the login is gone: done');
  assert.deepEqual(r.bugs.map((b) => b.outcome), ['not-reached', 'not-reached']);

  const overage = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } };
  w.runner = (await import(pathToFileURL(join(w.hub, 'kirunak', 'plugins', 'fake-runner.mjs')).href)).fake({ fixes: [{ calls: 5, sleep: 30, messages: [overage], ...fixed() }] });
  const t = Date.now();
  r = await fixRun(w);
  assert.ok(Date.now() - t < 10000);
  assert.equal(r.stopped, 'the plan is in extra usage');
  assert.deepEqual(r.bugs, [
    { id: 'hub/a', outcome: 'waits', why: 'the run stopped in its fixing session: the plan is in extra usage' },
    { id: 'hub/c', outcome: 'not-reached' },
  ]);
  assert.equal(JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8')).ended, 'overage');
});

test('E-7 for the review: a review session that wrote nothing before working stops the run; one that worked keeps its malformed review a finding', async () => {
  const login = { text: null, exitCode: 1, result: { type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'Invalid API key · Please run /login' } };
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], { fixes: [fixed()], verdicts: [login] });
  let r = await fixRun(w);
  assert.deepEqual(r.bugs, [
    { id: 'hub/a', outcome: 'waits', why: 'its review session failed: the login is gone: Invalid API key · Please run /login', stop: 'a review session failed: the login is gone: Invalid API key · Please run /login' },
    { id: 'hub/c', outcome: 'not-reached' },
  ].map(({ stop, ...b }) => b));
  assert.equal(r.stopped, 'a review session failed: the login is gone: Invalid API key · Please run /login');
  assert.equal(fixes(w).length, 1, 'no retry');
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: forever\n');

  // A crash with no result, and a session of one turn, stop it too.
  for (const [verdict, why] of [
    [{ text: null, exitCode: 1, result: null }, 'exit 1 and no result'],
    [{ text: null, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'I cannot.' } }, 'no tool call (exit 0: I cannot.)'],
  ]) {
    const u = await fixWorkspace([['a', '2026-10-20', '']], { fixes: [fixed()], verdicts: [verdict] });
    r = await fixRun(u);
    assert.equal(r.stopped, `a review session failed: ${why}`);
    assert.deepEqual(r.bugs.map((b) => [b.outcome, b.why]), [['waits', `its review session failed: ${why}`]]);
  }

  // A session that worked (3 turns) and wrote a malformed review: a finding, so the retry and a second review follow.
  const worked = { text: 'verdict: clean, I think\n' };
  const v = await fixWorkspace([['a', '2026-10-20', '']], { fixes: [fixed(), fixed('cache: as the forecast\n')], verdicts: [worked, 'clean'] });
  r = await fixRun(v);
  assert.equal(r.stopped, null);
  assert.deepEqual(r.bugs.map((b) => b.outcome), ['merged']);
  assert.match(gitIn(v.hubRoot, 'log', '--format=%s', 'master'), /^kirunak: review-1\.md of the bug hub\/a: findings$/m);
  assert.equal(fixes(v).length, 2);
});

// --- The owner's stop (gulnya/quad-damage S-14, AC-17) ---

// The owner's stop at hand without a signal: the run's listen seam, and stop(home) writing the stop request for this
// process's run and calling what the run listens with at once.
function ear() {
  const e = {
    heard: null,
    listen: (h) => {
      e.heard = h;
      return () => (e.heard = null);
    },
    stop: (home) => {
      put(stopPath(home), JSON.stringify({ pid: process.pid, by: 'owner', via: 'mod' }) + '\n');
      e.heard?.();
    },
  };
  return e;
}

// Until `ok()`, at most 10 s.
async function until(ok) {
  const ends = Date.now() + 10000;
  while (!ok()) {
    if (Date.now() > ends) throw new Error('waited 10 s in vain');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The run stopped by the owner: its stop line in summary.md and progress.log, its run file, stop request and locks gone.
function stoppedByOwner(w, r) {
  assert.equal(r.stopped, OWNER_STOP);
  assert.ok(summaryFile(r).split('\n')[0].endsWith('stopped: the owner stopped it'), summaryFile(r));
  assert.equal(progressLines(r.folder).at(-1), 'Quad Damage stopped: the owner stopped it');
  assert.equal(existsSync(quadDamagePath(w.home)), false);
  assert.equal(existsSync(stopPath(w.home)), false);
  for (const id of ['hub/a', 'hub/c']) assert.equal(existsSync(reviewLockPath(w.home, id)), false, id);
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /the owner asked the run to stop\n/);
}

test('stop while fixing: k bugs quad-damage --stop signals the run, its session is ended, the bug waits, the rest not reached', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], { fixes: [{ calls: 3, sleep: 30, ...fixed() }] });
  const ears = process.listenerCount(STOP_SIGNAL);
  const t = Date.now();
  const going = fixRun(w);
  await until(() => fixes(w).length === 1);
  assert.equal(process.listenerCount(STOP_SIGNAL), ears + 1, 'the run listens');
  assert.equal(state(w.home).phase, 'fixing');
  // The real verb and the real signal, to this process's run.
  const s = await stop({ ws: w.ws, via: 'mod', waitMs: 20000, poll: 20 });
  const r = await going;
  assert.ok(Date.now() - t < 10000, 'the session killed, not waited for');
  assert.equal(s.stopped, true);
  assert.equal(s.text, `Quad Damage stopped: the owner stopped it; its summary: ${join(r.folder, 'summary.md')}`);
  assert.deepEqual(r.bugs, [{ id: 'hub/a', outcome: 'waits', why: OWNER_WHY }, { id: 'hub/c', outcome: 'not-reached' }]);
  stoppedByOwner(w, r);
  assert.equal(JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8')).ended, 'stopped');
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /hub\/a: fixing, try 1: \d+ tool calls, ended by the owner's stop, exit 143/);
  assert.deepEqual(progressLines(r.folder), ['hub/a: started', 'hub/a: waits: the owner stopped the run', 'Quad Damage stopped: the owner stopped it']);
  assert.equal(summaryFile(r).split('\n')[0], 'Quad Damage, 23:40 to 23:40: 0 merged, 1 wait, 1 not reached; stopped: the owner stopped it');
  assert.equal(reviewsRun(w).length, 0);
  assert.deepEqual(readdirSync(join(w.home, 'running')), [], 'its session unregistered');
  assert.equal(process.listenerCount(STOP_SIGNAL), ears, 'the run no longer listens');
  assert.equal(events(w.home).find((e) => e.kind === 'quad-damage-stop').via, 'mod');
});

test('stop while reviewing: the review session is ended and nothing of it kept; the bug waits with its branch', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], { fixes: [fixed()], verdicts: [{ verdict: 'clean', sleep: 30 }] });
  const e = ear();
  const t = Date.now();
  const going = run({ ws: w.ws, ...seams(), runner: w.runner, listen: e.listen, work: (ctx) => workBug({ ...ctx, processes: NOBODY }) });
  await until(() => reviewsRun(w).length === 1);
  assert.equal(state(w.home).phase, 'reviewing');
  e.stop(w.home);
  const r = await going;
  assert.ok(Date.now() - t < 10000, 'the review killed, not waited for');
  assert.deepEqual(r.bugs, [{ id: 'hub/a', outcome: 'waits', why: OWNER_WHY }, { id: 'hub/c', outcome: 'not-reached' }]);
  stoppedByOwner(w, r);
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a', 'review-1.md')), false, 'no review kept');
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a.md')), true);
  assert.match(gitIn(w.hubRoot, 'rev-parse', '--verify', 'bug/a'), /^[0-9a-f]{40}$/, 'its branch kept');
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: forever\n', 'nothing merged');
  assert.equal(events(w.home).filter((x) => x.kind === 'bug-review').at(-1).outcome, 'stopped');
});

test('stop during a merge: the merge under way finishes and the bug counts merged; the rest not reached', async () => {
  const w = await fixWorkspace([['a', '2026-10-20', ''], ['c', '2026-10-22', '']], { fixes: [fixed(), fixed()], verdicts: ['clean', 'clean'] });
  const e = ear();
  const phases = [];
  const merging = (o) => review({ ...o, onMerging: () => {
    o.onMerging();
    phases.push(state(w.home).phase);
    e.stop(w.home);
  } });
  const r = await run({ ws: w.ws, ...seams(), runner: w.runner, listen: e.listen, work: (ctx) => workBug({ ...ctx, processes: NOBODY, review: merging }) });
  assert.deepEqual(phases, ['merging']);
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'merged'], ['hub/c', 'not-reached']]);
  stoppedByOwner(w, r);
  assert.equal(readFileSync(join(w.hubRoot, 'tiles.txt'), 'utf8'), 'cache: one hour\n', 'merged');
  assert.equal(existsSync(join(w.hubRoot, 'kirunak', 'bugs', 'a.md')), false, 'the bug closed');
  assert.equal(fixes(w).length, 1, 'hub/c never started');
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /hub\/a: review clean: merging\n/);
});

test('stop while waiting for the 5-hour window: the wait ends at once, the bug waits, the rest not reached', async () => {
  const w = await qdWorkspace();
  const e = ear();
  const s = seams([reading(95)]);
  const work = async (ctx) => {
    await ctx.beforeSession();
    return { outcome: 'waits', why: 'a stub' };
  };
  const waits = [];
  const sleep = () => {
    waits.push(state(w.home).phase);
    setImmediate(() => e.stop(w.home));
    return new Promise(() => {});
  };
  const r = await run({ ws: w.ws, ...s, sleep, work, listen: e.listen });
  assert.deepEqual(waits, ['waiting']);
  assert.deepEqual(r.bugs, [{ id: 'hub/a', outcome: 'waits', why: OWNER_WHY }, { id: 'hub/c', outcome: 'not-reached' }]);
  stoppedByOwner(w, r);
  assert.deepEqual(progressLines(r.folder), ['Quad Damage paused for the 5-hour window until 01:15', 'hub/a: waits: the owner stopped the run',
    'Quad Damage stopped: the owner stopped it']);
});

test('stop between bugs: asked before the run takes one, no bug is taken; asked as a bug ends, it keeps its outcome', async () => {
  const w = await qdWorkspace();
  const e = ear();
  let worked = 0;
  const work = async () => {
    worked++;
    return { outcome: 'waits', why: 'a stub' };
  };
  e.stop(w.home);
  const before = await run({ ws: w.ws, ...seams(), work, listen: e.listen });
  assert.equal(worked, 0);
  assert.deepEqual(before.bugs, [{ id: 'hub/a', outcome: 'not-reached' }, { id: 'hub/c', outcome: 'not-reached' }]);
  stoppedByOwner(w, before);

  const as = async (ctx) => {
    worked++;
    e.stop(ctx.home);
    return { outcome: 'waits', why: 'a stub' };
  };
  const r = await run({ ws: w.ws, ...seams(), work: as, listen: e.listen });
  assert.equal(worked, 1);
  assert.deepEqual(r.bugs, [{ id: 'hub/a', outcome: 'waits', why: 'a stub' }, { id: 'hub/c', outcome: 'not-reached' }]);
  stoppedByOwner(w, r);

  // A stop request another pid's run left is no stop of this one, and goes.
  put(stopPath(w.home), JSON.stringify({ pid: DEAD, by: 'owner' }) + '\n');
  const on = await run({ ws: w.ws, ...seams(), work, listen: e.listen });
  assert.equal(on.stopped, null);
  assert.equal(on.bugs.length, 2);
  assert.equal(existsSync(stopPath(w.home)), false);
});

test('--stop with no run changes nothing; a run that does not end in time is still stopping; --dry-run reads only', async () => {
  const w = await qdWorkspace();
  assert.deepEqual(await stop({ ws: w.ws }), { stopped: false, text: 'Quad Damage is not running' });
  assert.equal(existsSync(stopPath(w.home)), false);
  const none = k(w.home, ['bugs', 'quad-damage', '--stop', '--via', 'mod']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, 'Quad Damage is not running\n');
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--stop', '--dry-run']).stdout, 'Quad Damage is not running\n');
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--stop', '--status']).status, 2);
  assert.equal(existsSync(stopPath(w.home)), false);

  writeRun(w.home, { pid: OTHER, started: '2026-10-27T23:40:05', by: 'owner', via: 'shell', folder: null, bug: 'hub/a', phase: 'fixing', try: 1, since: '2026-10-27T23:41:00' });
  assert.equal(k(w.home, ['bugs', 'quad-damage', '--stop', '--dry-run']).stdout, 'would stop Quad Damage: Quad Damage runs: hub/a, fixing (try 1) since 23:41\n');
  assert.equal(existsSync(stopPath(w.home)), false);
  const kills = [];
  const s = await stop({ ws: w.ws, kill: (pid, sig) => kills.push([pid, sig]), waitMs: 100, poll: 20 });
  assert.deepEqual(kills, [[OTHER, STOP_SIGNAL]]);
  assert.deepEqual(s, { stopped: false, pid: OTHER, folder: null, text: `Quad Damage is still stopping: pid ${OTHER}; k bugs quad-damage --status shows it` });
  assert.equal(JSON.parse(readFileSync(stopPath(w.home), 'utf8')).pid, OTHER, 'the request stays for the run to take');
});

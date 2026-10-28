import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lock } from '../lib/bug-review.mjs';
import { checkBugText, drop, fixLine, list, quadDamagePath, reviewLockPath, reviewing } from '../lib/bugs.mjs';
import { start as intakeStart } from '../lib/intake.mjs';
import {
  claim, FIX_ENV, keepAwake, preview, pushLine, release, run, runsDir, start, state, statusLine, summaryOf, summaryText, workBug,
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
});

test('run: the week at 98%, extra usage or a failed reading stops it, the bugs left not reached (AC-10)', async () => {
  const cases = [
    [[reading(10, 98)], "the week's limit is at 98%"],
    [[reading(10, 97.99), reading(10, 98.5)], "the week's limit is at 98%"],
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
  }
  // A runner with no reading stops it as well.
  const w = await qdWorkspace();
  const r = await run({ ws: w.ws, ...seams(), runner: {}, work: async (ctx) => ctx.beforeSession() });
  assert.equal(r.stopped, 'the limits reading failed: the runner has no limits reading');
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
  const text = summaryText({ started: '2026-10-27T23:40:05+00:00', ended: '2026-10-28T03:02:00+00:00', bugs, stopped: "the week's limit is at 98%" });
  assert.equal(text, "Quad Damage, 23:40 to 03:02: 1 merged, 1 wait, 1 not reached; stopped: the week's limit is at 98%\n" +
    "- hub/a: merged 0123456 into kirunak's master\n- hub/b: waits: the review found two things twice\n- hub/c: not reached\n");
  assert.equal(pushLine(text), "Quad Damage, 23:40 to 03:02: 1 merged, 1 wait, 1 not reached; stopped: the week's limit is at 98%. " +
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
});

test('keepAwake: caffeinate -i -w on macOS, nothing elsewhere (E-2)', () => {
  assert.equal(keepAwake(123, { platform: 'linux' }), null);
  const c = keepAwake(123, { platform: 'darwin', bin: '/usr/bin/true' });
  assert.deepEqual(c.spawnargs, ['/usr/bin/true', '-i', '-w', '123']);
});

// --- gulnya/quad-damage S-4: one bug's work, with the fake runner of fixtures/quad-damage (no claude anywhere) ---

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'quad-damage', 'fake-runner.mjs');
const NOBODY = () => [];
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
  assert.deepEqual(fix.disallowedTools, ['Agent']);
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
  assert.match(log, /hub\/a: fixing, try 1: 3 tool calls, exit 0\n/);
  assert.match(log, /hub\/a: review: merged, kirunak\/bugs\/a\/review-1\.md\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(r.folder, 'hub', 'a', 'fix-1.json'), 'utf8')).calls, 3);
  assert.equal(existsSync(reviewLockPath(w.home, 'hub/a')), false);
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

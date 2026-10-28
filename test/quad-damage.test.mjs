import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { lock } from '../lib/bug-review.mjs';
import { drop, list, quadDamagePath, reviewLockPath, reviewing } from '../lib/bugs.mjs';
import { start as intakeStart } from '../lib/intake.mjs';
import {
  claim, keepAwake, preview, pushLine, release, run, runsDir, start, state, statusLine, summaryOf, summaryText, workBug,
} from '../lib/quad-damage.mjs';
import { events, k, makeWorkspace } from './helpers.mjs';

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

test('run: the marked bugs in the list\'s order, the stub\'s outcome, the lock and the run file let go', async () => {
  const w = await qdWorkspace();
  const s = seams();
  const awake = [];
  const r = await run({ ws: w.ws, ...s, caffeinate: (pid) => awake.push(pid) });
  assert.deepEqual(awake, [process.pid]);
  assert.equal(r.folder, join(runsDir(w.home), '2026-10-27T23-40-05'));
  assert.deepEqual(r.bugs.map((b) => [b.id, b.outcome]), [['hub/a', 'waits'], ['hub/c', 'waits']]);
  assert.equal(summaryFile(r), 'Quad Damage, 23:40 to 23:40: 0 merged, 2 wait, 0 not reached\n' +
    '- hub/a: waits: not built yet\n- hub/c: waits: not built yet\n');
  assert.equal(existsSync(quadDamagePath(w.home)), false);
  assert.equal(state(w.home), null);
  assert.equal(reviewing(w.home, 'hub/a'), null);
  assert.equal(existsSync(reviewLockPath(w.home, 'hub/a')), false);
  assert.match(readFileSync(join(r.folder, 'run.log'), 'utf8'), /^23:40:05 Quad Damage runs: pid \d+, via shell\n23:40:05 hub\/a: taken\n/);
  assert.equal(JSON.parse(readFileSync(join(r.folder, 'state.json'), 'utf8')).bugs.length, 2);
  const e = events(w.home).at(-1);
  assert.deepEqual({ ...e, time: null }, { time: null, kind: 'quad-damage', via: 'shell', folder: r.folder, merged: 0, waits: 2, notReached: 0, stopped: null });
  assert.deepEqual(await workBug({}), { outcome: 'waits', why: 'not built yet' });

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
    assert.deepEqual(list(w.ws).find((x) => x.id === ctx.bug.id).quadDamageRun, { phase: 'fixing', try: 1 });
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


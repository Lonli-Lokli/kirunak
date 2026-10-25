// Times on the board are local: the expected text below is read in UTC.
process.env.TZ = 'UTC';

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot } from '../lib/board.mjs';
import { renderBrief } from '../lib/board-brief.mjs';
import { entry, lastStepShort, metLine } from '../lib/board-model.mjs';
import { rows } from '../lib/list.mjs';
import { STATES } from '../lib/state.mjs';
import { addTask, draftsAt, fixture, NOW, queuedAndParked, sessionsAt } from './board-fixture.mjs';
import { k } from './helpers.mjs';

const brief = async (w) => renderBrief(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);

// The fixture's brief board, word for word: the text of the mod's /k-board dialog (kirunak-phone A-7).
const EXPECTED = `Made at 2026-11-07 12:00.

Working on now (2)
weather/hourly-chart: in progress, queue 1, S-2 running, 0 of 3 met
hub/reviewed: in review, 1 of 3 met, 1 not met

Proposed (1)
weather/offline-forecast: proposed, 0 of 4 met

Queued (1)
weather/next-up: queued, queue 2, 0 of 3 met

Parked (1)
hub/later: parked, 0 of 3 met

Done this week (1)
weather/recent: done, 0 of 3 met

No lock, no heavy jobs waiting, 1 of 2 steps running, no device claims.`;

test('the brief board: when it was made, the tasks worked on, every other task by state, one line for the machine', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  const b = await brief(w);
  assert.equal(b.text, EXPECTED);
  assert.equal(b.made, '2026-11-07 12:00');
  assert.deepEqual(b.ids, ['weather/hourly-chart', 'hub/reviewed', 'weather/offline-forecast', 'weather/next-up', 'hub/later', 'weather/recent']);
});

test('the groups (kirunak-phone A-9): each paragraph of the text named, counted, its ids and its entry lines, in its order, and the machine\'s line', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  const b = await brief(w);
  assert.deepEqual(b.groups, [
    {
      name: 'Working on now',
      count: 2,
      ids: ['weather/hourly-chart', 'hub/reviewed'],
      lines: ['weather/hourly-chart: in progress, queue 1, S-2 running, 0 of 3 met', 'hub/reviewed: in review, 1 of 3 met, 1 not met'],
    },
    { name: 'Proposed', count: 1, ids: ['weather/offline-forecast'], lines: ['weather/offline-forecast: proposed, 0 of 4 met'] },
    { name: 'Queued', count: 1, ids: ['weather/next-up'], lines: ['weather/next-up: queued, queue 2, 0 of 3 met'] },
    { name: 'Parked', count: 1, ids: ['hub/later'], lines: ['hub/later: parked, 0 of 3 met'] },
    { name: 'Done this week', count: 1, ids: ['weather/recent'], lines: ['weather/recent: done, 0 of 3 met'] },
  ]);
  assert.equal(b.machine, 'No lock, no heavy jobs waiting, 1 of 2 steps running, no device claims.');
  // The text is made of them, so the two never disagree.
  assert.equal(b.text, [`Made at ${b.made}.`, ...b.groups.map((g) => [`${g.name} (${g.count})`, ...g.lines].join('\n')), b.machine].join('\n\n'));
  assert.deepEqual(b.ids, b.groups.flatMap((g) => g.ids));
});

test('a group\'s name, a choice of the first dialog, starts with a capital letter and never a digit, whatever the state: the phone numbers its choices itself', async () => {
  for (const s of STATES) assert.match(s, /^[a-z][a-z ]*$/, `a state named in words: ${s}`);
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  for (const g of (await brief(w)).groups) assert.match(g.name, /^[A-Z][a-z ]*$/);
});

test('plain text with no markdown mark, one line per entry however long, and the ids in the order the text lists them', async () => {
  const w = await fixture();
  sessionsAt(w);
  const long = 'a-task-slug-that-runs-to-forty-letters-x';
  addTask(w.weather, `weather/${long}`, `A title of *many* words ${'that goes on and on '.repeat(5)}`);
  const b = await brief(w);
  const lines = b.text.split('\n');
  for (const l of lines) {
    assert.ok(!/^(#|- |\* |\d+\. |\s)/.test(l) && !/[`*]/.test(l), `a markdown mark: ${l}`);
    assert.match(l, /^(|Made at .*\.|[A-Z][a-z ]+ \(\d+\)|[a-z0-9-]+\/[a-z0-9-]+: [a-z].*|(No lock|Lock: ).*\.)$/, `made, a group, an entry or the machine: ${l}`);
  }
  assert.ok(lines.includes(`weather/${long}: draft, 0 of 3 met`), 'the title is left to the card');
  const entries = lines.filter((l) => /^[a-z0-9-]+\/[a-z0-9-]+: /.test(l)).map((l) => l.slice(0, l.indexOf(':')));
  assert.deepEqual(b.ids, entries);
  assert.ok(!b.text.endsWith('\n'));
});

test('an entry: the queue place and the last step only when there are, a done task\'s step left out, the verdicts counted', () => {
  const r = (verdicts, more = {}) => ({ id: 'a/b', state: 'in progress', ac: verdicts.map((v, i) => ({ id: `AC-${i + 1}`, verdict: v })), e: [], ...more });
  assert.equal(metLine(r(['met', 'not met', 'needs owner', 'needs owner', 'needs device', null])), '1 of 6 met, 1 not met, 2 need you, 1 needs a device');
  assert.equal(metLine(r(['met', 'needs owner', 'needs device', 'needs device'])), '1 of 4 met, 1 needs you, 2 need a device');
  assert.equal(metLine(r([])), null);
  assert.equal(lastStepShort('2026-10-21 06:06 S-20 finished'), 'S-20 done');
  assert.equal(lastStepShort('2026-10-21 12:02 S-15 started (session e3)'), 'S-15 running');
  assert.equal(lastStepShort('2026-10-21 12:02 S-4 failed: no build'), 'S-4 failed');
  assert.equal(lastStepShort(null), null);
  assert.equal(entry(r(['met'], { queue: 3, step: '2026-10-21 06:06 S-20 finished' })), 'a/b: in progress, queue 3, S-20 done, 1 of 1 met');
  assert.equal(entry(r([], { state: 'proposed' })), 'a/b: proposed');
  assert.equal(entry(r(['met'], { state: 'done', step: '2026-10-21 06:06 S-9 started' })), 'a/b: done, 1 of 1 met');
});

test('the machine\'s line: the lock, the heavy jobs waiting, the running steps and the device claims', async () => {
  const w = await fixture();
  mkdirSync(join(w.home, 'guard', 'lock'), { recursive: true });
  mkdirSync(join(w.home, 'running'), { recursive: true });
  writeFileSync(join(w.home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 's1', what: 'weather unit tests', pid: 1, since: '2026-11-07T11:50:00Z' }));
  writeFileSync(join(w.home, 'guard', 'queue'), '{"session":"s2","what":"hub build"}\n{"session":"s3","what":"hub tests"}\n');
  writeFileSync(join(w.home, 'guard', 'claims.json'), JSON.stringify([{ resource: 'phone-1', by: 's1' }]));
  writeFileSync(join(w.home, 'running', '1.json'), JSON.stringify({ task: 'weather/hourly-chart', step: 'S-2', session: 's1' }));
  const last = (await brief(w)).text.split('\n').pop();
  assert.equal(last, 'Lock: weather unit tests (session s1, since 2026-11-07 11:50), 2 heavy jobs waiting, 1 of 2 steps running, 1 device claim.');
});

test('k board --brief prints the text; with --json { made, text, ids, groups, machine }, text exactly the printed text; it writes nothing', async () => {
  const w = await fixture();
  const plain = k(w.home, ['board', '--brief']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^Made at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.\n\nWorking on now \(0\)\n\nProposed \(1\)\nweather\/offline-forecast: proposed, 0 of 4 met\n\n/);
  const json = k(w.home, ['board', '--brief', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const b = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(b), ['made', 'text', 'ids', 'groups', 'machine']);
  assert.equal(`${b.text}\n`, plain.stdout);
  assert.ok(b.text.startsWith(`Made at ${b.made}.`));
  assert.deepEqual(b.ids, ['weather/offline-forecast', 'weather/hourly-chart', 'hub/reviewed', 'weather/recent']);
  // An empty group is named and counted, as the text names it; the machine's line is the text's last.
  assert.deepEqual(b.groups.map((g) => [g.name, g.count]), [['Working on now', 0], ['Proposed', 1], ['In progress', 1], ['In review', 1], ['Done this week', 1]]);
  assert.ok(b.text.endsWith(`\n\n${b.machine}`));
  assert.ok(!existsSync(join(w.home, 'board.html')));
});

test('the drafts after the tasks, before the machine\'s line: a group Drafts, one line a draft with its id, title and date written, its ids after the tasks\' (kirunak-drafts AC-9)', async () => {
  const w = await fixture();
  assert.ok(!(await brief(w)).groups.some((g) => g.name === 'Drafts'), 'no group when no draft waits');
  draftsAt(w);
  const b = await brief(w);
  const lines = [
    'weather/wind-alerts: Wind alerts <for> cyclists, written 2026-11-05',
    'hub/short-jobs: Short jobs first in the heavy-job queue, so a quick test never waits behind a long build, written 2026-11-06',
  ];
  assert.deepEqual(b.groups.at(-1), { name: 'Drafts', count: 2, ids: ['weather/wind-alerts', 'hub/short-jobs'], lines });
  assert.ok(b.text.endsWith(`Done this week (1)\nweather/recent: done, 0 of 3 met\n\nDrafts (2)\n${lines.join('\n')}\n\n${b.machine}`), b.text);
  assert.deepEqual(b.ids, b.groups.flatMap((g) => g.ids));
  assert.deepEqual(b.ids.slice(-2), ['weather/wind-alerts', 'hub/short-jobs']);
});

test('k board --brief --json gives the Drafts group in groups, as the mod\'s /k-board reads every group', async () => {
  const w = await fixture();
  draftsAt(w);
  const r = k(w.home, ['board', '--brief', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['groups', 'ids', 'machine', 'made', 'text']);
  assert.deepEqual(out.groups.map((g) => [g.name, g.count]).at(-1), ['Drafts', 2]);
});

test('a step k run stopped for the owner: the brief board opens with Stopped for you, its notice in at most 3 lines of 80 characters with the title and id (design/orchestrator.md §2, E-15)', async () => {
  const w = await fixture();
  const list = await rows(w.ws, { all: true });
  const stop = { step: 'S-2', kind: 'escalated', what: 'stopped, failed on every rung', why: 'exit 1', dir: 'kirunak/tasks/hourly-chart/steps/S-2/', reports: ['steps/S-2/failure-1.md', 'steps/S-2/failure-2.md', 'steps/S-2/failure-3.md', 'steps/S-2/failure-4.md'] };
  const r = list.find((x) => x.id === 'weather/hourly-chart');
  const b = renderBrief(list.map((x) => (x === r ? { ...x, stops: [stop] } : x)), snapshot(w.ws), NOW);
  const [first] = b.groups;
  assert.deepEqual([first.name, first.count, first.ids], ['Stopped for you', 1, ['weather/hourly-chart']]);
  // The title and id fill the first line, so what happened opens the second, before why.
  assert.deepEqual(first.lines, [`${r.title} (weather/hourly-chart)`, 'S-2 stopped, failed on every rung: exit 1', 'read kirunak/tasks/hourly-chart/steps/S-2/ (failure-1.md … failure-4.md)']);
  assert.ok(first.lines.length <= 3 && first.lines.every((l) => l.length <= 80), first.lines.join('\n'));
  assert.ok(b.text.startsWith(`Made at 2026-11-07 12:00.\n\nStopped for you (1)\n${first.lines.join('\n')}\n\nWorking on now (`), b.text);
  assert.equal(b.ids[0], 'weather/hourly-chart');
  // With nothing stopped the board is as it was.
  assert.ok(!renderBrief(list, snapshot(w.ws), NOW).groups.some((g) => g.name === 'Stopped for you'));
});

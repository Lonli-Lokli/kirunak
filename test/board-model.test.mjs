import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { snapshot, status } from '../lib/board.mjs';
import { bugEntry, bugTail, draftEntry, draftTail, facts, items, model, sessions } from '../lib/board-model.mjs';
import { rows } from '../lib/list.mjs';
import { bugAt, bugsAt, draftsAt, fixture, NOW, queuedAndParked, sessionsAt } from './board-fixture.mjs';

async function board({ more = () => {} } = {}) {
  const w = await fixture();
  sessionsAt(w);
  more(w);
  return model(await rows(w.ws, { all: true }), { ...status(w.ws), sessions: sessions(w.ws) }, NOW);
}

test('the session records that name a task, by session id; a record with no task is left out', async () => {
  const w = await fixture();
  sessionsAt(w);
  assert.deepEqual(sessions(w.ws).map((s) => [s.id, s.task]), [['s1', 'weather/hourly-chart'], ['s9', 'weather/recent']]);
});

test('the tasks sessions work on first, in k list\'s order, then every other task by state, done ones for a week', async () => {
  const m = await board({ more: queuedAndParked });
  assert.deepEqual(m.working.map((r) => r.id), ['weather/hourly-chart', 'hub/reviewed']);
  assert.match(m.working[0].who.join('\n'), /^session s1 since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(m.working[1].who.join('\n'), /^step S-3 running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(m.states.map((s) => [s.title, s.rows.map((r) => r.id)]), [
    ['proposed', ['weather/offline-forecast']],
    ['queued', ['weather/next-up']],
    ['parked', ['hub/later']],
    ['done this week', ['weather/recent']],
  ], 'a task done more than a week ago is left out, and a done task named by an old session is not worked on');
  assert.match(m.made, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('each card\'s facts start with its state, and every AC and E has a verdict in words', async () => {
  const m = await board();
  const [chart, reviewed] = m.working;
  assert.deepEqual(facts(chart).slice(0, 2), ['state: in progress, queue place 1', 'step: 2026-11-03 14:02 S-2 started (opus, session 7c1)']);
  assert.ok(facts(reviewed).includes('review: review-2.md, verdict: not met (AC-2)'));
  assert.deepEqual(items(reviewed).map((x) => `${x.id} ${x.verdict}`), ['AC-1 met', 'AC-2 not met', 'E-1 none']);
});

test('last, the lock, its queue, the running steps, the claims and the task queue', async () => {
  const m = await board();
  assert.equal(m.lock, 'no lock');
  assert.deepEqual(m.machine.map((p) => [p.title, p.rows]), [
    ['Heavy-job queue', []],
    ['Running steps: 1 of 2', [m.machine[1].rows[0]]],
    ['Device claims', []],
    ['Task queue', ['weather/hourly-chart (in progress)']],
  ]);
  assert.match(m.machine[1].rows[0], /^hub\/reviewed S-3, session s2, since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('a bug among the drafts names its task before the date, "bug of <task>"; a plain draft\'s line is unchanged (kirunak-spikes AC-6, D-2)', async () => {
  const w = await fixture();
  draftsAt(w);
  bugAt(w);
  const m = model(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);
  assert.deepEqual(m.drafts.map((d) => [d.id, d.bugOf]), [['weather/wind-alerts', null], ['hub/short-jobs', null], ['hub/midnight-gap', 'weather/recent']]);
  assert.deepEqual(m.drafts.map(draftEntry), [
    'weather/wind-alerts: Wind alerts <for> cyclists, written 2026-11-05',
    'hub/short-jobs: Short jobs first in the heavy-job queue, so a quick test never waits behind a long build, written 2026-11-06',
    'hub/midnight-gap: The chart skips the hour after midnight, bug of weather/recent, written 2026-11-07',
  ]);
  assert.equal(draftTail({ bugOf: 'weather/recent', written: null }), 'bug of weather/recent, no date');
  assert.equal(draftTail({ bugOf: null, written: '2026-11-05' }), 'written 2026-11-05');
  assert.doesNotMatch(m.drafts.map(draftEntry).join('\n'), /spike/i, 'called a bug, never a spike');
});

test('the bugs that wait, before the drafts: k bugs\' order, a fix ready first, each line with its fix, its task and its date, and k waiting\'s line for them; none and no line when none waits (gulnya/kirunak-bugs AC-7)', async () => {
  const w = await fixture();
  draftsAt(w);
  let m = model(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);
  assert.deepEqual([m.bugs, m.bugsLine], [[], '']);
  bugsAt(w);
  m = model(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);
  assert.deepEqual(Object.keys(m).slice(Object.keys(m).indexOf('bugs'), Object.keys(m).indexOf('bugs') + 3), ['bugs', 'bugsLine', 'drafts']);
  assert.deepEqual(m.bugs.map((b) => [b.id, b.fixReady, b.fix, b.bugOf]), [['hub/queue-stuck', true, 'fix ready', 'weather/recent'], ['weather/rain-icon', false, 'no fix', null]]);
  assert.equal(m.bugsLine, '2 bugs wait, 1 with a fix ready: /k-bugs');
  assert.deepEqual(m.bugs.map(bugEntry), [
    'hub/queue-stuck: The queue keeps a finished job, fix ready, bug of weather/recent, written 2026-11-06',
    'weather/rain-icon: The rain icon shows <sun>, no fix, written 2026-11-04',
  ]);
  assert.equal(bugTail({ fix: 'reviewing', bugOf: null, written: null }), 'reviewing, no date');
  assert.equal(m.drafts.length, 2, 'the drafts as they were');
});

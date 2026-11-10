import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { k, makeWorkspace } from './helpers.mjs';
import { updateSession } from '../lib/keeper.mjs';
import { lengthOf, rows, span, text } from '../lib/heavy.mjs';

// Clock times are local: every case here reads them in UTC, the CLI's child too.
process.env.TZ = 'UTC';

// Three tasks with their own past. weather/radar: agent 30m, heavy 20m, review 10m finished, S-14-M1 running, an
// [owner] step and two suffixed ids (E-5). weather/tiles: one agent step of 40m, S-2 started. hub/sync-maps: no review
// behind it, so its bracket is `?` (AC-8).
const PLANS = {
  'weather/radar': {
    plan: ['### S-1 Write [agent]', '### S-2 Build [heavy]', 'command: make', '### S-3 Review [review]', '### S-4 Try it [owner]', '### S-14-M1 More [agent]', '### S-23a Last [agent]'],
    progress: ['2026-11-10 09:00 S-1 started (opus high, session a)', '2026-11-10 09:30 S-1 finished', '2026-11-10 09:30 S-2 started (heavy)', '2026-11-10 09:50 S-2 finished',
      '2026-11-10 09:50 S-3 started (opus high, session b)', '2026-11-10 10:00 S-3 finished', '2026-11-10 10:00 S-14-M1 started (opus high, session c)'],
  },
  'weather/tiles': {
    plan: ['### S-1 Write [agent]', '### S-2 Review [review]', '### S-3 More [agent]'],
    progress: ['2026-11-10 08:00 S-1 started (opus high, session d)', '2026-11-10 08:40 S-1 finished', '2026-11-10 08:40 S-2 started (opus high, session e)'],
  },
  'hub/sync-maps': {
    plan: ['### S-1 Build [agent]', '### S-2 Review [review]'],
    progress: ['2026-11-10 11:00 S-1 started (opus high, session f)'],
  },
};

// The held job is past its length (E-1); first-sess is the owner's `first` and the guard put it first (E-7); loose-sess
// has no task (E-4); each length kind once (AC-5).
const QUEUE = {
  now: '2026-11-10T12:00:00.000Z',
  first: 'first-sess',
  held: { session: 'kirunak:weather/radar', what: 'S-2: gradle tests', since: '2026-11-10T11:28:00.000Z', pid: 11, expectMinutes: 20, maxMinutes: 40, kind: 'gradle-tests', usualMinutes: 9 },
  waiting: [
    { session: 'first-sess', what: 'tiles: desktop tests', queuedAt: '2026-11-10T11:50:00.000Z', pid: 12, expectMinutes: null, maxMinutes: 50, kind: null, usualMinutes: null },
    { session: 'kirunak:hub/sync-maps', what: 'S-1: build', queuedAt: '2026-11-10T11:51:00.000Z', pid: 13, expectMinutes: null, maxMinutes: 60, kind: 'gradle', usualMinutes: 31.4 },
    { session: 'loose-sess', what: 'niva: master + desktop suites and detekt', queuedAt: '2026-11-10T11:52:00.000Z', pid: 14, expectMinutes: 25, maxMinutes: 45, kind: null, usualMinutes: null },
    { session: 'radar-sess', what: 'radar: one more test', queuedAt: '2026-11-10T11:53:00.000Z', pid: 15, expectMinutes: 10, maxMinutes: 20, kind: null, usualMinutes: 4 },
  ],
};

const EXPECTED = {
  now: '12:00',
  clear: '13:56',
  held: { task: 'radar', id: 'weather/radar', session: 'kirunak:weather/radar', what: 'S-2: gradle tests', length: '20m', left: '12m over', ends: '12:00', step: '2/6 (≈1h)' },
  waiting: [
    { task: 'tiles', id: 'weather/tiles', session: 'first-sess', what: 'tiles: desktop tests', length: '≤50m', ends: '12:50', step: '2/3 (≈40m)' },
    { task: 'sync-maps', id: 'hub/sync-maps', session: 'kirunak:hub/sync-maps', what: 'S-1: build', length: '≈31m', ends: '13:21', step: '1/2 (?)' },
    { task: 'niva: master + desktop suit…', id: null, session: 'loose-sess', what: 'niva: master + desktop suites and detekt', length: '25m', ends: '13:46', step: '–' },
    { task: 'radar', id: 'weather/radar', session: 'radar-sess', what: 'radar: one more test', length: '10m', ends: '13:56', step: '5/6 (≈30m)' },
  ],
};

const GUARD = `import { readFileSync } from 'node:fs';
const q = () => JSON.parse(readFileSync(new URL('./queue.json', import.meta.url), 'utf8'));
const g = { run: async () => ({ exitCode: 0, log: '' }), status: () => ({ held: null, queued: [], estimateMinutes: 0 }), claim() {}, release: () => false, resources: () => [] };
export default { name: 'fixed-guard', version: '1', provides: { resourceGuard: process.env.NO_QUEUE ? g : { ...g, queue: q } } };
`;

async function fixture(queue = QUEUE) {
  const w = await makeWorkspace();
  for (const [id, { plan, progress }] of Object.entries(PLANS)) {
    const [repo, slug] = id.split('/');
    const dir = join(w.root, repo, 'kirunak', 'tasks', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), `---\ntask: ${id}\n---\n\n${plan.join('\n\n')}\n`);
    writeFileSync(join(dir, 'progress.md'), progress.join('\n') + '\n');
  }
  updateSession(w.home, 'first-sess', { task: 'weather/tiles', step: null, since: '2026-11-10T08:00:00.000Z' });
  updateSession(w.home, 'radar-sess', { task: 'weather/radar', step: 'S-14-M1', since: '2026-11-10T10:00:00.000Z' });
  const plugins = join(w.hub, 'kirunak', 'plugins');
  writeFileSync(join(plugins, 'fixed-guard.mjs'), GUARD);
  writeFileSync(join(plugins, 'queue.json'), JSON.stringify(queue));
  const mod = readFileSync(w.modulePath, 'utf8').replace("plugins: ['./plugins/checklist.mjs']", "plugins: ['./plugins/checklist.mjs', './plugins/fixed-guard.mjs']");
  writeFileSync(w.modulePath, mod);
  return w;
}

// A Markdown table's rows back as cells, the header row and the rule left out.
const tableAfter = (out, head) => {
  const lines = out.split('\n');
  const at = lines.indexOf(`**${head}**`);
  if (at < 0) return null;
  const body = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    body.push(l.slice(2, -2).split(' | '));
  }
  return body.slice(2);
};

test('the rows: E-1, E-4, E-5, E-7, AC-5 to AC-8 over a fixed queue, clock and task folders', async () => {
  const { ws } = await fixture();
  assert.deepEqual(rows(QUEUE, { ws }), EXPECTED);
});

test('AC-1 to AC-4: the first line, Now, then Next in the guard order; no percent, status, place or emoji', async () => {
  const { ws } = await fixture();
  const out = text(rows(QUEUE, { ws }));
  assert.equal(out.split('\n')[0], '12:00 now, the queue clear by 13:56');
  assert.deepEqual(tableAfter(out, 'Now'), [['radar', '12m over', '12:00', '2/6 (≈1h)']]);
  assert.deepEqual(out.split('\n')[out.split('\n').indexOf('**Now**') + 2], '| Task | Left | Ends | Step |');
  assert.deepEqual(out.split('\n')[out.split('\n').indexOf('**Next**') + 2], '| Task | Takes | Ends | Step |');
  assert.deepEqual(tableAfter(out, 'Next').map((r) => r[0]), ['tiles', 'sync-maps', 'niva: master + desktop suit…', 'radar']);
  assert.ok(out.indexOf('**Now**') < out.indexOf('**Next**'));
  assert.doesNotMatch(out, /%|status|#\d|\p{Extended_Pictographic}/iu);
  assert.doesNotMatch(out, /≈ means|legend/i);
});

test('E-1: a held job within its length shows what is left with its mark, and the queue ends later', async () => {
  const { ws } = await fixture();
  const q = { ...QUEUE, held: { ...QUEUE.held, expectMinutes: null, usualMinutes: 50 } };
  const r = rows(q, { ws });
  assert.equal(r.held.left, '≈18m');
  assert.equal(r.held.ends, '12:18');
  assert.equal(r.waiting[0].ends, '13:08');
  assert.equal(r.clear, '14:14');
});

test('E-2: a free lock with no one waiting prints one line', async () => {
  const { ws } = await fixture();
  assert.equal(text(rows({ now: QUEUE.now, first: null, held: null, waiting: [] }, { ws })), 'Heavy queue free');
});

test('E-3: a free lock with jobs waiting prints the Next table alone, its jobs from now', async () => {
  const { ws } = await fixture();
  const out = text(rows({ ...QUEUE, held: null }, { ws }));
  assert.equal(tableAfter(out, 'Now'), null);
  assert.deepEqual(tableAfter(out, 'Next').map((r) => r[2]), ['12:50', '13:21', '13:46', '13:56']);
});

test('AC-5: expect bare, else the usual with ≈, else the max with ≤; with none, ? and the ends after it unknown', async () => {
  assert.deepEqual(lengthOf({ expectMinutes: 20, usualMinutes: 30, maxMinutes: 50 }), { minutes: 20, mark: '' });
  assert.deepEqual(lengthOf({ expectMinutes: null, usualMinutes: 30, maxMinutes: 50 }), { minutes: 30, mark: '≈' });
  assert.deepEqual(lengthOf({ expectMinutes: null, usualMinutes: null, maxMinutes: 50 }), { minutes: 50, mark: '≤' });
  const { ws } = await fixture();
  const q = { ...QUEUE, waiting: [{ ...QUEUE.waiting[0], maxMinutes: null }, QUEUE.waiting[2]] };
  const r = rows(q, { ws });
  assert.deepEqual(r.waiting.map((w) => [w.length, w.ends]), [['?', '?'], ['25m', '?']]);
  assert.equal(r.clear, null);
  assert.match(text(r).split('\n')[0], /^12:00 now, the queue clear at a time not known$/);
});

test('times read 40m, 1h, 1h20m', () => {
  assert.deepEqual([span(40), span(60), span(80), span(0.3), span(0)], ['40m', '1h', '1h20m', '1m', '0m']);
});

test('AC-7: a step whose later steps are all finished or the owner\'s brackets 0m; an unknown step is ?', async () => {
  const { ws } = await fixture();
  const q = { now: QUEUE.now, first: null, held: null, waiting: [
    { ...QUEUE.waiting[0], session: 'kirunak:weather/radar', what: 'S-23a: last' },
    { ...QUEUE.waiting[0], session: 'kirunak:weather/radar', what: 'S-9: gone' },
  ] };
  assert.deepEqual(rows(q, { ws }).waiting.map((w) => w.step), ['6/6 (0m)', '?/6 (?)']);
});

test('AC-11: k heavy prints the tables, and --json the same rows', async () => {
  const w = await fixture();
  const plain = k(w.home, ['heavy'], { TZ: 'UTC' });
  assert.equal(plain.status, 0, plain.stderr);
  const json = k(w.home, ['heavy', '--json'], { TZ: 'UTC' });
  assert.equal(json.status, 0, json.stderr);
  const r = JSON.parse(json.stdout);
  assert.deepEqual(r, EXPECTED);
  assert.equal(plain.stdout.trimEnd(), text(r));
  assert.deepEqual(tableAfter(plain.stdout, 'Now'), [[r.held.task, r.held.left, r.held.ends, r.held.step]]);
  assert.deepEqual(tableAfter(plain.stdout, 'Next'), r.waiting.map((x) => [x.task, x.length, x.ends, x.step]));
});

test('a guard without queue() makes k heavy say so in one line and fail', async () => {
  const w = await fixture();
  const r = k(w.home, ['heavy'], { TZ: 'UTC', NO_QUEUE: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /queue\(\)/);
});

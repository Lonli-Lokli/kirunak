import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashBytes } from '../lib/approval.mjs';
import { format, rows } from '../lib/list.mjs';
import { makeWorkspace, reviewsRan } from './helpers.mjs';

const taskText = (id, title, { q = false } = {}) => `---
id: ${id}
title: ${title}
created: 2026-11-03
---

## Goal
${title}. [owner 2026-11-03 Q-1]

## Acceptance criteria
- AC-1 The first thing holds. [owner 2026-11-03 Q-1]
- AC-2 The second thing holds. [owner 2026-11-03 Q-2]

## Edge cases
- E-1 The edge holds too. [owner 2026-11-03 Q-3]

## Out of scope

## Decisions

## Aspects
- offline: in (AC-1) [default 2026-11-03]

## Open questions
${q ? '- Q-1 Which languages come first?' : ''}
`;

// Writes a task into a repo of the temp workspace; options add the files that move its state.
function addTask(repoRoot, id, title, opts = {}) {
  const slug = id.split('/')[1];
  const dir = join(repoRoot, 'kirunak', 'tasks', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.md'), taskText(id, title, opts));
  if (opts.approved) {
    mkdirSync(join(repoRoot, 'kirunak', 'approvals'), { recursive: true });
    const record = { task: id, hash: hashBytes(readFileSync(join(dir, 'task.md'))), approved: opts.approved, by: 'owner', via: 'shell', commit: 'abc1234', history: [] };
    writeFileSync(join(repoRoot, 'kirunak', 'approvals', `${slug}.json`), JSON.stringify(record));
  }
  for (const [name, text] of Object.entries(opts.files || {})) writeFileSync(join(dir, name), text);
  return dir;
}

const REVIEW = `---
task: weather/reviewed-task
head: abc1234
---

| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | test A.one (test/a.test.mjs:3) |
| AC-2 | needs device | not testable on the desktop |
| E-1 | met | file src/a.mjs:4 |

verdict: needs owner (AC-2)
`;

async function fixture() {
  const w = await makeWorkspace();
  addTask(w.weather, 'weather/hourly-chart', 'An hourly chart for today', {
    approved: '2026-11-03T10:00:00Z',
    files: { 'progress.md': '2026-11-03 13:00 S-1 started (sonnet)\n2026-11-03 13:40 S-1 finished\n2026-11-03 14:02 S-2 started (opus, session 7c1)\n' },
  });
  addTask(w.hub, 'hub/sync-notes', 'Sync notes across devices', { approved: '2026-11-04T09:00:00Z' });
  addTask(w.hub, 'hub/release-notes', 'Release notes in every language', { q: true });
  reviewsRan(addTask(w.weather, 'weather/reviewed-task', 'A reviewed task', {
    approved: '2026-11-01T09:00:00Z',
    files: { 'review.md': REVIEW, 'checklist.md': '- [x] AC-1 seen\n- [ ] AC-2 on a phone\n- [ ] E-1 read\n' },
  }));
  addTask(w.weather, 'weather/settings-backup', 'Settings backup', {
    approved: '2026-10-20T09:00:00Z',
    files: { 'done.json': JSON.stringify({ task: 'weather/settings-backup', accepted: '2026-11-01', by: 'owner', via: 'shell', commit: 'def5678' }) },
  });
  addTask(w.weather, 'weather/old-idea', 'An old idea', { files: { 'hold.md': 'waiting for the server, 2026-11-02\n' } });
  writeFileSync(
    join(w.hub, 'kirunak', 'queue.md'),
    '# The queue: one task id per line, in order.\nweather/hourly-chart\nweather/settings-backup\nhub/sync-notes\nweather/no-such-task\n',
  );
  return w;
}

test('queue order first, then the rest by id; done and on hold only with all', async () => {
  const { ws } = await fixture();
  const ids = (await rows(ws)).map((r) => r.id);
  assert.deepEqual(ids, ['weather/hourly-chart', 'hub/sync-notes', 'hub/release-notes', 'weather/offline-forecast', 'weather/reviewed-task']);
  const all = (await rows(ws, { all: true })).map((r) => r.id);
  assert.deepEqual(all, [
    'weather/hourly-chart', 'weather/settings-backup', 'hub/sync-notes',
    'hub/release-notes', 'weather/offline-forecast', 'weather/old-idea', 'weather/reviewed-task',
  ]);
});

test('every --json field, with states and queue places', async () => {
  const { ws } = await fixture();
  const list = await rows(ws, { all: true });
  const by = Object.fromEntries(list.map((r) => [r.id, r]));
  for (const r of list) {
    for (const f of ['id', 'title', 'state', 'queue', 'step', 'lock', 'approved', 'review', 'checklist', 'repo', 'paths', 'ac', 'e']) {
      assert.ok(f in r, `${r.id} has ${f}`);
    }
  }
  const h = by['weather/hourly-chart'];
  assert.equal(h.state, 'in progress');
  assert.equal(h.queue, 1);
  assert.equal(h.step, '2026-11-03 14:02 S-2 started (opus, session 7c1)');
  assert.equal(h.approved, '2026-11-03T10:00:00Z');
  assert.equal(h.lock, null);
  assert.equal(h.review, null);
  assert.equal(h.checklist, null);
  assert.deepEqual(h.ac.map((x) => x.id), ['AC-1', 'AC-2']);
  assert.equal(h.ac[0].text, 'The first thing holds.');
  assert.deepEqual(h.e, [{ id: 'E-1', text: 'The edge holds too.', verdict: null }]);
  assert.deepEqual(Object.keys(h.paths), ['task', 'plan', 'review', 'checklist']);
  assert.equal(by['weather/settings-backup'].state, 'done');
  assert.equal(by['weather/settings-backup'].queue, 2);
  assert.equal(by['hub/sync-notes'].state, 'ready');
  assert.equal(by['hub/sync-notes'].queue, 3);
  assert.equal(by['hub/release-notes'].state, 'draft');
  assert.equal(by['hub/release-notes'].queue, null);
  assert.equal(by['weather/offline-forecast'].state, 'proposed');
  assert.equal(by['weather/old-idea'].state, 'on hold');
  const rv = by['weather/reviewed-task'];
  assert.equal(rv.state, 'awaiting owner');
  assert.deepEqual(rv.review, { file: 'review.md', verdict: 'needs owner (AC-2)' });
  assert.deepEqual(rv.checklist, { open: 2, ticked: 1 });
  assert.deepEqual(rv.ac.map((x) => x.verdict), ['met', 'needs device']);
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list, 'rows are plain JSON');
});

test('two repos in one workspace, and --repo narrows to one', async () => {
  const { ws } = await fixture();
  const repos = new Set((await rows(ws)).map((r) => r.repo));
  assert.deepEqual([...repos].sort(), ['hub', 'weather']);
  const hub = await rows(ws, { repo: 'hub' });
  assert.deepEqual(hub.map((r) => r.id), ['hub/sync-notes', 'hub/release-notes']);
  assert.equal(hub[0].queue, 3, 'the place stays the place in the whole queue');
  await assert.rejects(rows(ws, { repo: 'nowhere' }), /unknown repo nowhere/);
});

test('the lock comes from the default guard when it is held', async () => {
  const { ws, home } = await fixture();
  mkdirSync(join(home, 'guard', 'lock'), { recursive: true });
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 's1', what: 'weather unit tests', pid: 1, since: '2026-11-03T14:00:00Z' }));
  const list = await rows(ws);
  assert.equal(list[0].lock, 'weather unit tests');
  assert.match(format(list).split('\n')[0], /lock: weather unit tests/);
});

test('format: one line per row, places right-aligned, columns padded', async () => {
  const { ws } = await fixture();
  const lines = format(await rows(ws)).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^ 1  in progress\s+weather\/hourly-chart\s+An hourly chart for today\s+S-2 started \(opus, session 7c1\)$/);
  assert.match(lines[1], /^ 3  ready\s+hub\/sync-notes/);
  assert.match(lines[2], /^ {4}draft\s+hub\/release-notes/);
  assert.match(lines[4], /verdict: needs owner \(AC-2\), checklist 2 open$/);
  const col = (l) => l.indexOf('weather/') >= 0 ? l.indexOf('weather/') : l.indexOf('hub/');
  assert.equal(new Set(lines.map(col)).size, 1, 'the id column lines up');
  assert.equal(format([]), 'no tasks');
});

test('runs no git command and stays under 1 s with 30 more tasks', async () => {
  const { ws, weather } = await fixture();
  for (let i = 0; i < 30; i++) addTask(weather, `weather/extra-${i}`, `Extra task ${i}`, { approved: i % 2 ? '2026-11-05T09:00:00Z' : undefined });
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    const t0 = performance.now();
    const list = await rows(ws);
    const ms = performance.now() - t0;
    assert.equal(list.length, 35);
    assert.ok(ms < 1000, `rows took ${ms.toFixed(0)} ms`);
  } finally {
    process.env.PATH = path;
  }
});

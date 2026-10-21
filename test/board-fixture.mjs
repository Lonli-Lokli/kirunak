import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes } from '../lib/approval.mjs';
import { makeWorkspace } from './helpers.mjs';

// The board's fixture (test/board.test.mjs, test/board-md.test.mjs): four tasks beside the workspace's own, one
// reviewed, one done this week, one done long ago, one queued and started.
export function addTask(repoRoot, id, title, { approved, files = {} } = {}) {
  const slug = id.split('/')[1];
  const dir = join(repoRoot, 'kirunak', 'tasks', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.md'), `---
id: ${id}
title: ${title}
created: 2026-11-03
---

## Goal
${title}. [owner 2026-11-03 Q-1]

## Acceptance criteria
- AC-1 The chart shows one point per hour. [owner 2026-11-03 Q-1]
- AC-2 Points read <below> & above zero. [owner 2026-11-03 Q-2]

## Edge cases
- E-1 A missing hour leaves a gap. [owner 2026-11-03 Q-3]

## Out of scope

## Decisions

## Aspects

## Open questions
`);
  if (approved) {
    mkdirSync(join(repoRoot, 'kirunak', 'approvals'), { recursive: true });
    const record = { task: id, hash: hashBytes(readFileSync(join(dir, 'task.md'))), approved, by: 'owner', via: 'shell', commit: 'abc1234', history: [] };
    writeFileSync(join(repoRoot, 'kirunak', 'approvals', `${slug}.json`), JSON.stringify(record));
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const REVIEW = `| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | test A.one (test/a.test.mjs:3) |
| AC-2 | not met | file src/a.mjs:9: below zero is drawn above |

verdict: not met (AC-2)
`;

export async function fixture() {
  const w = await makeWorkspace();
  addTask(w.weather, 'weather/hourly-chart', 'An hourly chart <for> today', {
    approved: '2026-11-03T10:00:00Z',
    files: { 'progress.md': '2026-11-03 14:02 S-2 started (opus, session 7c1)\n' },
  });
  addTask(w.hub, 'hub/reviewed', 'A reviewed task', { approved: '2026-11-01T09:00:00Z', files: { 'review-2.md': REVIEW } });
  addTask(w.weather, 'weather/recent', 'Done this week', { approved: '2026-11-01T09:00:00Z', files: { 'done.json': '{"accepted":"2026-11-06"}' } });
  addTask(w.weather, 'weather/long-ago', 'Done long ago', { approved: '2026-09-01T09:00:00Z', files: { 'done.json': '{"accepted":"2026-09-02"}' } });
  writeFileSync(join(w.hub, 'kirunak', 'queue.md'), '# queue\nweather/hourly-chart\n');
  return w;
}

// Two approved tasks with no step started: one in the queue after the chart (queued), one out of it (parked).
export function queuedAndParked(w) {
  addTask(w.weather, 'weather/next-up', 'Next in line', { approved: '2026-11-04T09:00:00Z' });
  addTask(w.hub, 'hub/later', 'Not yet', { approved: '2026-11-04T10:00:00Z' });
  writeFileSync(join(w.hub, 'kirunak', 'queue.md'), '# queue\nweather/hourly-chart\nweather/next-up\n');
}

export const NOW = new Date('2026-11-07T12:00:00Z');

// A session record naming the chart (k start), a running step naming the reviewed task, and an old session naming a
// task done this week, which is no longer worked on.
export function sessionsAt(w) {
  mkdirSync(join(w.home, 'sessions'), { recursive: true });
  mkdirSync(join(w.home, 'running'), { recursive: true });
  writeFileSync(join(w.home, 'sessions', 's1.json'), JSON.stringify({ task: 'weather/hourly-chart', step: null, since: '2026-11-07T11:00:00Z', context: 90000 }));
  writeFileSync(join(w.home, 'sessions', 's9.json'), JSON.stringify({ task: 'weather/recent', since: '2026-11-05T09:00:00Z' }));
  writeFileSync(join(w.home, 'sessions', 's3.json'), JSON.stringify({ context: 1000 }));
  writeFileSync(join(w.home, 'running', '7.json'), JSON.stringify({ task: 'hub/reviewed', step: 'S-3', session: 's2', since: '2026-11-07T11:40:00Z' }));
}

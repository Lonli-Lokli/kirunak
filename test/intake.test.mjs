import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { answer, aspects, question, start } from '../lib/intake.mjs';
import { checkTaskDir } from '../lib/state.mjs';
import { FIXTURES, makeWorkspace, sh } from './helpers.mjs';

for (const k of Object.keys(process.env)) if (k.startsWith('KIRUNAK_') && k !== 'KIRUNAK_HOME') delete process.env[k];

const ID = 'weather/offline-forecast';
const ASPECTS = ['platforms', 'large-text', 'offline'];
const NOV2 = new Date(2026, 10, 2, 19, 40, 0);
const TITLE = 'The last forecast stays readable offline';
const dirOf = (weather) => join(weather, 'kirunak/tasks/offline-forecast');

const SKELETON = `---
id: weather/offline-forecast
title: The last forecast stays readable offline
created: 2026-11-02
---

## Goal

## Acceptance criteria

## Edge cases

## Out of scope

## Decisions

## Aspects
- platforms: ? [open]
- large-text: ? [open]
- offline: ? [open]

## Open questions
`;

// Every file under a folder with the hash of its bytes, to show nothing there changed.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function commitAt(dir, message, when) {
  const date = when.toISOString();
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

test('start writes the skeleton with every aspect ? [open], an empty intake.md, and commits nothing', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  const r = await start({ ws, id: ID, title: TITLE, now: NOV2 });
  assert.deepEqual(r, { dir: ws.repos[0].root + '/kirunak/tasks/offline-forecast', aspects: 3 });
  const text = readFileSync(join(dirOf(weather), 'task.md'), 'utf8');
  assert.equal(text, SKELETON);
  assert.ok(!text.includes('\r') && text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.equal(readFileSync(join(dirOf(weather), 'intake.md'), 'utf8'), `# Intake: ${ID}\n`);
  assert.equal(existsSync(join(dirOf(weather), 'notes.md')), false);
  const { problems } = checkTaskDir(dirOf(weather), ASPECTS, ID);
  for (const a of ASPECTS) assert.ok(problems.some((p) => p.problem === `aspect ${a} is open: rule it in, out or n/a`));
  assert.ok(problems.some((p) => p.problem === 'Goal is empty'));
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '?? kirunak/');
});

test('start refuses an existing task folder and a workspace with no checklist', async () => {
  const { ws } = await makeWorkspace();
  await assert.rejects(start({ ws, id: ID, title: TITLE, now: NOV2 }), /exists already/);
  const bare = { ...ws, seams: { ...ws.seams, checklist: [] } };
  await assert.rejects(start({ ws: bare, id: 'weather/new-task', now: NOV2 }), /no checklist plugin is loaded/);
});

test('start --from writes notes.md with the headings, the unchecked items and what may have landed, touching nothing under openspec/', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  const day = 24 * 3600 * 1000;
  const t0 = Date.now();
  mkdirSync(join(weather, 'src'));
  writeFileSync(join(weather, 'src/cache.mjs'), 'export {};\n');
  commitAt(weather, 'A cache stub before the change', new Date(t0 + day));

  const change = join(weather, 'openspec/changes/add-offline-mode');
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, 'proposal.md'), [
    '# Add offline mode', '', '## Why', 'Riders lose signal in tunnels.', '', '## What changes',
    '- The cache in `src/cache.mjs` keeps the last forecast.', '- See docs/offline.md, and https://example.com/x.md.', '',
  ].join('\n'));
  writeFileSync(join(change, 'tasks.md'), [
    '## 1. Cache', '- [ ] 1.1 Cache the last forecast on disk', '- [x] 1.0 Read the provider docs', '',
    '## 2. Screens', '- [ ] 1.2 Show the fetch time on the forecast screen', '  - [ ] 1.2.1 In the reader\'s own format', '',
    '```', '# not a heading', '- [ ] not an item', '```', '',
  ].join('\n'));
  writeFileSync(join(change, 'design.md'), '# Design\n\n### Storage\nOne file per day.\n');
  commitAt(weather, 'Propose offline mode', new Date(t0 + 2 * day));
  writeFileSync(join(weather, 'src/cache.mjs'), 'export const cache = new Map();\n');
  commitAt(weather, 'Cache the last forecast', new Date(t0 + 3 * day));

  const before = snapshot(join(weather, 'openspec'));
  const r = await start({ ws, id: ID, from: 'openspec/changes/add-offline-mode/', title: TITLE, now: NOV2 });
  assert.equal(r.aspects, 3);
  assert.deepEqual(snapshot(join(weather, 'openspec')), before);
  assert.equal(sh(weather, 'git', ['status', '--porcelain', '--', 'openspec']).trim(), '');

  const task = readFileSync(join(dirOf(weather), 'task.md'), 'utf8');
  assert.equal(task, SKELETON.replace('created: 2026-11-02\n', 'created: 2026-11-02\nfrom: openspec/changes/add-offline-mode\n'));

  const notes = readFileSync(join(dirOf(weather), 'notes.md'), 'utf8');
  const sha = sh(weather, 'git', ['log', '-1', '--format=%h']).trim();
  const expected = [
    `# Notes: ${ID}`,
    '',
    'Background from openspec/changes/add-offline-mode, read 2026-11-02. Background only: every line is asked again in the intake.',
    '',
    '## proposal.md',
    'Headings:',
    '- Add offline mode',
    '  - Why',
    '  - What changes',
    '',
    '## tasks.md',
    'Headings:',
    '- 1. Cache',
    '- 2. Screens',
    'Unchecked:',
    '- [ ] 1.1 Cache the last forecast on disk',
    '- [ ] 1.2 Show the fetch time on the forecast screen',
    "  - [ ] 1.2.1 In the reader's own format",
    '',
    '## design.md',
    'Headings:',
    '- Design',
    '    - Storage',
    '',
    '## Possibly landed',
  ];
  assert.equal(notes.split('\n').slice(0, expected.length).join('\n'), expected.join('\n'));
  const landed = notes.split('## Possibly landed\n')[1];
  assert.match(landed, /that touch files it names \(docs\/offline\.md, src\/cache\.mjs\):\n/);
  assert.ok(landed.includes(`- ${sha} Cache the last forecast\n`));
  assert.ok(!landed.includes('A cache stub before the change'));
  assert.ok(!landed.includes('Propose offline mode'));
});

test('start --from refuses a path outside the repo or missing, and writes nothing', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  await assert.rejects(start({ ws, id: ID, from: '../hub', now: NOV2 }), /is not inside the repo/);
  await assert.rejects(start({ ws, id: ID, from: 'openspec/changes/none', now: NOV2 }), /does not exist/);
  mkdirSync(join(weather, 'openspec/changes/empty'), { recursive: true });
  await assert.rejects(start({ ws, id: ID, from: 'openspec/changes/empty', now: NOV2 }), /has none of proposal.md, tasks.md, design.md/);
  assert.equal(existsSync(dirOf(weather)), false);
});

test('aspects lists every loaded aspect with its question, edge cases, sources and the plugin guess', async () => {
  const { ws } = await makeWorkspace();
  const list = await aspects(ws, ID);
  assert.deepEqual(list.map((a) => [a.id, a.applies]), [['platforms', true], ['large-text', true], ['offline', null]]);
  assert.deepEqual(list[1], {
    id: 'large-text',
    title: 'The largest system text size',
    question: 'Does this change touch a screen that must hold at the largest text size?',
    edgeCases: ['A row that clips', 'A button under the touch-target minimum'],
    sources: ['docs/accessibility.md'],
    applies: true,
  });
  const fresh = await makeWorkspace({ finished: false });
  await start({ ws: fresh.ws, id: ID, title: TITLE, now: NOV2 });
  assert.equal((await aspects(fresh.ws, ID))[1].applies, false, 'the skeleton names no screen');
  await assert.rejects(aspects(fresh.ws, 'weather/none'), /unknown task/);
});

test('question and answer append numbered entries in the log format and never rewrite', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  await start({ ws, id: ID, title: TITLE, now: NOV2 });
  const log = join(dirOf(weather), 'intake.md');
  const steps = [
    () => question(ws, ID, 'goal', 'Is the goal that the app shows the last forecast it fetched, and its age, with no network?', NOV2),
    () => answer(ws, ID, 'Q-1', 'Yes. And it has to say how old it is.', '→ Goal', NOV2),
    () => question(ws, ID, 'acceptance', "Should the fetch time follow the phone's own time format?", NOV2),
    () => answer(ws, ID, 'Q-2', "Yes, the reader's own format.", '→ AC-2', NOV2),
  ];
  const results = [];
  let prev = readFileSync(log, 'utf8');
  for (const step of steps) {
    results.push(step());
    const now = readFileSync(log, 'utf8');
    assert.ok(now.startsWith(prev) && now.length > prev.length, 'an append, never a rewrite');
    prev = now;
  }
  assert.equal(results[0], 'Q-1');
  assert.equal(results[2], 'Q-2');
  // The same entries as the invented finished task's log, byte for byte.
  const fixture = readFileSync(join(FIXTURES, 'workspace/weather/kirunak/tasks/offline-forecast/intake.md'), 'utf8');
  assert.equal(prev, fixture.slice(0, fixture.indexOf('\n### Q-3')));
});

test('answer quotes every line verbatim, refuses an unknown question, and a changed mind is a new entry', async () => {
  const { ws, weather } = await makeWorkspace();
  const log = join(dirOf(weather), 'intake.md');
  assert.equal(question(ws, ID, 'offline', 'Alerts while offline?', NOV2), 'Q-9');
  assert.throws(() => answer(ws, ID, 'Q-10', 'Out.', '→ O-2', NOV2), /has no Q-10 in intake.md/);
  assert.throws(() => answer(ws, ID, 'Q-9', '  ', '→ O-2', NOV2), /verbatim/);
  assert.throws(() => answer(ws, ID, 'Q-9', 'Out.', '', NOV2), /ruling/);
  const before = readFileSync(log, 'utf8');
  answer(ws, ID, 'Q-9', 'Out for now.\r\n\r\nAlerts have their own task.', '→ O-2', NOV2);
  answer(ws, ID, 9, 'Actually, in.', '→ AC-4', new Date(2026, 10, 3, 8, 0, 0));
  assert.equal(readFileSync(log, 'utf8'), before + [
    '', '#### Q-9 answer, 2026-11-02', '> Out for now.', '>', '> Alerts have their own task.', '', 'Ruling: → O-2',
    '', '#### Q-9 answer, 2026-11-03', '> Actually, in.', '', 'Ruling: → AC-4', '',
  ].join('\n'));
  assert.throws(() => question(ws, 'weather/none', 'goal', 'Why?', NOV2), /has no intake.md/);
});

test('answer --ruling yields the Q-n that a task line tag points at', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  await start({ ws, id: ID, title: TITLE, now: NOV2 });
  const q = question(ws, ID, 'goal', 'Is the goal the last forecast, offline?', NOV2);
  const r = answer(ws, ID, q, 'Yes.', '→ Goal', NOV2);
  assert.deepEqual(r, { q: 'Q-1', date: '2026-11-02', tag: '[owner 2026-11-02 Q-1]' });
  const taskPath = join(dirOf(weather), 'task.md');
  writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('## Goal\n', `## Goal\nThe last forecast stays readable offline. ${r.tag}\n`));
  const pointsAt = (pr) => pr.problems.filter((p) => /is not an entry in intake\.md/.test(p.problem));
  assert.deepEqual(pointsAt(checkTaskDir(dirOf(weather), ASPECTS, ID)), []);
  writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace(r.tag, '[owner 2026-11-02 Q-2]'));
  assert.equal(pointsAt(checkTaskDir(dirOf(weather), ASPECTS, ID)).length, 1);
});

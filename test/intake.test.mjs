import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve } from '../lib/approval.mjs';
import { list as listDrafts } from '../lib/drafts.mjs';
import { answer, aspects, question, start } from '../lib/intake.mjs';
import { checkTaskDir } from '../lib/state.mjs';
import { FIXTURES, gitCommitAll, k, makeWorkspace, sh } from './helpers.mjs';

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

// A draft of this task (kirunak-drafts AC-5's shape), as `k draft new` and the session that filled it leave it.
const DRAFT = `---
id: weather/offline-forecast
title: The last forecast stays readable offline
written: 2026-10-22
---

## Who raised it
> riders lose signal in tunnels
owner, 2026-10-22, session 5f0c2a

## Why
The forecast is blank in a tunnel.

## What was found
- the forecast is fetched on every open [file src/Forecast.kt]

## Questions
1. How old may the kept forecast be?
2. Should the screen say when it was fetched?
`;
const DRAFT_REL = 'kirunak/drafts/offline-forecast.md';

function writeDraft(weather, text = DRAFT, rel = DRAFT_REL) {
  mkdirSync(join(weather, 'kirunak/drafts'), { recursive: true });
  writeFileSync(join(weather, rel), text);
}

test('start --from a draft moves it by git mv into the task folder as draft.md, staged, as background; k drafts lists it no more and git keeps its history (kirunak-drafts AC-6)', async () => {
  const { ws, home, weather } = await makeWorkspace({ finished: false });
  writeDraft(weather);
  gitCommitAll(weather, 'kirunak: a draft, weather/offline-forecast');
  const before = sh(weather, 'git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(listDrafts(ws).map((d) => d.id), [ID]);

  const r = await start({ ws, id: ID, from: DRAFT_REL, now: NOV2 });
  assert.deepEqual(r, { dir: join(ws.repos[0].root, 'kirunak/tasks/offline-forecast'), aspects: 3, draft: 'kirunak/tasks/offline-forecast/draft.md', staged: true });
  assert.equal(readFileSync(join(dirOf(weather), 'draft.md'), 'utf8'), DRAFT);
  assert.equal(existsSync(join(weather, DRAFT_REL)), false);
  // The title is the draft's; the front matter names the draft as where the task came from: background, not a source.
  assert.equal(readFileSync(join(dirOf(weather), 'task.md'), 'utf8'),
    SKELETON.replace('created: 2026-11-02\n', 'created: 2026-11-02\nfrom: kirunak/tasks/offline-forecast/draft.md\n'));
  assert.equal(readFileSync(join(dirOf(weather), 'notes.md'), 'utf8'), [
    `# Notes: ${ID}`,
    '',
    'Background from the draft kirunak/drafts/offline-forecast.md, written 2026-10-22, now kirunak/tasks/offline-forecast/draft.md, ' +
      'read 2026-11-02. Background only: nothing in a draft is a ruling, and every line is asked again in the intake, ' +
      'starting from its questions.',
    '',
    '## draft.md',
    'Headings:',
    '- Who raised it',
    '- Why',
    '- What was found',
    '- Questions',
    'Questions:',
    '1. How old may the kept forecast be?',
    '2. Should the screen say when it was fetched?',
    '',
  ].join('\n'));

  // Staged, not committed: the move is a rename in the index, the intake's own files are untracked.
  assert.equal(sh(weather, 'git', ['rev-parse', 'HEAD']).trim(), before);
  assert.deepEqual(sh(weather, 'git', ['status', '--porcelain']).trim().split('\n').sort(), [
    '?? kirunak/tasks/offline-forecast/intake.md',
    '?? kirunak/tasks/offline-forecast/notes.md',
    '?? kirunak/tasks/offline-forecast/task.md',
    'R  kirunak/drafts/offline-forecast.md -> kirunak/tasks/offline-forecast/draft.md',
  ]);
  assert.deepEqual(listDrafts(ws), []);
  const out = k(home, ['drafts']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'no drafts');

  gitCommitAll(weather, 'kirunak: weather/offline-forecast intake');
  const history = sh(weather, 'git', ['log', '--follow', '--format=%s', '--', 'kirunak/tasks/offline-forecast/draft.md']);
  assert.deepEqual(history.trim().split('\n'), ['kirunak: weather/offline-forecast intake', 'kirunak: a draft, weather/offline-forecast']);
});

test('k intake start --from a draft never committed renames it, and says where it is now', async () => {
  const { home, weather } = await makeWorkspace({ finished: false });
  writeDraft(weather);
  const r = k(home, ['intake', 'start', ID, '--from', DRAFT_REL, '--title', 'Offline forecast']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started weather\/offline-forecast: .*kirunak\/tasks\/offline-forecast \(3 aspects open\); the draft is now kirunak\/tasks\/offline-forecast\/draft\.md: commit it with the intake/);
  assert.equal(readFileSync(join(dirOf(weather), 'draft.md'), 'utf8'), DRAFT);
  assert.equal(existsSync(join(weather, DRAFT_REL)), false);
  assert.match(readFileSync(join(dirOf(weather), 'task.md'), 'utf8'), /^title: Offline forecast$/m);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '?? kirunak/');
});

test('start --from a draft refuses another id\'s draft naming both, and a draft that is gone by name, and writes nothing', async () => {
  const { ws, weather } = await makeWorkspace({ finished: false });
  writeDraft(weather, DRAFT.replace(/offline-forecast/g, 'wind-alerts'), 'kirunak/drafts/wind-alerts.md');
  await assert.rejects(start({ ws, id: ID, from: 'kirunak/drafts/wind-alerts.md', now: NOV2 }),
    /--from kirunak\/drafts\/wind-alerts\.md is the draft weather\/wind-alerts, not weather\/offline-forecast/);
  writeDraft(weather, DRAFT.replace('id: weather/offline-forecast', 'id: weather/other'));
  await assert.rejects(start({ ws, id: ID, from: DRAFT_REL, now: NOV2 }),
    /is the draft weather\/other, not weather\/offline-forecast: its front matter says id: weather\/other/);
  assert.equal(existsSync(dirOf(weather)), false);

  sh(weather, 'rm', ['-f', join(weather, DRAFT_REL)]);
  await assert.rejects(start({ ws, id: ID, from: DRAFT_REL, now: NOV2 }),
    /the draft weather\/offline-forecast is gone: kirunak\/drafts\/offline-forecast\.md does not exist .*\(dropped, or its intake started elsewhere\); k drafts lists the drafts that wait/);
  assert.equal(existsSync(dirOf(weather)), false);

  writeDraft(weather);
  await start({ ws, id: ID, from: DRAFT_REL, now: NOV2 });
  await assert.rejects(start({ ws, id: ID, from: DRAFT_REL, now: NOV2 }),
    /the draft weather\/offline-forecast is gone: .*\(its intake started already, and it is kirunak\/tasks\/offline-forecast\/draft\.md\)/);
});

// kirunak-spikes: an intake from a bug, a draft whose front matter names the accepted task it was found in.
const BUG_REL = 'kirunak/drafts/stale-tiles.md';
const bugDir = (repo) => join(repo, 'kirunak/tasks/stale-tiles');
const FINISHED = readFileSync(join(FIXTURES, 'workspace/weather/kirunak/tasks/offline-forecast/task.md'), 'utf8');

// DRAFT as the bug `id` of `task`, with a fix written already.
const bugDraft = (id, task = ID) => DRAFT.replace(`id: ${ID}`, `id: ${id}`)
  .replace(`title: ${TITLE}`, 'title: The kept forecast is stale after a restart')
  .replace('written: 2026-10-22\n', `written: 2026-10-22\nbug-of: ${task}\n`)
  .replace('## Questions', '## Fix written\n- the cache key [commit 1a2b3c4]\n\n## Questions');

// The invented workspace with weather/offline-forecast accepted: approved, and its done.json committed as k accept does.
async function acceptedWorkspace() {
  const w = await makeWorkspace();
  await approve({ ws: w.ws, id: ID });
  writeFileSync(join(dirOf(w.weather), 'done.json'), '{"accepted":"2026-10-20"}\n');
  gitCommitAll(w.weather, 'accept');
  return w;
}

// The lines of a task.md that start with each prefix, as they stand there.
const linesOf = (text, ...prefixes) => prefixes.map((s) => {
  const line = text.split('\n').find((l) => l.startsWith(`- ${s}`));
  assert.ok(line, `no line - ${s}`);
  return line;
});

// notes.md of the draft `id`, a bug of weather/offline-forecast when `lines` (its lines in notes.md) are given.
const notesOf = (id, lines = null) => [
  `# Notes: ${id}`,
  '',
  'Background from the draft kirunak/drafts/stale-tiles.md, written 2026-10-22, now kirunak/tasks/stale-tiles/draft.md, ' +
    'read 2026-11-02. Background only: nothing in a draft is a ruling, and every line is asked again in the intake, ' +
    'starting from its questions.',
  '',
  ...(lines ? [
    `The draft is a bug of ${ID}, a task accepted already.`,
    '',
    `## The lines of ${ID}, for the intake's one proposal (background only)`,
    'As they stand in kirunak/tasks/offline-forecast/task.md, in weather. After the goal, the intake proposes them ' +
      'together for one yes or no; on a no, it asks each one alone, like any line of a draft.',
    ...lines,
    '',
  ] : []),
  '## draft.md',
  'Headings:',
  '- Who raised it',
  '- Why',
  '- What was found',
  ...(lines ? ['- Fix written'] : []),
  '- Questions',
  'Questions:',
  '1. How old may the kept forecast be?',
  '2. Should the screen say when it was fetched?',
  '',
].join('\n');

test('start --from a bug in another repo than its task: notes.md says whose bug it is and holds that task\'s edge cases, out of scope and aspects as they stand, for one proposal; the task stays as it was (kirunak-spikes AC-1, E-3)', async () => {
  const w = await acceptedWorkspace();
  const BUG = 'hub/stale-tiles';
  writeDraft(w.hub, bugDraft(BUG), BUG_REL);
  gitCommitAll(w.hub, `kirunak: a bug, ${BUG}`);
  const finished = snapshot(dirOf(w.weather));

  const r = await start({ ws: w.ws, id: BUG, from: BUG_REL, now: NOV2 });
  assert.deepEqual(r, { dir: bugDir(w.ws.repos[1].root), aspects: 3, draft: 'kirunak/tasks/stale-tiles/draft.md', staged: true });
  assert.equal(readFileSync(join(bugDir(w.hub), 'notes.md'), 'utf8'), notesOf(BUG, [
    'Edge cases:',
    ...linesOf(FINISHED, 'E-1 '),
    'Out of scope:',
    ...linesOf(FINISHED, 'O-1 '),
    'Aspects:',
    ...linesOf(FINISHED, 'platforms:', 'large-text:', 'offline:'),
  ]));
  assert.equal(readFileSync(join(bugDir(w.hub), 'draft.md'), 'utf8'), bugDraft(BUG));
  assert.deepEqual(sh(w.hub, 'git', ['status', '--porcelain']).trim().split('\n').sort(), [
    '?? kirunak/tasks/stale-tiles/intake.md',
    '?? kirunak/tasks/stale-tiles/notes.md',
    '?? kirunak/tasks/stale-tiles/task.md',
    'R  kirunak/drafts/stale-tiles.md -> kirunak/tasks/stale-tiles/draft.md',
  ]);
  // The finished task is only read: its folder byte for byte as it was, its repo with nothing to commit.
  assert.deepEqual(snapshot(dirOf(w.weather)), finished);
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain']), '');

  // A plain draft's notes.md has none of it.
  const PLAIN = 'hub/plain-tiles';
  writeDraft(w.hub, DRAFT.replace(`id: ${ID}`, `id: ${PLAIN}`), 'kirunak/drafts/plain-tiles.md');
  await start({ ws: w.ws, id: PLAIN, from: 'kirunak/drafts/plain-tiles.md', now: NOV2 });
  assert.equal(readFileSync(join(w.hub, 'kirunak/tasks/plain-tiles/notes.md'), 'utf8'),
    notesOf(PLAIN).replace(/stale-tiles/g, 'plain-tiles'));
});

test('start --from a bug in its task\'s repo takes the task\'s lines as they stand now, an amendment\'s included, and says when a section has none (kirunak-spikes AC-1)', async () => {
  const w = await acceptedWorkspace();
  const BUG = 'weather/stale-tiles';
  // task.md as an applied amendment leaves it: E-1 replaced, E-2 added, O-1 removed.
  const amended = FINISHED
    .replace(/^- E-1 .*$/m, '- E-1 A forecast older than a day shows its age in words. [owner 2026-11-04 Q-9]\n' +
      '- E-2 A forecast older than a week is not shown. [owner 2026-11-04 Q-9]')
    .replace(/^- O-1 .*\n/m, '');
  writeFileSync(join(dirOf(w.weather), 'task.md'), amended);
  writeDraft(w.weather, bugDraft(BUG), BUG_REL);
  gitCommitAll(w.weather, 'an amendment and a bug');

  await start({ ws: w.ws, id: BUG, from: BUG_REL, now: NOV2 });
  assert.equal(readFileSync(join(bugDir(w.weather), 'notes.md'), 'utf8'), notesOf(BUG, [
    'Edge cases:',
    ...linesOf(amended, 'E-1 ', 'E-2 '),
    'Out of scope: none',
    'Aspects:',
    ...linesOf(amended, 'platforms:', 'large-text:', 'offline:'),
  ]));
  assert.equal(readFileSync(join(dirOf(w.weather), 'task.md'), 'utf8'), amended);
});

test('start --from a bug whose task is gone or not accepted is refused, the draft not moved and nothing written (kirunak-spikes AC-1)', async () => {
  const w = await makeWorkspace();
  const BUG = 'hub/stale-tiles';
  let text;
  const putBug = (task) => {
    text = bugDraft(BUG, task);
    writeDraft(w.hub, text, BUG_REL);
    sh(w.hub, 'git', ['add', '-A']);
    sh(w.hub, 'git', ['commit', '-q', '--allow-empty', '-m', `kirunak: a bug of ${task}`]);
  };
  const untouched = () => {
    assert.equal(readFileSync(join(w.hub, BUG_REL), 'utf8'), text);
    assert.equal(existsSync(bugDir(w.hub)), false);
    assert.equal(sh(w.hub, 'git', ['status', '--porcelain']), '');
  };
  const refused = (why) => `the bug ${BUG} cannot start its intake: ${why}`;

  // Proposed, then approved and queued: not accepted.
  putBug(ID);
  const open = `${ID} is not accepted yet: a bug found while a task is open goes into that task, through its review or ` +
    `an amendment (k amend new ${ID} --title "...")`;
  await assert.rejects(start({ ws: w.ws, id: BUG, from: BUG_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(open));
  untouched();
  await approve({ ws: w.ws, id: ID });
  await assert.rejects(start({ ws: w.ws, id: BUG, from: BUG_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(open));
  untouched();
  const cli = k(w.home, ['intake', 'start', BUG, '--from', BUG_REL]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /the bug hub\/stale-tiles cannot start its intake: weather\/offline-forecast is not accepted yet/);
  untouched();

  // Gone: its folder removed, a task never written, a repo the workspace does not have.
  rmSync(dirOf(w.weather), { recursive: true });
  const gone = (task) => `unknown task ${task}: ${join(w.ws.repos[0].root, 'kirunak/tasks', task.split('/')[1], 'task.md')} ` +
    'does not exist; a bug names the accepted task it was found in';
  for (const [task, why] of [[ID, gone(ID)], ['weather/never-was', gone('weather/never-was')],
    ['radio/tiles', 'unknown repo radio: the workspace lists weather, hub']]) {
    putBug(task);
    await assert.rejects(start({ ws: w.ws, id: BUG, from: BUG_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(why));
    untouched();
  }
});

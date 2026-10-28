import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve, localDate } from '../lib/approval.mjs';
import { list as listBugs, reviewLockPath } from '../lib/bugs.mjs';
import { list as listDrafts } from '../lib/drafts.mjs';
import { answer, aspects, question, start } from '../lib/intake.mjs';
import { checkTaskDir } from '../lib/state.mjs';
import { FIXTURES, KIRUNAK, gitCommitAll, k, makeWorkspace, sh } from './helpers.mjs';

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

test('start --from a draft naming bug-of is refused, naming k bug from, the draft not moved and nothing written (gulnya/kirunak-bugs AC-1)', async () => {
  const { ws, home, weather } = await makeWorkspace({ finished: false });
  const text = DRAFT.replace('written: 2026-10-22\n', 'written: 2026-10-22\nbug-of: hub/older-task\n');
  writeDraft(weather, text);
  gitCommitAll(weather, 'kirunak: a bug left among the drafts');
  const why = `--from ${DRAFT_REL} is a bug, not a draft: it names bug-of. \`k bug from ${ID} --quad-damage yes|no\` moves it into kirunak/bugs/, ` +
    `then k intake start ${ID} --from kirunak/bugs/offline-forecast.md`;
  await assert.rejects(start({ ws, id: ID, from: DRAFT_REL, now: NOV2 }), (e) => e.code === 1 && e.message === why);
  const cli = k(home, ['intake', 'start', ID, '--from', DRAFT_REL]);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /is a bug, not a draft: it names bug-of\. `k bug from weather\/offline-forecast --quad-damage yes\|no` moves it/);
  assert.equal(readFileSync(join(weather, DRAFT_REL), 'utf8'), text);
  assert.equal(existsSync(dirOf(weather)), false);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']), '');
});

// gulnya/kirunak-bugs AC-8, Start fix: an intake from a bug, kirunak/bugs/<slug>.md, as k bug new and the agent that
// groomed it leave it: two questions with a proposed answer, one open, and the last proposed again.
const BUG = `---
id: weather/offline-forecast
title: The kept forecast is stale after a restart
written: 2026-10-22
---

## Who raised it
> the forecast is a day old after a restart
owner, 2026-10-22, session 5f0c2a

## Why
After a restart the app shows yesterday's forecast as today's.

## What was found
- the cache key leaves out the date [file src/Cache.kt]

## Fix written
- the cache key holds the date [commit 1a2b3c4]

## Questions
1. The goal: "after a restart the app shows today's forecast, or none". Keep it?
   Proposed: yes, as written.
2. The criteria:
   AC-1 a forecast kept from yesterday is never shown as today's after a restart.
   Proposed: this one.
3. Should the screen say when the forecast was fetched?
4. The aspects: platforms and large text n/a, no screen changes; offline in (AC-1).
   Proposed: as written.
`;
const BUG_REL = 'kirunak/bugs/offline-forecast.md';
const BUG_LOG = '# Intake: weather/offline-forecast\n\n### Q-1 (2026-10-21) goal\nWhy is the forecast stale?\n';

function writeBug(repo, text = BUG, rel = BUG_REL) {
  mkdirSync(join(repo, 'kirunak/bugs'), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

// notes.md of the bug `id` at `rel`, a bug of weather/offline-forecast when `lines` (its lines in notes.md) are given;
// `records` the files of its folder.
const bugNotesOf = (id, { rel = BUG_REL, records = null, lines = null, read = '2026-11-02' } = {}) => {
  const slug = rel.split('/').pop().replace(/\.md$/, '');
  return [
    `# Notes: ${id}`,
    '',
    `Background from the bug ${rel}, written 2026-10-22, now kirunak/tasks/${slug}/bug.md, read ${read}. ` +
      'Background only: nothing in a bug is a ruling, and every line is asked again in the intake: first its proposed ' +
      'answers, all in one question, then each open question alone.',
    '',
    ...(records ? [`Its records, from kirunak/bugs/${slug}/, are now in kirunak/tasks/${slug}/bug/: ${records}.`, ''] : []),
    ...(lines ? [
      `The bug is a bug of ${ID}, a task accepted already.`,
      '',
      `## The lines of ${ID}, for the intake's first question (background only)`,
      'As they stand in kirunak/tasks/offline-forecast/task.md, in weather. The intake proposes them in its first ' +
        "question, with the bug's proposed answers, for one yes or no; on a no, it asks each one alone.",
      ...lines,
      '',
    ] : []),
    '## bug.md',
    'Headings:',
    '- Who raised it',
    '- Why',
    '- What was found',
    '- Fix written',
    '- Questions',
    `Fix written, on bug/${slug} in ${id.split('/')[0]}:`,
    '- the cache key holds the date [commit 1a2b3c4]',
    '',
    "## Proposed answers, for the intake's first question, every one in its own text",
    '1. The goal: "after a restart the app shows today\'s forecast, or none". Keep it?',
    '   Proposed: yes, as written.',
    '2. The criteria:',
    '   AC-1 a forecast kept from yesterday is never shown as today\'s after a restart.',
    '   Proposed: this one.',
    '4. The aspects: platforms and large text n/a, no screen changes; offline in (AC-1).',
    '   Proposed: as written.',
    '',
    '## Open questions, each asked alone after it',
    '3. Should the screen say when the forecast was fetched?',
    '',
  ].join('\n');
};

test('start --from a bug moves it by git mv into the task folder as bug.md and its records as bug/, staged; notes.md lists its proposed answers and its open questions; k bugs lists it no more and git keeps its history (gulnya/kirunak-bugs AC-8)', async () => {
  const { ws, home, weather } = await makeWorkspace({ finished: false });
  writeBug(weather);
  mkdirSync(join(weather, 'kirunak/bugs/offline-forecast'));
  writeFileSync(join(weather, 'kirunak/bugs/offline-forecast/review-1.md'), 'verdict: findings\nhead: 1a2b3c4d\n\n1. no test\n');
  writeFileSync(join(weather, 'kirunak/bugs/offline-forecast/intake.md'), BUG_LOG);
  gitCommitAll(weather, 'kirunak: a bug, weather/offline-forecast');
  const before = sh(weather, 'git', ['rev-parse', 'HEAD']).trim();
  assert.deepEqual(listBugs(ws).map((b) => b.id), [ID]);

  const r = await start({ ws, id: ID, from: BUG_REL, now: NOV2 });
  assert.deepEqual(r, { dir: join(ws.repos[0].root, 'kirunak/tasks/offline-forecast'), aspects: 3, bug: 'kirunak/tasks/offline-forecast/bug.md',
    records: 'kirunak/tasks/offline-forecast/bug', staged: true });
  assert.equal(readFileSync(join(dirOf(weather), 'bug.md'), 'utf8'), BUG);
  assert.equal(readFileSync(join(dirOf(weather), 'bug/intake.md'), 'utf8'), BUG_LOG);
  assert.equal(existsSync(join(weather, BUG_REL)), false);
  assert.equal(existsSync(join(weather, 'kirunak/bugs/offline-forecast')), false);
  // The title is the bug's; the front matter names the bug as where the task came from: background, not a source.
  assert.equal(readFileSync(join(dirOf(weather), 'task.md'), 'utf8'), SKELETON
    .replace(`title: ${TITLE}`, 'title: The kept forecast is stale after a restart')
    .replace('created: 2026-11-02\n', 'created: 2026-11-02\nfrom: kirunak/tasks/offline-forecast/bug.md\n'));
  assert.equal(readFileSync(join(dirOf(weather), 'notes.md'), 'utf8'), bugNotesOf(ID, { records: 'intake.md, review-1.md' }));

  // Staged, not committed: the moves are renames in the index, the intake's own files are untracked.
  assert.equal(sh(weather, 'git', ['rev-parse', 'HEAD']).trim(), before);
  assert.deepEqual(sh(weather, 'git', ['status', '--porcelain']).trim().split('\n').sort(), [
    '?? kirunak/tasks/offline-forecast/intake.md',
    '?? kirunak/tasks/offline-forecast/notes.md',
    '?? kirunak/tasks/offline-forecast/task.md',
    'R  kirunak/bugs/offline-forecast.md -> kirunak/tasks/offline-forecast/bug.md',
    'R  kirunak/bugs/offline-forecast/intake.md -> kirunak/tasks/offline-forecast/bug/intake.md',
    'R  kirunak/bugs/offline-forecast/review-1.md -> kirunak/tasks/offline-forecast/bug/review-1.md',
  ]);
  assert.deepEqual(listBugs(ws), []);
  const out = k(home, ['bugs']);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /offline-forecast/);

  gitCommitAll(weather, 'kirunak: weather/offline-forecast intake');
  const history = sh(weather, 'git', ['log', '--follow', '--format=%s', '--', 'kirunak/tasks/offline-forecast/bug.md']);
  assert.deepEqual(history.trim().split('\n'), ['kirunak: weather/offline-forecast intake', 'kirunak: a bug, weather/offline-forecast']);
});

test('k intake start --from a bug never committed, and with no folder, renames it and says where it is now (gulnya/kirunak-bugs AC-8)', async () => {
  const { home, weather } = await makeWorkspace({ finished: false });
  writeBug(weather);
  const r = k(home, ['intake', 'start', ID, '--from', BUG_REL]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started weather\/offline-forecast: .*kirunak\/tasks\/offline-forecast \(3 aspects open\); the bug is now kirunak\/tasks\/offline-forecast\/bug\.md: commit it with the intake/);
  assert.equal(readFileSync(join(dirOf(weather), 'bug.md'), 'utf8'), BUG);
  assert.equal(existsSync(join(dirOf(weather), 'bug')), false);
  // The CLI reads it today.
  const read = localDate();
  assert.equal(readFileSync(join(dirOf(weather), 'notes.md'), 'utf8'), bugNotesOf(ID, { read }));
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '?? kirunak/');
});

test('start --from a bug takes only the bug of its own id: another id\'s bug, a path under kirunak/bugs/ that is no bug, a bug whose front matter names another, one gone and one whose Review & merge runs are refused, and nothing is written (gulnya/kirunak-bugs AC-8, E-3)', async () => {
  const { ws, home, weather } = await makeWorkspace({ finished: false });
  writeBug(weather, BUG.replace(/offline-forecast/g, 'wind-alerts'), 'kirunak/bugs/wind-alerts.md');
  await assert.rejects(start({ ws, id: ID, from: 'kirunak/bugs/wind-alerts.md', now: NOV2 }),
    (e) => e.code === 1 && e.message === '--from kirunak/bugs/wind-alerts.md is the bug weather/wind-alerts, not weather/offline-forecast: ' +
      'k intake start weather/wind-alerts --from kirunak/bugs/wind-alerts.md');
  mkdirSync(join(weather, 'kirunak/bugs/offline-forecast'));
  writeFileSync(join(weather, 'kirunak/bugs/offline-forecast/review-1.md'), 'verdict: findings\n');
  await assert.rejects(start({ ws, id: ID, from: 'kirunak/bugs/offline-forecast/review-1.md', now: NOV2 }),
    (e) => e.code === 1 && e.message === '--from kirunak/bugs/offline-forecast/review-1.md is not a bug: a bug is kirunak/bugs/<slug>.md, ' +
      'k intake start weather/offline-forecast --from kirunak/bugs/offline-forecast.md');
  writeBug(weather, BUG.replace(`id: ${ID}`, 'id: weather/other'));
  await assert.rejects(start({ ws, id: ID, from: BUG_REL, now: NOV2 }),
    /--from kirunak\/bugs\/offline-forecast\.md is the bug weather\/other, not weather\/offline-forecast: its front matter says id: weather\/other/);
  assert.equal(existsSync(dirOf(weather)), false);

  // A Review & merge running on it holds it (E-3); a dead pid's lock does not.
  writeBug(weather);
  const lock = reviewLockPath(home, ID);
  mkdirSync(join(lock, '..'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: '2026-11-02T19:00:00Z' }));
  await assert.rejects(start({ ws, id: ID, from: BUG_REL, now: NOV2 }),
    (e) => e.code === 1 && e.message === `the bug ${ID} cannot start its intake: its Review & merge runs (pid ${process.pid}, started ` +
      '2026-11-02T19:00:00Z) and may merge its fix and close it; k bugs shows its result once it ends');
  assert.equal(readFileSync(join(weather, BUG_REL), 'utf8'), BUG);
  assert.equal(existsSync(join(weather, 'kirunak/bugs/offline-forecast/review-1.md')), true);
  assert.equal(existsSync(dirOf(weather)), false);
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, started: '2026-11-02T19:00:00Z' }));

  rmSync(join(weather, BUG_REL));
  await assert.rejects(start({ ws, id: ID, from: BUG_REL, now: NOV2 }),
    /the bug weather\/offline-forecast is gone: kirunak\/bugs\/offline-forecast\.md does not exist .*\(merged, dropped, or its intake started elsewhere\); k bugs lists the bugs that wait/);
  assert.equal(existsSync(dirOf(weather)), false);

  writeBug(weather);
  await start({ ws, id: ID, from: BUG_REL, now: NOV2 });
  await assert.rejects(start({ ws, id: ID, from: BUG_REL, now: NOV2 }),
    /the bug weather\/offline-forecast is gone: .*\(its intake started already, and it is kirunak\/tasks\/offline-forecast\/bug\.md\)/);
});

test('a task written from the one answer to the first question and each open question\'s passes k check, and its commit with the bug\'s move passes the task repo\'s hook (gulnya/kirunak-bugs AC-8)', async () => {
  const { ws, home, weather } = await makeWorkspace({ finished: false });
  const hook = join(weather, '.git/hooks/pre-commit');
  mkdirSync(join(hook, '..'), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${join(KIRUNAK, 'hooks/git-pre-commit.mjs')}"\n`);
  chmodSync(hook, 0o755);
  // The bug as k bug from leaves an intake it moved: its folder holds that intake's log.
  writeBug(weather);
  mkdirSync(join(weather, 'kirunak/bugs/offline-forecast'));
  writeFileSync(join(weather, 'kirunak/bugs/offline-forecast/intake.md'), BUG_LOG);
  gitCommitAll(weather, 'kirunak: weather/offline-forecast is a bug');
  await start({ ws, id: ID, from: BUG_REL, now: NOV2 });

  const first = question(ws, ID, 'bug', 'Do these stand, each as proposed? 1. The goal: after a restart the app shows today\'s ' +
    'forecast, or none: yes. 2. AC-1 a forecast kept from yesterday is never shown as today\'s after a restart. 4. The ' +
    'aspects: platforms and large text n/a, no screen changes; offline in (AC-1).', NOV2);
  const yes = answer(ws, ID, first, 'Yes, all of them.', '→ Goal, AC-1, platforms, large-text, offline', NOV2);
  const third = question(ws, ID, 'acceptance', 'Should the screen say when the forecast was fetched?', NOV2);
  const words = answer(ws, ID, third, 'Yes, in words.', '→ AC-2', NOV2);
  assert.deepEqual([first, third], ['Q-1', 'Q-2']);
  const from = '[from kirunak/tasks/offline-forecast/bug.md]';
  writeFileSync(join(dirOf(weather), 'task.md'), [
    '---',
    `id: ${ID}`,
    'title: The kept forecast is stale after a restart',
    'created: 2026-11-02',
    'from: kirunak/tasks/offline-forecast/bug.md',
    '---',
    '',
    '## Goal',
    `After a restart the app shows today's forecast, or none. ${yes.tag} ${from}`,
    '',
    '## Acceptance criteria',
    `- AC-1 A forecast kept from yesterday is never shown as today's after a restart. ${yes.tag} ${from}`,
    `- AC-2 The forecast screen says in words when the forecast was fetched. ${words.tag}`,
    '',
    '## Edge cases',
    '',
    '## Out of scope',
    '',
    '## Decisions',
    '',
    '## Aspects',
    `- platforms: n/a: no screen changes ${yes.tag}`,
    `- large-text: n/a: no screen changes ${yes.tag}`,
    `- offline: in (AC-1) ${yes.tag}`,
    '',
    '## Open questions',
    '',
  ].join('\n'));
  const checked = k(home, ['check', ID]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);

  sh(weather, 'git', ['add', '--', 'kirunak/tasks/offline-forecast']);
  // The hook reads the scratch home, never the real one, and no GIT_ variable of the run that runs the tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([n]) => !n.startsWith('KIRUNAK_') && !n.startsWith('GIT_')));
  const committed = spawnSync('git', ['commit', '-q', '-m', `kirunak: intake ${ID}`], { cwd: weather, env: { ...env, KIRUNAK_HOME: home }, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']), '');
  assert.equal(readFileSync(join(dirOf(weather), 'bug/intake.md'), 'utf8'), BUG_LOG);
});

// R29 (kirunak-spikes AC-1): a bug that names the accepted task it was found in, here another repo's.
const STALE_REL = 'kirunak/bugs/stale-tiles.md';
const bugDir = (repo) => join(repo, 'kirunak/tasks/stale-tiles');
const FINISHED = readFileSync(join(FIXTURES, 'workspace/weather/kirunak/tasks/offline-forecast/task.md'), 'utf8');

// BUG as the bug `id` of `task`.
const bugOf = (id, task = ID) => BUG.replace(`id: ${ID}`, `id: ${id}`)
  .replace('written: 2026-10-22\n', `written: 2026-10-22\nbug-of: ${task}\n`);

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

test('start --from a bug of a task in another repo: notes.md says whose bug it is and holds that task\'s edge cases, out of scope and aspects as they stand, for the first question; the task stays as it was (kirunak-spikes AC-1, E-3; gulnya/kirunak-bugs AC-10)', async () => {
  const w = await acceptedWorkspace();
  const STALE = 'hub/stale-tiles';
  writeBug(w.hub, bugOf(STALE), STALE_REL);
  gitCommitAll(w.hub, `kirunak: a bug, ${STALE}`);
  const finished = snapshot(dirOf(w.weather));

  const r = await start({ ws: w.ws, id: STALE, from: STALE_REL, now: NOV2 });
  assert.deepEqual(r, { dir: bugDir(w.ws.repos[1].root), aspects: 3, bug: 'kirunak/tasks/stale-tiles/bug.md', records: null, staged: true });
  assert.equal(readFileSync(join(bugDir(w.hub), 'notes.md'), 'utf8'), bugNotesOf(STALE, { rel: STALE_REL, lines: [
    'Edge cases:',
    ...linesOf(FINISHED, 'E-1 '),
    'Out of scope:',
    ...linesOf(FINISHED, 'O-1 '),
    'Aspects:',
    ...linesOf(FINISHED, 'platforms:', 'large-text:', 'offline:'),
  ] }));
  assert.equal(readFileSync(join(bugDir(w.hub), 'bug.md'), 'utf8'), bugOf(STALE));
  assert.deepEqual(sh(w.hub, 'git', ['status', '--porcelain']).trim().split('\n').sort(), [
    '?? kirunak/tasks/stale-tiles/intake.md',
    '?? kirunak/tasks/stale-tiles/notes.md',
    '?? kirunak/tasks/stale-tiles/task.md',
    'R  kirunak/bugs/stale-tiles.md -> kirunak/tasks/stale-tiles/bug.md',
  ]);
  // The finished task is only read: its folder byte for byte as it was, its repo with nothing to commit.
  assert.deepEqual(snapshot(dirOf(w.weather)), finished);
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain']), '');
});

test('start --from a bug in its task\'s repo takes the task\'s lines as they stand now, an amendment\'s included, and says when a section has none (kirunak-spikes AC-1)', async () => {
  const w = await acceptedWorkspace();
  const STALE = 'weather/stale-tiles';
  // task.md as an applied amendment leaves it: E-1 replaced, E-2 added, O-1 removed.
  const amended = FINISHED
    .replace(/^- E-1 .*$/m, '- E-1 A forecast older than a day shows its age in words. [owner 2026-11-04 Q-9]\n' +
      '- E-2 A forecast older than a week is not shown. [owner 2026-11-04 Q-9]')
    .replace(/^- O-1 .*\n/m, '');
  writeFileSync(join(dirOf(w.weather), 'task.md'), amended);
  writeBug(w.weather, bugOf(STALE), STALE_REL);
  gitCommitAll(w.weather, 'an amendment and a bug');

  await start({ ws: w.ws, id: STALE, from: STALE_REL, now: NOV2 });
  assert.equal(readFileSync(join(bugDir(w.weather), 'notes.md'), 'utf8'), bugNotesOf(STALE, { rel: STALE_REL, lines: [
    'Edge cases:',
    ...linesOf(amended, 'E-1 ', 'E-2 '),
    'Out of scope: none',
    'Aspects:',
    ...linesOf(amended, 'platforms:', 'large-text:', 'offline:'),
  ] }));
  assert.equal(readFileSync(join(dirOf(w.weather), 'task.md'), 'utf8'), amended);
});

test('start --from a bug whose task is gone or not accepted is refused, the bug not moved and nothing written (kirunak-spikes AC-1)', async () => {
  const w = await makeWorkspace();
  const STALE = 'hub/stale-tiles';
  let text;
  const putBug = (task) => {
    text = bugOf(STALE, task);
    writeBug(w.hub, text, STALE_REL);
    sh(w.hub, 'git', ['add', '-A']);
    sh(w.hub, 'git', ['commit', '-q', '--allow-empty', '-m', `kirunak: a bug of ${task}`]);
  };
  const untouched = () => {
    assert.equal(readFileSync(join(w.hub, STALE_REL), 'utf8'), text);
    assert.equal(existsSync(bugDir(w.hub)), false);
    assert.equal(sh(w.hub, 'git', ['status', '--porcelain']), '');
  };
  const refused = (why) => `the bug ${STALE} cannot start its intake: ${why}`;

  // Proposed, then approved and queued: not accepted.
  putBug(ID);
  const open = `${ID} is not accepted yet: a bug found while a task is open goes into that task, through its review or ` +
    `an amendment (k amend new ${ID} --title "...")`;
  await assert.rejects(start({ ws: w.ws, id: STALE, from: STALE_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(open));
  untouched();
  await approve({ ws: w.ws, id: ID });
  await assert.rejects(start({ ws: w.ws, id: STALE, from: STALE_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(open));
  untouched();
  const cli = k(w.home, ['intake', 'start', STALE, '--from', STALE_REL]);
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
    await assert.rejects(start({ ws: w.ws, id: STALE, from: STALE_REL, now: NOV2 }), (e) => e.code === 1 && e.message === refused(why));
    untouched();
  }
});

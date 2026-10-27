import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve, verify } from '../lib/approval.mjs';
import { check, checkDraft, drop, format, list, move, newDraft, parseDraft } from '../lib/drafts.mjs';
import { start } from '../lib/intake.mjs';
import { rows as taskRows } from '../lib/list.mjs';
import { recordPaths } from '../lib/records.mjs';
import { gitCommitAll, k, makeWorkspace, sh } from './helpers.mjs';

for (const k of Object.keys(process.env)) if (k.startsWith('KIRUNAK_') && k !== 'KIRUNAK_HOME') delete process.env[k];

const OCT22 = new Date(2026, 9, 22, 10, 30, 0);
const ID = 'weather/wind-alerts';
const rootOf = (w, repo = 'weather') => w.ws.repos.find((r) => r.name === repo).root;
const fileOf = (w, slug = 'wind-alerts', repo = 'weather') => join(rootOf(w, repo), 'kirunak', 'drafts', `${slug}.md`);

// A draft that holds AC-5's shape: the owner's words, why, two findings with sources, two questions.
const FILLED = `---
id: weather/wind-alerts
title: Wind alerts for cyclists
written: 2026-10-22
---

## Who raised it
> could the app warn cyclists
> before a windy ride?
owner, 2026-10-22, session 5f0c2a

## Why
Cyclists open the forecast before a ride and miss the gusts.

## What was found
- the forecast already carries gusts per hour [file src/Forecast.kt]
- nothing sends an alert yet,
  in any module [command grep -rn alert src]

## Questions
1. From which gust speed should it warn?
2. A notification, or only a line on the forecast?
`;

const problemsOf = (text, id = ID) => checkDraft(text, id).map((p) => p.problem);

test('k draft new writes the skeleton with its id, title and date, commits nothing, and the check refuses every section', async () => {
  const w = await makeWorkspace();
  const r = newDraft({ ws: w.ws, id: ID, title: '  Wind alerts\nfor cyclists ', session: '5f0c2a', now: OCT22 });
  assert.equal(r.path, fileOf(w));
  assert.equal(r.rel, 'kirunak/drafts/wind-alerts.md');
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /^---\nid: weather\/wind-alerts\ntitle: Wind alerts for cyclists\nwritten: 2026-10-22\n---\n/);
  assert.match(text, /session 5f0c2a/);
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain']).trim(), '?? kirunak/drafts/');
  assert.deepEqual(check(w.ws, ID).map((p) => p.problem), [
    '## Who raised it is empty: it still holds its placeholder',
    '## Why is empty: it still holds its placeholder',
    '## What was found is empty: it still holds its placeholder',
    '## Questions is empty: it still holds its placeholder',
  ]);
});

test('a filled draft passes the check, from the owner or found by the agent', async () => {
  const w = await makeWorkspace();
  newDraft({ ws: w.ws, id: ID, title: 'Wind alerts', now: OCT22 });
  writeFileSync(fileOf(w), FILLED);
  assert.deepEqual(check(w.ws, ID), []);
  const agent = FILLED.replace(/> could[\s\S]*?session 5f0c2a/, 'Found by the agent: three crash reports name a wind screen that does not exist.');
  assert.deepEqual(problemsOf(agent), []);
});

test('the check names a placeholder left beside content, and an empty section without one', () => {
  const left = FILLED.replace('## Why\n', '## Why\n<!-- fill in: why this could become a task -->\n');
  assert.deepEqual(problemsOf(left), ['## Why still holds its placeholder: remove the <!-- fill in ... --> comment']);
  assert.deepEqual(problemsOf(FILLED.replace(/## Why\n.*\n/, '## Why\n<!-- a note -->\n')), ['## Why is empty']);
});

test('the check names a missing, unknown, repeated or misplaced section, and text before the first', () => {
  assert.deepEqual(problemsOf(FILLED.replace(/## Why\n.*\n\n/, '')), ['missing section ## Why']);
  assert.deepEqual(problemsOf(FILLED + '\n## Notes\nmore\n'), [
    'unknown section "## Notes": the sections are Who raised it, Why, What was found, Questions',
  ]);
  assert.deepEqual(problemsOf(FILLED + '\n## Why\nagain\n'), ['section Why appears twice']);
  const swapped = FILLED.replace('## Why', '## TMP').replace('## Questions', '## Why').replace('## TMP', '## Questions');
  assert.ok(problemsOf(swapped).includes('section Why is out of order: Who raised it, Why, What was found, Questions'));
  assert.deepEqual(problemsOf(FILLED.replace('---\n\n## Who', '---\nstray words\n\n## Who')), [
    'text before the first section: it belongs under a ## heading',
  ]);
});

test('a heading inside a code fence or a comment is not a section', () => {
  const log = '- the build log says so:\n  ```\n  ## Not a heading\n  ```\n  [file build.log]\n- nothing sends';
  assert.deepEqual(problemsOf(FILLED.replace('- nothing sends', log)), []);
  assert.deepEqual(problemsOf(FILLED.replace('## Why\n', '<!--\n## Hidden\n-->\n## Why\n')), []);
});

test('the front matter: id, title of a few words, written as a date, and the id of the draft\'s own place', () => {
  assert.deepEqual(problemsOf(FILLED.replace(/^---[\s\S]*?---\n/, '')), ['no front matter: the draft starts with --- and id, title, written']);
  assert.deepEqual(problemsOf(FILLED.replace('title: Wind alerts for cyclists\n', '')), ['front matter has no title']);
  assert.deepEqual(problemsOf(FILLED, 'weather/gusts'), ["id weather/wind-alerts is not this draft's id weather/gusts"]);
  assert.deepEqual(problemsOf(FILLED.replace('written: 2026-10-22', 'written: 2026-10-32')), ['written 2026-10-32 is not a date YYYY-MM-DD']);
  assert.deepEqual(problemsOf(FILLED.replace('Wind alerts for cyclists', 'w'.repeat(81))), ['the title is a few words, at most 80 characters']);
});

test('who raised it: the owner\'s words quoted, with the date and the session, or what the agent saw', () => {
  const who = (body) => problemsOf(FILLED.replace(/> could[\s\S]*?session 5f0c2a/, body));
  assert.deepEqual(who('the owner wants it, 2026-10-22, session 5f0c2a'), [
    '## Who raised it: no quoted words: the owner\'s words as typed, each line starting with "> ", or "found by the agent:" and what it saw',
  ]);
  assert.deepEqual(who('> warn cyclists\nowner, session 5f0c2a'), ['## Who raised it: no date: say when the owner said it, YYYY-MM-DD']);
  assert.deepEqual(who('> warn cyclists\nowner, 2026-10-22'), ['## Who raised it: no session: name the session the owner said it in, "session <id>"']);
  assert.deepEqual(who('> warn cyclists\nowner, 2026-10-22, session <session id>'), [
    '## Who raised it: no session: name the session the owner said it in, "session <id>"',
  ]);
  assert.deepEqual(who('Found by the agent.'), ['## Who raised it: say what the agent saw, after "found by the agent:"']);
});

test('what was found: every finding a "- " line ending with its source', () => {
  const found = (body) => problemsOf(FILLED.replace(/- the forecast[\s\S]*?alert src\]\n/, body));
  assert.deepEqual(found('### In the code\n- gusts per hour [file src/Forecast.kt]\n- a study [research https://example.org/wind]\n- landed [commit 1a2b3c4]\n'), []);
  assert.deepEqual(found('- gusts per hour\n'), ['## What was found: this finding names no source: end it with [file ...], [command ...], [commit ...], [research ...]']);
  assert.deepEqual(found('- gusts per hour [seen it]\n'), ['## What was found: this finding names no source: end it with [file ...], [command ...], [commit ...], [research ...]']);
  assert.deepEqual(found('Gusts per hour. [file src/Forecast.kt]\n'), [
    '## What was found: no finding: one "- " line each, ending with its source ([file ...], [command ...], [commit ...], [research ...])',
    '## What was found: write each finding as a "- " line ending with its source ([file ...], [command ...], [commit ...], [research ...])',
  ]);
});

test('questions: numbered 1, 2, 3 in order, one a line', () => {
  const qs = (body) => problemsOf(FILLED.replace(/1\. From[\s\S]*$/, body));
  assert.deepEqual(qs('1. From which speed,\n   and for whom?\n'), []);
  assert.deepEqual(qs('1. One?\n3. Three?\n'), ['## Questions: question 3 is out of turn: number them 1, 2, 3 in order']);
  assert.deepEqual(qs('- One?\n'), ['## Questions: no question: number them "1. ", "2. ", one a line', '## Questions: a question is a numbered line, "1. <question>"']);
});

test('E-1: a repo the workspace does not know is refused, and the owner is asked to add it', async () => {
  const w = await makeWorkspace();
  for (const run of [() => newDraft({ ws: w.ws, id: 'radio/wind', title: 'Wind' }), () => check(w.ws, 'radio/wind')]) {
    assert.throws(run, (e) => e.code === 1 && /^unknown repo radio: kirunak's workspace lists weather, hub\. Ask the owner to add radio to kirunak's workspace first/.test(e.message));
  }
  assert.throws(() => newDraft({ ws: w.ws, id: 'weather/Wind', title: 'Wind' }), (e) => e.code === 2 && /^not a draft id: weather\/Wind/.test(e.message));
});

test('E-2: an id that is already a draft or a task, in any state, is refused and named', async () => {
  const w = await makeWorkspace();
  newDraft({ ws: w.ws, id: ID, title: 'Wind alerts' });
  assert.throws(() => newDraft({ ws: w.ws, id: ID, title: 'Again' }), (e) => e.code === 1 && e.message === `${ID} is already a draft: ${fileOf(w)}`);
  assert.throws(() => newDraft({ ws: w.ws, id: 'weather/offline-forecast', title: 'x' }), /weather\/offline-forecast is already a task: /);
  await start({ ws: w.ws, id: 'hub/new-queue', title: 'A new queue' });
  assert.throws(() => newDraft({ ws: w.ws, id: 'hub/new-queue', title: 'x', dryRun: true }), /hub\/new-queue is already a task: /);
  mkdirSync(join(w.hub, 'kirunak', 'approvals'), { recursive: true });
  writeFileSync(join(w.hub, 'kirunak', 'approvals', 'gone.json'), '{}\n');
  assert.throws(() => newDraft({ ws: w.ws, id: 'hub/gone', title: 'x' }), /hub\/gone is already a task: .*approvals\/gone\.json$/);
});

test('k draft new: a title is required, a dry run writes nothing, and a missing draft is not checked', async () => {
  const w = await makeWorkspace();
  assert.throws(() => newDraft({ ws: w.ws, id: ID, title: '  ' }), (e) => e.code === 2 && /needs its title/.test(e.message));
  assert.throws(() => newDraft({ ws: w.ws, id: ID, title: 'w'.repeat(81) }), (e) => e.code === 2 && /at most 80 characters/.test(e.message));
  assert.equal(newDraft({ ws: w.ws, id: ID, title: 'Wind', dryRun: true }).path, fileOf(w));
  assert.equal(existsSync(fileOf(w)), false);
  assert.throws(() => check(w.ws, ID), (e) => e.code === 1 && /^no draft weather\/wind-alerts: .* does not exist/.test(e.message));
});

// The invented workspace with the filled draft committed in weather.
async function committedDraft() {
  const w = await makeWorkspace();
  mkdirSync(join(rootOf(w), 'kirunak', 'drafts'), { recursive: true });
  writeFileSync(fileOf(w), FILLED);
  gitCommitAll(w.weather, 'the draft');
  return { ...w, git: (...args) => sh(w.weather, 'git', args).trim() };
}

test('k draft drop: removes the draft in a commit of that path alone, the reason in its message; a staged file stays staged', async () => {
  const w = await committedDraft();
  writeFileSync(join(w.weather, 'README.md'), 'changed\n');
  w.git('add', 'README.md');
  const r = drop({ ws: w.ws, id: ID, why: ' folded into\noffline-forecast ' });
  assert.equal(existsSync(fileOf(w)), false);
  assert.equal(r.commit, w.git('rev-parse', '--short', 'HEAD'));
  assert.equal(w.git('log', '-1', '--format=%s'), 'kirunak: drop the draft weather/wind-alerts: folded into offline-forecast');
  assert.equal(w.git('show', '--name-status', '--format=', 'HEAD'), 'D\tkirunak/drafts/wind-alerts.md');
  assert.equal(w.git('diff', '--cached', '--name-only'), 'README.md');
});

test('k draft drop: refused without a reason, for a missing draft, and a dry run changes nothing', async () => {
  const w = await committedDraft();
  const before = w.git('rev-parse', 'HEAD');
  for (const why of [undefined, '', '  \n ']) {
    assert.throws(() => drop({ ws: w.ws, id: ID, why }), (e) => e.code === 2 && /needs its reason: --why/.test(e.message));
  }
  assert.throws(() => drop({ ws: w.ws, id: 'weather/gusts', why: 'x' }), (e) => e.code === 1 && /^no draft weather\/gusts: /.test(e.message));
  assert.throws(() => drop({ ws: w.ws, id: 'radio/gusts', why: 'x' }), /Ask the owner to add radio to kirunak's workspace first/);
  const dry = drop({ ws: w.ws, id: ID, why: 'not now', dryRun: true });
  assert.equal(dry.message, 'kirunak: drop the draft weather/wind-alerts: not now');
  assert.equal(dry.tracked, true);
  assert.equal(existsSync(fileOf(w)), true);
  assert.equal(w.git('rev-parse', 'HEAD'), before);
  assert.equal(w.git('status', '--porcelain'), '');
});

test('k draft drop: a draft never committed is only deleted; a refused commit puts the draft back', async () => {
  const w = await makeWorkspace();
  newDraft({ ws: w.ws, id: ID, title: 'Wind' });
  const head = sh(w.weather, 'git', ['rev-parse', 'HEAD']);
  assert.equal(drop({ ws: w.ws, id: ID, why: 'a duplicate' }).commit, null);
  assert.equal(existsSync(fileOf(w)), false);
  assert.equal(sh(w.weather, 'git', ['rev-parse', 'HEAD']), head);

  const c = await committedDraft();
  writeFileSync(fileOf(c), FILLED + '\nan edit not committed\n');
  writeFileSync(join(c.weather, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "refused by the hook" >&2\nexit 1\n');
  chmodSync(join(c.weather, '.git', 'hooks', 'pre-commit'), 0o755);
  assert.throws(() => drop({ ws: c.ws, id: ID, why: 'x' }), (e) => e.code === 1 && /refused by the hook/.test(e.message));
  assert.equal(readFileSync(fileOf(c), 'utf8'), FILLED + '\nan edit not committed\n');
  assert.equal(c.git('status', '--porcelain'), 'M kirunak/drafts/wind-alerts.md');
});

test('k drafts: every draft in every repo, by date written then id, an undated one last; other files are no drafts', async () => {
  const w = await makeWorkspace();
  const put = (repo, slug, front) => {
    mkdirSync(join(rootOf(w, repo), 'kirunak', 'drafts'), { recursive: true });
    writeFileSync(fileOf(w, slug, repo), `---\n${front}---\n`);
  };
  put('weather', 'wind-alerts', 'id: weather/wind-alerts\ntitle: Wind alerts\nwritten: 2026-10-22\n');
  put('hub', 'queue-lanes', 'id: hub/queue-lanes\ntitle: Lanes in the queue\nwritten: 2026-10-22\n');
  put('weather', 'pollen', 'id: weather/pollen\ntitle: Pollen counts\nwritten: 2026-10-20\n');
  put('weather', 'undated', 'title: No date\nwritten: someday\n');
  writeFileSync(fileOf(w, 'README', 'weather'), '# not a draft\n');
  writeFileSync(join(rootOf(w), 'kirunak', 'drafts', 'notes.txt'), 'not a draft\n');
  const rows = list(w.ws);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.written]), [
    ['weather/pollen', 'Pollen counts', '2026-10-20'],
    ['hub/queue-lanes', 'Lanes in the queue', '2026-10-22'],
    ['weather/wind-alerts', 'Wind alerts', '2026-10-22'],
    ['weather/undated', 'No date', null],
  ]);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'repo', 'slug', 'title', 'written', 'bugOf', 'path']);
  assert.ok(rows.every((r) => r.bugOf === null));
  assert.deepEqual([rows[0].repo, rows[0].slug, rows[0].path], ['weather', 'pollen', fileOf(w, 'pollen')]);
  assert.equal(format(rows), [
    'weather/pollen       Pollen counts       2026-10-20',
    'hub/queue-lanes      Lanes in the queue  2026-10-22',
    'weather/wind-alerts  Wind alerts         2026-10-22',
    'weather/undated      No date             no date',
  ].join('\n'));
  assert.equal(format([]), 'no drafts');
});

// The drafts' order (owner, 2026-10-27): four drafts across both repos, committed, and the order file beside hub's queue.
async function orderedWorkspace() {
  const w = await makeWorkspace();
  const put = (repo, slug, written) => {
    mkdirSync(join(rootOf(w, repo), 'kirunak', 'drafts'), { recursive: true });
    writeFileSync(fileOf(w, slug, repo), `---\nid: ${repo}/${slug}\ntitle: ${slug}\nwritten: ${written}\n---\n`);
  };
  put('weather', 'pollen', '2026-10-20');
  put('hub', 'lanes', '2026-10-21');
  put('weather', 'wind', '2026-10-22');
  put('hub', 'tiles', '2026-10-23');
  gitCommitAll(w.weather, 'drafts');
  gitCommitAll(w.hub, 'drafts');
  const ids = () => list(w.ws).map((r) => r.id);
  const hubGit = (...args) => sh(w.hub, 'git', args).trim();
  return { ...w, ids, hubGit, order: join(rootOf(w, 'hub'), 'kirunak', 'drafts-order.md') };
}

test('k drafts: the drafts the order names first, as it names them, then the others by the date written', async () => {
  const w = await orderedWorkspace();
  assert.equal(w.ws.draftOrder, w.order);
  assert.deepEqual(w.ids(), ['weather/pollen', 'hub/lanes', 'weather/wind', 'hub/tiles']);
  writeFileSync(w.order, '# a comment\nhub/tiles\n\nweather/gone\n  weather/wind  \nhub/tiles\n');
  assert.deepEqual(w.ids(), ['hub/tiles', 'weather/wind', 'weather/pollen', 'hub/lanes']);
  assert.ok(recordPaths(w.ws).includes('kirunak/drafts-order.md'));
});

test('k drafts move: to the end, the start, before or after a draft; several in the order named, one commit each', async () => {
  const w = await orderedWorkspace();
  writeFileSync(join(w.hub, 'README.md'), 'changed\n');
  w.hubGit('add', 'README.md');
  const r = move({ ws: w.ws, ids: ['weather/pollen'] });
  assert.deepEqual(r.order, ['hub/lanes', 'weather/wind', 'hub/tiles', 'weather/pollen']);
  assert.deepEqual(w.ids(), r.order);
  assert.equal(r.commit, w.hubGit('rev-parse', '--short', 'HEAD'));
  assert.equal(w.hubGit('log', '-1', '--format=%s'), 'kirunak: drafts move weather/pollen');
  assert.equal(w.hubGit('show', '--name-status', '--format=', 'HEAD'), 'A\tkirunak/drafts-order.md');
  assert.equal(w.hubGit('diff', '--cached', '--name-only'), 'README.md');
  assert.match(readFileSync(w.order, 'utf8'), /^# .*\n# .*\nhub\/lanes\nweather\/wind\nhub\/tiles\nweather\/pollen\n$/);

  assert.deepEqual(move({ ws: w.ws, ids: ['hub/tiles'], place: { first: true } }).order, ['hub/tiles', 'hub/lanes', 'weather/wind', 'weather/pollen']);
  assert.deepEqual(move({ ws: w.ws, ids: ['weather/pollen'], place: { before: 'hub/lanes' } }).order, ['hub/tiles', 'weather/pollen', 'hub/lanes', 'weather/wind']);
  assert.deepEqual(move({ ws: w.ws, ids: ['hub/tiles'], place: { after: 'weather/wind' } }).order, ['weather/pollen', 'hub/lanes', 'weather/wind', 'hub/tiles']);
  const several = move({ ws: w.ws, ids: ['hub/tiles', 'weather/pollen'], place: { first: true } });
  assert.deepEqual(several.order, ['hub/tiles', 'weather/pollen', 'hub/lanes', 'weather/wind']);
  assert.equal(w.hubGit('log', '-1', '--format=%B'), 'kirunak: drafts move 2 drafts\n\nhub/tiles\nweather/pollen');
  assert.equal(w.hubGit('rev-list', '--count', 'HEAD'), '7'); // the fixture's and the drafts' commits, then five moves

  const head = w.hubGit('rev-parse', 'HEAD');
  assert.equal(move({ ws: w.ws, ids: ['weather/wind'] }).commit, null);
  assert.equal(w.hubGit('rev-parse', 'HEAD'), head);
});

test('k drafts move: a new draft follows the order, one gone is left out, and a refused commit puts the file back', async () => {
  const w = await orderedWorkspace();
  move({ ws: w.ws, ids: ['hub/lanes'], place: { first: true } });
  writeFileSync(fileOf(w, 'frost', 'weather'), '---\nid: weather/frost\ntitle: frost\nwritten: 2026-10-01\n---\n');
  assert.deepEqual(w.ids(), ['hub/lanes', 'weather/pollen', 'weather/wind', 'hub/tiles', 'weather/frost']);
  rmSync(fileOf(w, 'wind', 'weather'));
  move({ ws: w.ws, ids: ['weather/frost'], place: { after: 'hub/lanes' } });
  assert.match(readFileSync(w.order, 'utf8'), /\nhub\/lanes\nweather\/frost\nweather\/pollen\nhub\/tiles\n$/);

  const kept = readFileSync(w.order, 'utf8');
  writeFileSync(join(w.hub, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "refused by the hook" >&2\nexit 1\n');
  chmodSync(join(w.hub, '.git', 'hooks', 'pre-commit'), 0o755);
  assert.throws(() => move({ ws: w.ws, ids: ['hub/tiles'], place: { first: true } }), (e) => e.code === 1 && /refused by the hook/.test(e.message));
  assert.equal(readFileSync(w.order, 'utf8'), kept);
  assert.equal(w.hubGit('status', '--porcelain'), '');
});

test('k drafts move: refuses no draft, an unknown one, one named twice, a target unknown or moved; a dry run writes nothing', async () => {
  const w = await orderedWorkspace();
  const mv = (ids, place) => () => move({ ws: w.ws, ids, place });
  assert.throws(mv([]), (e) => e.code === 2 && /names one draft or more/.test(e.message));
  assert.throws(mv(['weather/gone']), (e) => e.code === 1 && e.message === 'no draft weather/gone: k drafts lists every draft');
  assert.throws(mv(['hub/tiles', 'hub/tiles']), (e) => e.code === 2 && e.message === 'hub/tiles is named twice');
  assert.throws(mv(['hub/tiles'], { before: 'weather/gone' }), (e) => e.code === 1 && /^no draft weather\/gone/.test(e.message));
  assert.throws(mv(['hub/tiles', 'hub/lanes'], { after: 'hub/lanes' }), (e) => e.code === 1 && e.message === 'hub/lanes cannot move relative to itself');
  const dry = move({ ws: w.ws, ids: ['weather/pollen'], dryRun: true });
  assert.deepEqual(dry.order, ['hub/lanes', 'weather/wind', 'hub/tiles', 'weather/pollen']);
  assert.equal(dry.commit, null);
  assert.equal(existsSync(w.order), false);
});

test('the verbs: k drafts move with its flags, --dry-run and --json, in the help, and an unknown drafts verb refused', async () => {
  const w = await orderedWorkspace();
  const run = (...args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  assert.match(run('help').stdout, /k drafts move <id>\.\.\. \[--first\|--last\|--before <id>\|--after <id>\]/);
  assert.equal(run('drafts', 'move', 'weather/pollen', '--dry-run').stdout,
    'would commit "kirunak: drafts move weather/pollen", the order then:\n 1  hub/lanes\n 2  weather/wind\n 3  hub/tiles\n 4  weather/pollen\n');
  assert.equal(existsSync(w.order), false);
  const moved = run('drafts', 'move', 'hub/tiles', 'weather/wind', '--first');
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.stdout.split('\n')[0], `moved in ${w.hubGit('rev-parse', '--short', 'HEAD')}`);
  assert.deepEqual(run('drafts').stdout.split('\n').map((l) => l.split(' ')[0]), ['hub/tiles', 'weather/wind', 'weather/pollen', 'hub/lanes', '']);
  assert.deepEqual(JSON.parse(run('drafts', 'move', 'hub/tiles', '--last', '--json').stdout).order, ['weather/wind', 'weather/pollen', 'hub/lanes', 'hub/tiles']);
  assert.match(run('drafts', 'move', 'hub/tiles').stdout, /^already in that order: nothing to commit\n/);
  assert.equal(run('drafts', 'shuffle').status, 2);
  assert.equal(run('drafts', 'move', 'weather/gone').status, 1);
});

test('the verbs: k draft new, check, drop and k drafts, with --json and --dry-run, and in the help', async () => {
  const w = await makeWorkspace();
  const run = (...args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  assert.match(run('help').stdout, /k draft new <repo>\/<slug> --title "\.\.\."[\s\S]*k draft drop <id> --why "\.\.\."[\s\S]*k drafts: /);
  assert.equal(run('draft', 'new', ID, '--title', 'Wind alerts', '--dry-run').status, 0);
  assert.equal(existsSync(fileOf(w)), false);
  const made = run('draft', 'new', ID, '--title', 'Wind alerts', '--session', 's9');
  assert.equal(made.status, 0, made.stderr);
  assert.match(readFileSync(fileOf(w), 'utf8'), /session s9/);
  assert.match(run('draft', 'new', ID, '--title', 'Again').stderr, /^k: weather\/wind-alerts is already a draft: /);
  assert.equal(run('draft', 'new', 'radio/x', '--title', 'x').status, 1);
  assert.equal(run('draft', 'new', 'weather/x').status, 2);

  const skeleton = run('draft', 'check', ID);
  assert.equal(skeleton.status, 1);
  assert.match(skeleton.stderr, /^weather\/wind-alerts: 4 problems\n {2}line 7: ## Who raised it is empty/);
  const json = run('draft', 'check', ID, '--json');
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).problems.length, 4);
  writeFileSync(fileOf(w), FILLED);
  assert.equal(run('draft', 'check', ID).stdout, 'weather/wind-alerts: check passes\n');

  assert.equal(run('drafts').stdout, 'weather/wind-alerts  Wind alerts for cyclists  2026-10-22\n');
  assert.deepEqual(JSON.parse(run('drafts', '--json').stdout), [
    { id: ID, repo: 'weather', slug: 'wind-alerts', title: 'Wind alerts for cyclists', written: '2026-10-22', bugOf: null, path: fileOf(w) },
  ]);

  gitCommitAll(w.weather, 'the draft');
  assert.match(run('draft', 'drop', ID).stderr, /needs its reason/);
  assert.equal(run('draft', 'drop', ID).status, 2);
  assert.match(run('draft', 'drop', ID, '--why', 'not now', '--dry-run').stdout, /^would remove kirunak\/drafts\/wind-alerts\.md in weather and commit "kirunak: drop the draft weather\/wind-alerts: not now"/);
  assert.equal(existsSync(fileOf(w)), true);
  const dropped = run('draft', 'drop', ID, '--why', 'not now');
  assert.equal(dropped.stdout, `weather/wind-alerts: dropped in ${sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim()}\n`);
  assert.deepEqual(JSON.parse(run('drafts', '--json').stdout), []);
  assert.equal(run('drafts').stdout, 'no drafts\n');
});

// gulnya/kirunak-bugs AC-1: a bug is no draft (the bugs' own tests are in bugs.test.mjs). A draft's bug marks, its
// bug-of and its Fix written, and `--bug-of` in `k draft new`, are refused, each naming the bug verb.
const TASK = 'weather/offline-forecast';
const BUG = 'hub/stale-tiles';
const bugFile = (w) => fileOf(w, 'stale-tiles', 'hub');
const lineOf = (text, s) => text.split('\n').findIndex((l) => l.includes(s)) + 1;

// FILLED as kirunak-spikes wrote a bug: in hub, bug-of the task, with a Fix written section unless `fix` is null.
const bugText = (fix = '- the cache expires [commit 1a2b3c4]\n') =>
  FILLED.replace('id: weather/wind-alerts', `id: ${BUG}`).replace('written: 2026-10-22\n', `written: 2026-10-22\nbug-of: ${TASK}\n`)
    .replace('## Questions', fix === null ? '## Questions' : `## Fix written\n${fix}\n## Questions`);

test('k draft new --bug-of is refused, naming k bug new, a dry run too, and nothing is written', async () => {
  const w = await makeWorkspace();
  for (const dryRun of [false, true]) {
    for (const [bugOf, named] of [[TASK, TASK], [' ', '<task>'], ['', '<task>']]) {
      assert.throws(() => newDraft({ ws: w.ws, id: BUG, title: 'Stale tiles', bugOf, dryRun }), (e) => e.code === 1 &&
        e.message === `a bug is not a draft: \`k bug new ${BUG} --title "..." --bug-of ${named}\` writes it in kirunak/bugs/`);
    }
  }
  assert.equal(existsSync(bugFile(w)), false);
  assert.equal(newDraft({ ws: w.ws, id: BUG, title: 'Stale tiles', bugOf: null }).path, bugFile(w));
});

test('a draft refuses bug-of and Fix written, each naming k bug from, and has no state field', () => {
  const ofTask = bugText(null);
  assert.deepEqual(checkDraft(ofTask, BUG), [{
    line: lineOf(ofTask, 'bug-of:'),
    problem: "bug-of is a bug's: a fault in something that exists is a bug in kirunak/bugs/, never a draft; `k bug from hub/stale-tiles` moves this one there",
  }]);
  const fixed = FILLED.replace('## Questions', '## Fix written\n- the cache [commit 1a2b3c4]\n\n## Questions');
  assert.deepEqual(checkDraft(fixed, ID), [{
    line: lineOf(fixed, '## Fix written'),
    problem: "## Fix written is a bug's: a draft holds no fix; `k bug from weather/wind-alerts` moves this one into kirunak/bugs/",
  }]);
  assert.deepEqual(problemsOf(bugText(), BUG).length, 2);
  assert.deepEqual(problemsOf(FILLED), []);
  const why = 'a draft has no state field: it waits in kirunak/drafts/ until an intake takes it, and `k draft drop --why` closes it';
  assert.deepEqual(checkDraft(FILLED.replace('written: 2026-10-22\n', 'written: 2026-10-22\nstate: parked\n'), ID), [{ line: 5, problem: why }]);
});

test('k drafts: a bug\'s row names its task, and its line says bug of <task>', async () => {
  const w = await makeWorkspace();
  const put = (repo, slug, front) => {
    mkdirSync(join(rootOf(w, repo), 'kirunak', 'drafts'), { recursive: true });
    writeFileSync(fileOf(w, slug, repo), `---\n${front}---\n`);
  };
  put('weather', 'wind-alerts', 'id: weather/wind-alerts\ntitle: Wind alerts\nwritten: 2026-10-22\n');
  put('hub', 'stale-tiles', `id: hub/stale-tiles\ntitle: Stale map tiles\nwritten: 2026-10-23\nbug-of: ${TASK}\n`);
  put('weather', 'undated-bug', `title: Undated bug\nbug-of: ${TASK}\n`);
  const rows = list(w.ws);
  assert.deepEqual(rows.map((r) => [r.id, r.bugOf]), [['weather/wind-alerts', null], ['hub/stale-tiles', TASK], ['weather/undated-bug', TASK]]);
  assert.equal(format(rows), [
    'weather/wind-alerts  Wind alerts      2026-10-22',
    'hub/stale-tiles      Stale map tiles  2026-10-23  bug of weather/offline-forecast',
    'weather/undated-bug  Undated bug      no date     bug of weather/offline-forecast',
  ].join('\n'));
});

test('the verbs: k draft new --bug-of with --dry-run and --json, its refusals, and k drafts naming the bug', async () => {
  const w = await acceptedWorkspace();
  const run = (...args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  assert.match(run('help').stdout, /k draft new <repo>\/<slug> --title "\.\.\." --bug-of <task>: a bug of that accepted task/);
  const nu = (...more) => run('draft', 'new', BUG, '--title', 'Stale map tiles', ...more);
  assert.equal(nu('--bug-of', TASK, '--dry-run').stdout, `would write ${bugFile(w)}, a bug of ${TASK}\n`);
  assert.deepEqual(JSON.parse(nu('--bug-of', TASK, '--dry-run', '--json').stdout).bugOf, TASK);
  assert.equal(existsSync(bugFile(w)), false);
  assert.equal(nu('--bug-of', 'weather/gone').status, 1);
  assert.match(nu('--bug-of', 'weather/gone', '--dry-run').stderr, /^k: unknown task weather\/gone: /);
  assert.equal(nu('--bug-of', TASK, '--bug-of', TASK).status, 2);
  assert.equal(nu('--bug-of').status, 2);
  assert.equal(existsSync(bugFile(w)), false);

  const made = nu('--bug-of', TASK);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /, a bug of weather\/offline-forecast: fill in every section \(name the fix under Fix written, or delete that section when no fix exists\), then `k draft check hub\/stale-tiles`/);
  assert.match(readFileSync(bugFile(w), 'utf8'), /\nbug-of: weather\/offline-forecast\n---\n/);
  assert.equal(run('draft', 'check', BUG).status, 1);
  putBug(w, bugText(null));
  assert.equal(run('draft', 'check', BUG).stdout, 'hub/stale-tiles: check passes\n');
  assert.equal(run('drafts').stdout, 'hub/stale-tiles  Wind alerts for cyclists  2026-10-22  bug of weather/offline-forecast\n');
  assert.equal(JSON.parse(run('drafts', '--json').stdout)[0].bugOf, TASK);
});

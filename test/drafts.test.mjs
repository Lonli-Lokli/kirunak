import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve, verify } from '../lib/approval.mjs';
import { check, checkDraft, drop, format, list, newDraft, parseDraft } from '../lib/drafts.mjs';
import { start } from '../lib/intake.mjs';
import { rows as taskRows } from '../lib/list.mjs';
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

// kirunak-spikes: a bug is a draft whose front matter names the accepted task it was found in (D-1).
const TASK = 'weather/offline-forecast';
const BUG = 'hub/stale-tiles';
const taskDir = (w) => join(rootOf(w), 'kirunak', 'tasks', 'offline-forecast');
const bugFile = (w) => fileOf(w, 'stale-tiles', 'hub');
const lineOf = (text, s) => text.split('\n').findIndex((l) => l.includes(s)) + 1;

// Every file and folder under dir with its bytes: the folder byte for byte.
const snapshot = (dir) =>
  readdirSync(dir, { recursive: true }).sort().map((f) => [f, statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f)) : 'folder']);

// The invented workspace with weather/offline-forecast accepted: approved, and its done.json committed as k accept does.
async function acceptedWorkspace() {
  const w = await makeWorkspace();
  await approve({ ws: w.ws, id: TASK });
  writeFileSync(join(taskDir(w), 'done.json'), '{"accepted":"2026-10-20"}\n');
  gitCommitAll(w.weather, 'accept');
  return w;
}

// FILLED as a bug of the accepted task, in hub, with the given Fix written section (none when null).
const bugText = (fix = '- the cache expires [commit 1a2b3c4]\n- the rest of it [file patches/tiles.patch]\n', task = TASK) =>
  FILLED.replace('id: weather/wind-alerts', `id: ${BUG}`).replace('written: 2026-10-22\n', `written: 2026-10-22\nbug-of: ${task}\n`)
    .replace('## Questions', fix === null ? '## Questions' : `## Fix written\n${fix}\n## Questions`);

const putBug = (w, text) => {
  mkdirSync(join(rootOf(w, 'hub'), 'kirunak', 'drafts'), { recursive: true });
  writeFileSync(bugFile(w), text);
};

test('k draft new --bug-of: bug-of in the front matter, Fix written before the questions, every placeholder refused', async () => {
  const w = await acceptedWorkspace();
  const r = newDraft({ ws: w.ws, id: BUG, title: 'Stale map tiles', bugOf: ` ${TASK} `, session: '5f0c2a', now: OCT22 });
  assert.deepEqual([r.path, r.bugOf], [bugFile(w), TASK]);
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /^---\nid: hub\/stale-tiles\ntitle: Stale map tiles\nwritten: 2026-10-22\nbug-of: weather\/offline-forecast\n---\n/);
  assert.deepEqual(parseDraft(text).sections.map((s) => s.name), ['Who raised it', 'Why', 'What was found', 'Fix written', 'Questions']);
  assert.match(text, /\n## Fix written\n<!-- fill in: .*\[commit <sha>\] or \[file <patch path>\]; or delete this section, heading and all, when no fix exists -->\n/);
  // Besides those two, a plain draft's skeleton word for word.
  const plain = newDraft({ ws: w.ws, id: 'hub/plain', title: 'Stale map tiles', session: '5f0c2a', now: OCT22 });
  assert.equal(plain.bugOf, null);
  const stripped = text.replace(`bug-of: ${TASK}\n`, '').replace(/## Fix written\n.*\n\n/, '').replace(BUG, 'hub/plain');
  assert.equal(stripped, readFileSync(plain.path, 'utf8'));
  assert.deepEqual(check(w.ws, BUG).map((p) => p.problem), [
    '## Who raised it is empty: it still holds its placeholder',
    '## Why is empty: it still holds its placeholder',
    '## What was found is empty: it still holds its placeholder',
    "## Fix written still holds its placeholder: name the fix's commits or patch file, or delete the section when no fix exists",
    '## Questions is empty: it still holds its placeholder',
  ]);
});

test('AC-2, AC-3: a bug in another repo than its task; the accepted task stays byte for byte, done and frozen', async () => {
  const w = await acceptedWorkspace();
  const before = snapshot(taskDir(w));
  const head = sh(w.weather, 'git', ['rev-parse', 'HEAD']);
  newDraft({ ws: w.ws, id: BUG, title: 'Stale map tiles', bugOf: TASK });
  assert.equal(sh(w.hub, 'git', ['status', '--porcelain', '--', 'kirunak/drafts']).trim(), '?? kirunak/drafts/');
  // The fix is a commit of the task's repo, not of the bug's.
  putBug(w, bugText(`- the cache expires [commit ${head.slice(0, 7)}]\n`));
  assert.deepEqual(check(w.ws, BUG), []);
  assert.deepEqual(snapshot(taskDir(w)), before);
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain']), '');
  assert.equal(sh(w.weather, 'git', ['rev-parse', 'HEAD']), head);
  assert.equal(verify(w.ws, TASK), 'ok');
  assert.equal((await taskRows(w.ws, { all: true })).find((r) => r.id === TASK).state, 'done');
});

test('E-1: --bug-of naming no task is refused, a dry run too, and nothing is written', async () => {
  const w = await acceptedWorkspace();
  const nu = (bugOf, dryRun) => () => newDraft({ ws: w.ws, id: BUG, title: 'Stale tiles', bugOf, dryRun });
  const gone = join(rootOf(w), 'kirunak', 'tasks', 'gone', 'task.md');
  for (const dry of [false, true]) {
    assert.throws(nu('weather/gone', dry), (e) => e.code === 1 && e.message === `unknown task weather/gone: ${gone} does not exist; a bug names the accepted task it was found in`);
    assert.throws(nu('radio/gone', dry), (e) => e.code === 1 && e.message === 'unknown repo radio: the workspace lists weather, hub');
    assert.throws(nu('weather/Gone', dry), (e) => e.code === 2 && /^not a task id: weather\/Gone/.test(e.message));
    assert.throws(nu(' ', dry), (e) => e.code === 2 && e.message === '--bug-of names the accepted task the bug was found in: --bug-of <repo>/<slug>');
  }
  assert.equal(existsSync(bugFile(w)), false);
});

test('E-2: --bug-of naming a task not accepted yet is refused, naming its review or an amendment', async () => {
  const w = await makeWorkspace();
  const open = `${TASK} is not accepted yet: a bug found while a task is open goes into that task, through its review or an amendment (k amend new ${TASK} --title "...")`;
  assert.throws(() => newDraft({ ws: w.ws, id: BUG, title: 'Stale tiles', bugOf: TASK }), (e) => e.code === 1 && e.message === open);
  await approve({ ws: w.ws, id: TASK });
  for (const dryRun of [false, true]) {
    assert.throws(() => newDraft({ ws: w.ws, id: BUG, title: 'Stale tiles', bugOf: TASK, dryRun }), (e) => e.code === 1 && e.message === open);
  }
  assert.equal(existsSync(bugFile(w)), false);
});


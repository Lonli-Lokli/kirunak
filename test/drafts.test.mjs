import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, checkDraft, newDraft } from '../lib/drafts.mjs';
import { start } from '../lib/intake.mjs';
import { makeWorkspace, sh } from './helpers.mjs';

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

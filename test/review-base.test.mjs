import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approve } from '../lib/approval.mjs';
import { newAmendment } from '../lib/amend.mjs';
import * as steps from '../lib/steps.mjs';
import { approvedWorkspace, k, sh } from './helpers.mjs';

// What a review sees of a task's work (gulnya/kirunak-review-base): its diff from the first approval whatever the
// amendments (AC-1, AC-5), the task's own change only (AC-6, D-1), the commits naming no task listed (AC-7).

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, AC-3, E-1
inputs: task, diff
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

const OTHER = 'weather/other-thing';

// A file of the weather repo written and committed alone, with that message. → the commit's short hash
function work(w, path, text, message) {
  mkdirSync(join(w.weather, path, '..'), { recursive: true });
  writeFileSync(join(w.weather, path), text);
  sh(w.weather, 'git', ['add', '--', path]);
  sh(w.weather, 'git', ['commit', '-qm', message, '--', path]);
  return sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
}

// The invented task approved with plan.md, and a second task of the weather repo for other work to name.
async function workspace() {
  const w = await approvedWorkspace(PLAN);
  work(w, 'kirunak/tasks/other-thing/task.md', '# another task\n', `kirunak: intake ${OTHER}`);
  const first = sh(w.weather, 'git', ['log', '--diff-filter=A', '--format=%h', '--', 'kirunak/approvals/offline-forecast.json']).trim();
  return { ...w, first };
}

// Amendment A-1 written and approved. → the approval's short hash
async function amend(w) {
  const a = newAmendment({ ws: w.ws, id: w.id, title: 'Hourly forecasts', by: 'session test' });
  const text = readFileSync(a.path, 'utf8')
    .replace('## Why\n', '## Why\nThe provider now returns hourly data. [research docs/offline.md §3]\n')
    .replace('## Changes\n', '## Changes\n- add AC-4: An hourly forecast cut off mid-download shows the hours it has. [research docs/offline.md §3]\n');
  writeFileSync(a.path, text);
  return (await approve({ ws: w.ws, id: w.id, amendment: 'A-1' })).commit;
}

const brief = (w) => steps.brief({ ws: w.ws, id: w.id, step: 'S-2', session: 'rev-1' });
const inPatch = (w) => readFileSync(join(w.p.dir, 'steps', 'S-2', 'in', 'diff.patch'), 'utf8');
const given = (w, step = 'S-2') => JSON.parse(readFileSync(join(w.p.dir, 'steps', step, 'given.json'), 'utf8'));
const files = (patch) => [...patch.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]);

test('a task approved, amended and then reviewed: the diff starts at the first approval and holds the work done before the amendment (AC-1, AC-3, AC-5)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'the cache keeps three days\n', `docs/offline.md: three days (${w.id} S-1)`);
  const amended = await amend(w);
  assert.notEqual(amended, w.first);
  work(w, 'src/hourly.txt', 'hourly\n', `src/hourly.txt (${w.id} S-1)`);
  const { text } = await brief(w);
  const patch = inPatch(w);
  assert.match(patch, /\+the cache keeps three days/, 'the work done before the amendment');
  assert.match(patch, /\+hourly/, 'and after it');
  assert.deepEqual(files(patch), ['docs/offline.md', 'src/hourly.txt'], 'no record: not the approval, the amendment or task.md');
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  assert.ok(text.includes(`from its first approval ${w.first} to head ${head}`), 'the first approval, where the diff starts');
  assert.ok(text.includes(`A-1, the last amendment, was approved in ${amended}`), 'the last amendment\'s approval');
  assert.ok(text.includes(`\`git diff ${amended} ${head}\``), 'what changed since it');
  assert.ok(text.includes(`base: ${w.first}`), 'the review\'s base is the first approval');
  assert.deepEqual(given(w), { base: w.first, amendment: { id: 'A-1', commit: amended }, head, repos: [] });
});

test('a task never amended: the brief names its first approval only (E-1)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'the cache keeps three days\n', `docs/offline.md (${w.id})`);
  const { text } = await brief(w);
  assert.ok(text.includes(`from its first approval ${w.first} to head`));
  assert.doesNotMatch(text, /amendment, was approved|amended after/);
  assert.equal(given(w).amendment, null);
});

test('the diff holds the task\'s own change: commits naming it or naming no task, never one naming only another task, nor records (AC-6, D-1, E-2, E-3)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'the cache keeps three days\n', `docs/offline.md (${w.id} S-1)`);
  work(w, 'src/other.txt', 'other\n', `src/other.txt (${OTHER} S-1)`);
  work(w, 'src/trailer.txt', 'trailer\n', `src/trailer.txt\n\nTask: ${OTHER}`);
  work(w, 'src/both.txt', 'both\n', `src/both.txt, for ${w.id} and ${OTHER}`);
  work(w, 'src/both-trailer.txt', 'both\n', `src/both-trailer.txt, for offline-forecast too\n\nTask: ${OTHER}`);
  work(w, 'src/stray.txt', 'stray\n', 'src/stray.txt: a fix naming nothing');
  work(w, 'kirunak/tasks/other-thing/notes.md', 'notes\n', 'notes, naming no task');
  work(w, 'kirunak/drafts/later.md', 'a draft\n', 'a draft, naming no task');
  await brief(w);
  const patch = inPatch(w);
  assert.deepEqual(files(patch), ['docs/offline.md', 'src/both-trailer.txt', 'src/both.txt', 'src/stray.txt']);
  assert.doesNotMatch(patch, /other-thing|kirunak\/drafts|offline-forecast\//, 'records never');
});

test('another task\'s commit to a file of the task\'s own change is in the diff, the file diffed once (AC-6)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'the cache keeps three days\n', `docs/offline.md (${w.id})`);
  work(w, 'docs/offline.md', 'the cache keeps three days\nand a week of history\n', `docs/offline.md (${OTHER})`);
  await brief(w);
  const patch = inPatch(w);
  assert.deepEqual(files(patch), ['docs/offline.md']);
  assert.match(patch, /\+and a week of history/);
});

test('a merge is not judged itself: each commit it brings in is (E-4)', async () => {
  const w = await workspace();
  sh(w.weather, 'git', ['checkout', '-qb', 'side']);
  work(w, 'src/side-other.txt', 'other\n', `src/side-other.txt (${OTHER})`);
  work(w, 'src/side-own.txt', 'own\n', `src/side-own.txt (${w.id})`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', `Merge side (${w.id})`, 'side']);
  await brief(w);
  assert.deepEqual(files(inPatch(w)), ['src/side-own.txt'], 'the merge naming the task takes in none of the other task\'s files');
});

test('the brief lists each commit in the diff that names no task, with its hash, subject and files (AC-7)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'x\n', `docs/offline.md (${w.id})`);
  const stray = work(w, 'src/stray.txt', 'stray\n', 'src/stray.txt: a fix naming nothing\n\nIts body.');
  work(w, 'src/other.txt', 'other\n', `src/other.txt (${OTHER})`);
  work(w, 'kirunak/drafts/later.md', 'a draft\n', 'a draft, naming no task');
  const { text } = await brief(w);
  assert.match(text, /## Commits that name no task/);
  const listed = text.split('\n').filter((l) => /^- weather `/.test(l));
  assert.deepEqual(listed, [`- weather \`${stray}\` src/stray.txt: a fix naming nothing: src/stray.txt`]);
});

test('no commit naming no task: the brief has no such list', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'x\n', `docs/offline.md (${w.id})`);
  const { text } = await brief(w);
  assert.doesNotMatch(text, /Commits that name no task|\{\{/);
});

test('a step that is not a review and takes diff gets the same base, the first approval, and the whole repo as before (AC-2)', async () => {
  const w = await workspace();
  work(w, 'docs/offline.md', 'the cache keeps three days\n', `docs/offline.md (${w.id})`);
  await amend(w);
  work(w, 'src/other.txt', 'other\n', `src/other.txt (${OTHER})`);
  const started = k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']);
  assert.equal(started.status, 0, started.stderr);
  const patch = readFileSync(join(w.p.dir, 'steps', 'S-1', 'diff.patch'), 'utf8');
  assert.match(patch, /\+the cache keeps three days/, 'the work before the amendment');
  assert.match(patch, /\+other/, 'the rest of the repo, as before');
  assert.doesNotMatch(patch, /--- \/dev\/null\n\+\+\+ b\/kirunak\/approvals\/offline-forecast\.json/, 'the first approval is the base: its record is not new here');
});

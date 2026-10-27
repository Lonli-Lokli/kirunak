import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept, approve, hashBytes, hold, readRecord, resume, verify } from '../lib/approval.mjs';
import { applyAmendment, checkAmendment, decline, newAmendment, parseAmendment } from '../lib/amend.mjs';
import { log1 } from '../lib/git.mjs';
import * as queue from '../lib/queue.mjs';
import { generate } from '../lib/checklist.mjs';
import { checkTaskDir } from '../lib/state.mjs';
import { checkTask, parseTask } from '../lib/task.mjs';
import { gitCommitAll, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

// Commits in the test repos must not inherit an owner variable from the shell that runs the tests.
for (const k of Object.keys(process.env)) if (k.startsWith('KIRUNAK_') && k !== 'KIRUNAK_HOME') delete process.env[k];

const ID = 'weather/offline-forecast';
const ASPECTS = ['platforms', 'large-text', 'offline'];
const NOV5 = new Date(2026, 10, 5, 9, 12, 0);
const NOV6 = new Date(2026, 10, 6, 10, 0, 0);
const NOV7 = new Date(2026, 10, 7, 11, 30, 0);
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const subject = (dir) => sh(dir, 'git', ['log', '-1', '--format=%s']).trim();
const taskFile = (weather) => join(weather, 'kirunak/tasks/offline-forecast/task.md');
const amendmentFile = (weather, n) => join(weather, `kirunak/tasks/offline-forecast/amendments/A-${n}.md`);
const taskDir = (weather) => join(weather, 'kirunak/tasks/offline-forecast');

const A1 = `---
task: weather/offline-forecast
proposed: 2026-11-04
title: Hourly forecasts
by: session test
---

## Why
The provider now returns hourly data. [research docs/offline.md §3]

## Changes
- replace D-1: Keep the last three days of forecasts, hourly for the first day. [research docs/offline.md §3]
- add AC-4: An hourly forecast cut off mid-download shows the hours it has. [research docs/offline.md §3]
- remove E-1
- replace offline: in (AC-1, AC-4) [research docs/offline.md §3]
`;

// Fills a skeleton the way the model would: the why and the operations under their headings.
function fill(path, why, changes) {
  const text = readFileSync(path, 'utf8')
    .replace('## Why\n', `## Why\n${why}\n`)
    .replace('## Changes\n', `## Changes\n${changes.join('\n')}\n`);
  writeFileSync(path, text);
}

function editTask(weather, from, to) {
  const p = taskFile(weather);
  const text = readFileSync(p, 'utf8');
  assert.ok(text.includes(from), `fixture has ${from}`);
  writeFileSync(p, text.replace(from, to));
}

test('the hash equals shasum -a 256 of task.md', async () => {
  const { ws, weather } = await makeWorkspace();
  const r = await approve({ ws, id: ID, now: NOV5 });
  const shasum = sh(weather, 'shasum', ['-a', '256', taskFile(weather)]).split(/\s+/)[0];
  assert.equal(r.hash, `sha256:${shasum}`);
  assert.equal(readRecord(weather, 'offline-forecast').hash, `sha256:${shasum}`);
});

test('approve writes the record and its history, commits it, queues the task and logs the event', async () => {
  const { ws, weather, hub, home } = await makeWorkspace();
  const before = log1(weather, 'kirunak/tasks/offline-forecast/task.md');
  const r = await approve({ ws, id: ID, now: NOV5 });
  const rec = readRecord(weather, 'offline-forecast');
  assert.deepEqual(Object.keys(rec), ['task', 'hash', 'approved', 'by', 'via', 'commit', 'history']);
  assert.equal(rec.task, ID);
  assert.match(rec.approved, ISO_LOCAL);
  assert.ok(rec.approved.startsWith('2026-11-05T09:12:00'));
  assert.equal(rec.by, 'owner');
  assert.equal(rec.via, 'shell');
  assert.equal(rec.commit, before);
  assert.deepEqual(rec.history, [{ hash: rec.hash, approved: rec.approved, amendment: null }]);
  assert.equal(subject(weather), `kirunak: approve ${ID}`);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '');
  const files = sh(weather, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['kirunak/approvals/offline-forecast.json']);
  assert.equal(subject(hub), `kirunak: queue add ${ID}`);
  assert.deepEqual(queue.read(ws), [ID]);
  assert.deepEqual(r, { hash: rec.hash, commit: sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim(), state: 'queued', queuePlace: 1 });
  assert.equal(verify(ws, ID), 'ok');
  const events = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events, [{ time: rec.approved, kind: 'approved', task: ID, amendment: null }]);
});

test('one changed byte makes verify say stale', async () => {
  const { ws, weather } = await makeWorkspace();
  assert.equal(verify(ws, ID), 'none');
  await approve({ ws, id: ID, now: NOV5 });
  const p = taskFile(weather);
  const buf = readFileSync(p);
  buf[buf.length - 2] = buf[buf.length - 2] ^ 1;
  writeFileSync(p, buf);
  assert.equal(verify(ws, ID), 'stale');
});

test('approve refuses with a question open', async () => {
  const { ws, weather } = await makeWorkspace();
  editTask(weather, '## Open questions\n', '## Open questions\n- Q-9 Keep forecasts for a week?\n');
  gitCommitAll(weather, 'intake');
  await assert.rejects(approve({ ws, id: ID, now: NOV5 }), /Q-9 is open/);
  assert.equal(readRecord(weather, 'offline-forecast'), null);
});

test('approve refuses a task that fails k check, naming the line', async () => {
  const { ws, weather } = await makeWorkspace();
  editTask(weather, ' own time format. [owner 2026-11-02 Q-2]', ' own time format.');
  gitCommitAll(weather, 'intake');
  await assert.rejects(approve({ ws, id: ID, now: NOV5 }), /fails k check:\n {2}line 13: no source/);
  assert.equal(readRecord(weather, 'offline-forecast'), null);
});

test('approve refuses an uncommitted task', async () => {
  const { ws, weather } = await makeWorkspace();
  editTask(weather, 'title: The last forecast stays readable offline', 'title: The last forecast stays readable');
  await assert.rejects(approve({ ws, id: ID, now: NOV5 }), /task.md is not committed/);
  assert.equal(readRecord(weather, 'offline-forecast'), null);
});

test('approve refuses a second approval without an amendment', async () => {
  const { ws } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  await assert.rejects(approve({ ws, id: ID, now: NOV6 }), /already approved .*--amendment A-n/);
});

test('approve takes a queue place, or none, and refuses a place it cannot find before writing', async () => {
  const { ws, weather, hub } = await makeWorkspace();
  writeFileSync(ws.queue, '# The queue: one task id per line, in order.\nhub/other\n');
  gitCommitAll(hub, 'queue');
  await assert.rejects(approve({ ws, id: ID, queuePlace: { before: 'hub/missing' }, now: NOV5 }), /hub\/missing is not in the queue/);
  assert.equal(readRecord(weather, 'offline-forecast'), null);
  const r = await approve({ ws, id: ID, queuePlace: { first: true }, now: NOV5 });
  assert.deepEqual([r.state, r.queuePlace], ['queued', 1]);
  assert.deepEqual(queue.read(ws), [ID, 'hub/other']);

  const other = await makeWorkspace();
  const r2 = await approve({ ws: other.ws, id: ID, noQueue: true, now: NOV5 });
  assert.deepEqual([r2.state, r2.queuePlace], ['parked', null], 'approved out of the queue: parked');
  assert.deepEqual(queue.read(other.ws), []);
  assert.equal(subject(other.hub), 'fixture');
});

test("an amendment's replace, add and remove apply", async () => {
  const { weather } = await makeWorkspace();
  const before = readFileSync(taskFile(weather), 'utf8');
  const after = applyAmendment(before, A1);
  assert.ok(!after.includes('- D-1 Keep the last three days of forecasts, no more.'));
  assert.ok(after.includes('- D-1 Keep the last three days of forecasts, hourly for the first day. [research docs/offline.md §3]\n'));
  assert.ok(after.includes(
    'restart. [owner 2026-11-02 Q-3]\n- AC-4 An hourly forecast cut off mid-download shows the hours it has. [research docs/offline.md §3]\n\n## Edge cases\n\n## Out of scope\n',
  ));
  assert.ok(!after.includes('E-1'));
  assert.ok(after.includes('- offline: in (AC-1, AC-4) [research docs/offline.md §3]\n'));
  assert.deepEqual(checkTask(parseTask(after), ASPECTS, { removed: new Set(['E-1']) }), []);
  assert.deepEqual(parseAmendment(A1).changes.map((c) => `${c.op} ${c.id}`), ['replace D-1', 'add AC-4', 'remove E-1', 'replace offline']);
});

test('checkAmendment: ids exist, the added number is the next free one, every new line is sourced', async () => {
  const { weather } = await makeWorkspace();
  const task = readFileSync(taskFile(weather), 'utf8');
  assert.deepEqual(checkAmendment(task, A1), []);
  const bad = A1.replace('## Changes\n', '## Changes\n- replace D-4: Nothing. [research docs/offline.md]\n- add E-3: Skips. [research docs/offline.md]\n- add O-2: No source.\n- remove AC-9\n- rename AC-1\n');
  const problems = checkAmendment(task, bad).map((x) => x.problem);
  assert.ok(problems.includes('replace D-4: the task has no D-4'));
  assert.ok(problems.includes('add E-3: E-3 is taken or skips a number; the next free is E-2'));
  assert.ok(problems.some((p) => p.startsWith('add O-2: the new line names no source')));
  assert.ok(problems.includes('remove AC-9: the task has no AC-9'));
  assert.ok(problems.some((p) => p.startsWith('not an operation')));
  const other = A1.replace('task: weather/offline-forecast', 'task: weather/other');
  assert.ok(checkAmendment(task, other).some((x) => x.problem === 'task weather/other is not weather/offline-forecast'));
  const empty = '---\ntask: weather/offline-forecast\nproposed: 2026-11-04\ntitle: Nothing yet\nby: session test\n---\n\n## Why\n\n## Changes\n';
  assert.deepEqual(checkAmendment(task, empty).map((x) => x.problem), ['Why is empty: say why the task must change', 'Changes has no operation']);
});

test('a removed number is never reused', async () => {
  const { weather } = await makeWorkspace();
  const task = applyAmendment(readFileSync(taskFile(weather), 'utf8'), A1);
  const reuse = A1.replace(/## Changes\n[\s\S]*$/, '## Changes\n- add E-1: Reused. [research docs/offline.md]\n');
  const problems = checkAmendment(task, reuse, { removed: new Set(['E-1']) }).map((x) => x.problem);
  assert.deepEqual(problems, ['add E-1: E-1 was removed and a number is never reused; the next free is E-2']);
  const fresh = reuse.replace('add E-1: Reused.', 'add E-2: Fresh.');
  assert.deepEqual(checkAmendment(task, fresh, { removed: new Set(['E-1']) }), []);
});

test('a full amendment cycle: apply, re-hash, history, stamp, and the next edge case takes a fresh number', async () => {
  const { ws, weather, hub } = await makeWorkspace();
  const first = await approve({ ws, id: ID, now: NOV5 });

  const a1 = newAmendment({ ws, id: ID, title: 'Hourly forecasts', by: 'session test', now: NOV6 });
  assert.equal(a1.n, 1);
  assert.equal(realpathSync(a1.path), realpathSync(amendmentFile(weather, 1)));
  assert.equal(readFileSync(a1.path, 'utf8'), '---\ntask: weather/offline-forecast\nproposed: 2026-11-06\ntitle: Hourly forecasts\nby: session test\n---\n\n## Why\n\n## Changes\n');
  fill(a1.path, 'The provider now returns hourly data. [research docs/offline.md §3]', A1.split('## Changes\n')[1].trim().split('\n'));

  const hubHead = sh(hub, 'git', ['rev-parse', 'HEAD']).trim();
  const r = await approve({ ws, id: ID, amendment: 'A-1', now: NOV6 });
  assert.notEqual(r.hash, first.hash);
  assert.deepEqual([r.state, r.queuePlace], ['queued', 1]);
  assert.equal(sh(hub, 'git', ['rev-parse', 'HEAD']).trim(), hubHead, 'already queued: no queue commit');
  assert.equal(subject(weather), `kirunak: approve ${ID} amendment A-1`);
  const files = sh(weather, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, [
    'kirunak/approvals/offline-forecast.json',
    'kirunak/tasks/offline-forecast/amendments/A-1.md',
    'kirunak/tasks/offline-forecast/task.md',
  ]);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '');
  assert.deepEqual(checkTaskDir(taskDir(weather), ASPECTS, ID).problems, []);
  assert.equal(verify(ws, ID), 'ok');
  const rec = readRecord(weather, 'offline-forecast');
  assert.equal(rec.hash, hashBytes(readFileSync(taskFile(weather))));
  assert.equal(rec.history.length, 2);
  assert.deepEqual(rec.history[0], { hash: first.hash, approved: rec.history[0].approved, amendment: null });
  assert.deepEqual(rec.history[1], { hash: rec.hash, approved: rec.approved, amendment: 'A-1' });
  assert.match(readFileSync(a1.path, 'utf8'), /^by: session test\napplied: 2026-11-06\n---\n/m);

  const a2 = newAmendment({ ws, id: ID, title: 'A cut download', by: 'session test', now: NOV7 });
  assert.equal(a2.n, 2);
  fill(a2.path, 'A cut download needs its own edge case. [owner 2026-11-02 Q-4]', ['- add E-1: A cut download says so. [owner 2026-11-02 Q-4]']);
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-2', now: NOV7 }), /E-1 was removed and a number is never reused; the next free is E-2/);
  writeFileSync(a2.path, readFileSync(a2.path, 'utf8').replace('add E-1:', 'add E-2:'));
  await approve({ ws, id: ID, amendment: 2, now: NOV7 });
  const text = readFileSync(taskFile(weather), 'utf8');
  assert.ok(text.includes('## Edge cases\n- E-2 A cut download says so. [owner 2026-11-02 Q-4]\n\n## Out of scope\n'));
  assert.deepEqual(checkTaskDir(taskDir(weather), ASPECTS, ID).problems, []);
  assert.equal(verify(ws, ID), 'ok');
  assert.deepEqual(readRecord(weather, 'offline-forecast').history.map((h) => h.amendment), [null, 'A-1', 'A-2']);
});

test('approve refuses a failing amendment, a stamped one, and one whose result fails k check, changing nothing', async () => {
  const { ws, weather } = await makeWorkspace();
  newAmendment({ ws, id: ID, title: 'Drop E-1', now: NOV6 });
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV6 }), /has no approval yet/);
  await approve({ ws, id: ID, now: NOV5 });
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV6 }), /A-1 does not apply:\n.*Why is empty/);

  // Removing E-1 alone leaves the offline aspect naming a line that is gone.
  fill(amendmentFile(weather, 1), 'E-1 is covered elsewhere. [owner 2026-11-02 Q-4]', ['- remove E-1']);
  const task = readFileSync(taskFile(weather));
  const am = readFileSync(amendmentFile(weather, 1));
  const head = sh(weather, 'git', ['rev-parse', 'HEAD']).trim();
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV6 }), /A-1 applied fails k check:\n.*aspect offline: in names E-1/);
  assert.deepEqual(readFileSync(taskFile(weather)), task);
  assert.deepEqual(readFileSync(amendmentFile(weather, 1)), am);
  assert.equal(sh(weather, 'git', ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(verify(ws, ID), 'ok');

  writeFileSync(amendmentFile(weather, 1), stampedText(readFileSync(amendmentFile(weather, 1), 'utf8')));
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV6 }), /A-1 was already applied on 2026-11-06/);
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-9', now: NOV6 }), /has no amendment A-9/);
});

const stampedText = (t) => t.replace('by: session\n---', 'by: session\napplied: 2026-11-06\n---');

test('decline stamps declined: with the date and why, commits it, and the amendment cannot be applied after', async () => {
  const { ws, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const a = newAmendment({ ws, id: ID, title: 'A week', by: 'session test', now: NOV6 });
  fill(a.path, 'Hourly data. [research docs/offline.md §3]', ['- replace D-1: Keep a week. [research docs/offline.md §3]']);
  await assert.throws(() => decline({ ws, id: ID, amendment: 'A-1', why: ' ', now: NOV7 }), /needs its reason/);
  const r = decline({ ws, id: ID, amendment: 'A-1', why: 'three days is enough', now: NOV7 });
  assert.equal(r.amendment, 'A-1');
  assert.match(readFileSync(a.path, 'utf8'), /^by: session test\ndeclined: 2026-11-07 three days is enough\n---\n/m);
  assert.equal(subject(weather), `kirunak: decline ${ID} A-1`);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '');
  assert.throws(() => decline({ ws, id: ID, amendment: 'A-1', why: 'again', now: NOV7 }), /already declined/);
  await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV7 }), /already declined: 2026-11-07 three days is enough/);
  assert.equal(readRecord(weather, 'offline-forecast').history.length, 1);
  assert.equal(newAmendment({ ws, id: ID, title: 'Next', now: NOV7 }).n, 2);
});

// An amendment's name in every list (kirunak-phone A-8, AC-2).
const NO_TITLE = 'front matter has no title: add `title: <a few words>` to its front matter, the name it goes by in every list';

test('k amend new writes its title between proposed and by, and without --title refuses naming the flag, a dry run too (kirunak-phone A-8)', async () => {
  const { ws, home, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const run = (args) => k(home, args, { CLAUDE_CODE_SESSION_ID: '' });
  for (const args of [['amend', 'new', ID], ['amend', 'new', ID, '--title', '  '], ['amend', 'new', ID, '--dry-run']]) {
    const r = run(args);
    assert.deepEqual([r.status, r.stderr], [2, 'k: k amend new needs --title "<a few words>", the name the amendment goes by in every list\n'], args.join(' '));
  }
  assert.throws(() => newAmendment({ ws, id: ID, now: NOV6 }), /an amendment needs its title, .*--title "<title>"/);
  assert.equal(existsSync(amendmentFile(weather, 1)), false);
  assert.equal(run(['amend', 'new', ID, '--title', 'Hourly', '--dry-run']).stdout, 'would write the next amendment in kirunak/tasks/offline-forecast/amendments, titled Hourly\n');

  const r = run(['amend', 'new', ID, '--title', ' Hourly   forecasts ', '--by', 'session s1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(amendmentFile(weather, 1), 'utf8'), /^---\ntask: weather\/offline-forecast\nproposed: \d{4}-\d{2}-\d{2}\ntitle: Hourly forecasts\nby: session s1\n---\n\n## Why\n/);
});

test('k amend check and k approve --amendment refuse a waiting amendment with no title, naming the fix; an applied or declined one is history (kirunak-phone A-8)', async () => {
  const { ws, home, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const run = (args) => k(home, args, { CLAUDE_CODE_SESSION_ID: '' });
  const task = readFileSync(taskFile(weather), 'utf8');
  const a = newAmendment({ ws, id: ID, title: 'Hourly forecasts', now: NOV6 });
  fill(a.path, 'Hourly data. [research docs/offline.md §3]', ['- replace D-1: Keep three days, the first hourly. [research docs/offline.md §3]']);
  const titled = readFileSync(a.path, 'utf8');

  for (const untitled of [titled.replace('title: Hourly forecasts\n', ''), titled.replace('title: Hourly forecasts', 'title:  ')]) {
    assert.deepEqual(checkAmendment(task, untitled), [{ line: 1, problem: NO_TITLE }]);
    writeFileSync(a.path, untitled);
    const check = run(['amend', 'check', ID, 'A-1']);
    assert.deepEqual([check.status, check.stderr], [1, `${ID} A-1: 1 problem\n  A-1.md line 1: ${NO_TITLE}\n`]);
    const dry = run(['approve', ID, '--amendment', 'A-1', '--dry-run']);
    assert.deepEqual([dry.status, dry.stderr], [1, `would refuse ${ID}:\n  ${ID} A-1 does not apply: line 1: ${NO_TITLE}\n`]);
    await assert.rejects(approve({ ws, id: ID, amendment: 'A-1', now: NOV6 }), new RegExp(`A-1 does not apply:\\n.*front matter has no title`));
  }
  assert.equal(readFileSync(taskFile(weather), 'utf8'), task);

  // Titled, it is approved; stamped, it is history, and a stamp is all that refuses it, title or none.
  writeFileSync(a.path, titled);
  assert.equal(run(['amend', 'check', ID, 'A-1']).stdout, `${ID} A-1: check passes\n`);
  await approve({ ws, id: ID, amendment: 'A-1', now: NOV6 });
  const applied = readFileSync(a.path, 'utf8').replace('title: Hourly forecasts\n', '');
  assert.deepEqual(checkAmendment(task, applied).map((x) => x.problem), ['already applied on 2026-11-06']);
  const declined = titled.replace('title: Hourly forecasts\n', '').replace('by: session\n', 'by: session\ndeclined: 2026-11-07 not now\n');
  assert.deepEqual(checkAmendment(task, declined).map((x) => x.problem), ['already declined: 2026-11-07 not now']);
});

const headOf = (repo) => sh(repo, 'git', ['rev-parse', '--short', 'HEAD']).trim();

// A review of the invented task at the commit head: AC-3 for a device, E-1 for the owner, or every row met.
const REVIEW = (head, verdict, needs = true) => `---
task: ${ID}
head: ${head}
---

| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | file docs/offline.md:1 |
| AC-2 | met | file docs/offline.md:1 |
| AC-3 | ${needs ? 'needs device | On a phone: restart offline' : 'met | file docs/offline.md:1'} |
| E-1 | ${needs ? 'needs owner | Read: the age line' : 'met | file docs/offline.md:1'} |

${verdict}
`;

test('accept: refuses with no review, even with --checklist-open; writes done.json, leaves the queue', async () => {
  const { ws, weather, hub, home } = await makeWorkspace();
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'no review yet' }), /never approved/);
  await approve({ ws, id: ID, now: NOV5 });
  assert.throws(() => accept({ ws, id: ID }), /has no review, so it cannot be accepted: add a review step to plan\.md and run it$/);
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'no review yet' }), /has no review/);
  reviewsRan(taskDir(weather));
  const reviewed = headOf(weather);
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(reviewed, 'verdict: pass', false));
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'no review yet' }), /review\.md is not a review k accept takes:\n {2}line 13: verdict: pass is not verdict: met/);
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(reviewed, 'verdict: met', false));
  reviewsRan(taskDir(weather));
  gitCommitAll(weather, 'review');
  const head = sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const r = accept({ ws, id: ID, via: 'mod', now: NOV7 });
  assert.equal(r.state, 'done');
  const done = JSON.parse(readFileSync(join(taskDir(weather), 'done.json'), 'utf8'));
  assert.deepEqual(Object.keys(done), ['task', 'accepted', 'by', 'via', 'commit', 'review', 'verdict', 'head', 'reviewHash']);
  assert.equal(done.task, ID);
  assert.match(done.accepted, ISO_LOCAL);
  assert.equal(done.by, 'owner');
  assert.equal(done.via, 'mod');
  assert.equal(done.commit, head);
  assert.equal(done.review, 'review.md');
  assert.equal(done.verdict, 'met');
  assert.equal(done.head, reviewed, 'the head as the review states it');
  assert.equal(done.reviewHash, hashBytes(readFileSync(join(taskDir(weather), 'review.md'))));
  assert.equal(subject(weather), `kirunak: accept ${ID}`);
  assert.equal(subject(hub), `kirunak: queue remove ${ID}`);
  assert.deepEqual(queue.read(ws), []);
  assert.match(readFileSync(join(home, 'events.jsonl'), 'utf8'), /"kind":"accepted"/);
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'again' }), /already accepted/);
});

test('accept with a review: every item the owner checks is ticked, or it refuses naming them; --checklist-open is recorded', async () => {
  const { ws, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(headOf(weather), 'verdict: needs owner (AC-3, E-1)'));
  reviewsRan(taskDir(weather));
  gitCommitAll(weather, 'review');
  assert.throws(() => accept({ ws, id: ID }), new RegExp(`2 unticked item\\(s\\), 2 not in checklist\\.md yet \\(k checklist ${ID} writes them from review\\.md\\):\n {2}- \\[ \\] AC-3 On a phone: restart offline \\(review\\.md\\)\n {2}- \\[ \\] E-1`));
  generate(ws, ID);
  assert.throws(() => accept({ ws, id: ID }), /checklist\.md has 2 unticked item\(s\):\n {2}- \[ \] AC-3 On a phone: restart offline \(review\.md\)\n {2}- \[ \] E-1 Read: the age line \(review\.md\)$/);
  const file = join(taskDir(weather), 'checklist.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] AC-3', '- [x] AC-3'));
  assert.throws(() => accept({ ws, id: ID }), /checklist\.md has 1 unticked item\(s\):\n {2}- \[ \] E-1 Read: the age line \(review\.md\)$/);
  assert.throws(() => accept({ ws, id: ID, checklistOpen: '  ' }), /needs its reason/);
  // Left open: AC-3 unticked again, and E-1's item gone from checklist.md.
  writeFileSync(file, '- [ ] AC-3 On a phone: restart offline (review.md)\n');
  gitCommitAll(weather, 'ticked');
  accept({ ws, id: ID, checklistOpen: 'the age line is read at the next release', now: NOV7 });
  const done = JSON.parse(readFileSync(join(taskDir(weather), 'done.json'), 'utf8'));
  assert.deepEqual(Object.keys(done), ['task', 'accepted', 'by', 'via', 'commit', 'review', 'verdict', 'head', 'reviewHash', 'checklistOpen', 'openItems']);
  assert.equal(done.via, 'shell');
  assert.equal(done.verdict, 'needs owner (AC-3, E-1)');
  assert.equal(done.checklistOpen, 'the age line is read at the next release');
  assert.deepEqual(done.openItems, ['AC-3 On a phone: restart offline (review.md)', 'E-1 Read: the age line (review.md)']);
});

test('a valued flag never takes --dry-run as its value, so a line the freeze hook lets through as a dry run never runs for real (review G24)', async () => {
  const { ws, home, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(headOf(weather), 'verdict: met', false));
  reviewsRan(taskDir(weather));
  gitCommitAll(weather, 'review');
  const head = headOf(weather);
  for (const args of [['accept', ID, '--checklist-open', '--dry-run'], ['hold', ID, '--why', '--dry-run'], ['approve', ID, '--before', '--dry-run'], ['accept', ID, '--checklist-open=--dry-run']]) {
    const r = k(home, args, { CLAUDE_CODE_SESSION_ID: '' });
    assert.deepEqual([r.status, r.stderr], [2, `k: --${args[2].slice(2).split('=')[0]} needs a value, not --dry-run\n`], args.join(' '));
  }
  assert.deepEqual([existsSync(join(taskDir(weather), 'done.json')), existsSync(join(taskDir(weather), 'hold.md')), headOf(weather)], [false, false, head]);
  assert.equal(k(home, ['accept', ID, '--dry-run'], { CLAUDE_CODE_SESSION_ID: '' }).stdout, `would accept ${ID} (review.md, verdict: met)\n`);
});

test('k waiting and k accept --dry-run make every check of the owner\'s verbs and write nothing', async () => {
  const { ws, home, weather } = await makeWorkspace();
  const run = (args) => k(home, args, { CLAUDE_CODE_SESSION_ID: '' });
  const waiting = () => JSON.parse(run(['waiting', '--json']).stdout);
  const first = waiting();
  const title = first.approve[0].title;
  const rows = { bugs: { count: 0, ready: 0, ids: [] }, amendments: [], hold: [{ id: ID, title, state: 'proposed' }], start: [{ id: ID, title, state: 'proposed' }], drafts: { count: 0, ids: [] }, stopped: [] };
  assert.deepEqual(first, { approve: [{ id: ID, title, state: 'proposed', why: null }], accept: [], ...rows });
  await approve({ ws, id: ID, now: NOV5 });
  // A step that asked the owner a question, with no review yet: awaiting the owner, and nothing to accept (G26).
  writeFileSync(join(taskDir(weather), 'plan.md'), '### S-1 Build [agent]\ncovers: all\ninputs: task\noutputs: steps/S-1/report.md\n\n### S-2 Review [review]\nneeds: S-1\ncovers: all\ninputs: task, diff\noutputs: review.md\n');
  writeFileSync(join(taskDir(weather), 'progress.md'), '2026-11-06 09:00 S-1 started\n');
  mkdirSync(join(taskDir(weather), 'steps', 'S-1'), { recursive: true });
  writeFileSync(join(taskDir(weather), 'steps', 'S-1', 'needs.json'), JSON.stringify({ owner: 'Three days or a week?' }));
  assert.equal(JSON.parse(run(['list', '--json']).stdout).rows[0].state, 'awaiting owner');
  const asked = waiting();
  assert.deepEqual([asked.approve, asked.accept], [[], []]);
  rmSync(join(taskDir(weather), 'steps'), { recursive: true });
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(headOf(weather), 'verdict: needs owner (AC-3, E-1)'));
  reviewsRan(taskDir(weather));
  generate(ws, ID);
  gitCommitAll(weather, 'review and checklist');
  const head = headOf(weather);
  const w = waiting();
  assert.deepEqual(w.approve, []);
  assert.deepEqual(w.accept.map((x) => x.id), [ID]);
  assert.match(w.accept[0].why, /checklist\.md has 2 unticked item\(s\)/);
  assert.deepEqual([w.accept[0].state, w.accept[0].checklistOpen, w.accept[0].onlyChecklist], ['awaiting owner', 2, true]);
  const dry = run(['accept', ID, '--dry-run']);
  assert.deepEqual([dry.status, /checklist\.md has 2 unticked item\(s\)/.test(dry.stderr)], [1, true]);
  const open = run(['accept', ID, '--dry-run', '--checklist-open', 'read on the phone later']);
  assert.equal(open.stdout, `would accept ${ID} (review.md, verdict: needs owner (AC-3, E-1)), with 2 checklist item(s) open\n`);
  const file = join(taskDir(weather), 'checklist.md');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'));
  gitCommitAll(weather, 'ticked');
  assert.equal(waiting().accept[0].why, null);
  assert.match(run(['waiting']).stdout, /^nothing to approve\nno amendment to approve\nto accept:\n {2}weather\/offline-forecast {2}can accept\nno draft waits for the owner's intake\n$/);
  assert.deepEqual([existsSync(join(taskDir(weather), 'done.json')), sh(weather, 'git', ['log', '-1', '--format=%s']).trim()], [false, 'ticked']);
  assert.notEqual(headOf(weather), head);
});

test('accept refuses a not met verdict, --checklist-open or not: the way out is an amendment or a new review', async () => {
  const { ws, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const notMet = REVIEW(headOf(weather), 'verdict: not met (AC-2)', false).replace('| AC-2 | met | file docs/offline.md:1 |', '| AC-2 | not met | a fixed 24-hour format |');
  writeFileSync(join(taskDir(weather), 'review.md'), notMet);
  reviewsRan(taskDir(weather));
  gitCommitAll(weather, 'review');
  const way = new RegExp(`review\\.md ends verdict: not met \\(AC-2\\), which k accept never takes: amend the task \\(k amend new ${ID} --title "<a few words>"\\) and review again, or run a new review$`);
  assert.throws(() => accept({ ws, id: ID }), way);
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'AC-2 later' }), way);
  assert.equal(existsSync(join(taskDir(weather), 'done.json')), false);
});

// A commit made with a message, adding or changing each of `files` (relative to the repo) first.
const commitFiles = (repo, message, files) => {
  for (const f of files) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), `${message}\n`, { flag: 'a' });
  }
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-q', '-m', message]);
  return headOf(repo);
};

test('accept refuses a later commit to a file of the task\'s own change, naming file, commit and task; other work and records never block (accept-shared-repo AC-1, AC-2, AC-5, AC-6)', async () => {
  const { ws, weather } = await makeWorkspace();
  const dir = taskDir(weather);
  // Before the first approval, a commit naming the task is not its own change (D-1).
  commitFiles(weather, 'offline-forecast: a sketch before the approval', ['src/early.ts']);
  await approve({ ws, id: ID, now: NOV5 });
  commitFiles(weather, `${ID} S-1: the cache`, ['src/cache.ts']);
  commitFiles(weather, 'the age line, for offline-forecast', ['docs/offline.md']);
  commitFiles(weather, 'a chart for weather/hourly', ['src/chart.ts']);
  const reviewed = headOf(weather);
  writeFileSync(join(dir, 'review.md'), REVIEW(reviewed, 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, `kirunak/tasks/offline-forecast: the review (${ID})`);
  // Other work after the review: files the task's own change never touched, another task's folder, the drafts and the
  // approvals, even when its message names the task (AC-2, AC-5).
  commitFiles(weather, 'the chart again (weather/hourly)', ['src/chart.ts']);
  commitFiles(weather, 'no task: the early sketch again', ['src/early.ts']);
  commitFiles(weather, `notes on ${ID}`, ['kirunak/tasks/hourly/notes.md', 'kirunak/drafts/later.md', 'kirunak/approvals/hourly.json']);
  assert.equal(accept({ ws, id: ID, dryRun: true }).state, 'would accept');
  // A file of its own change, changed by a commit of no task, then by one whose trailer names another task (AC-1, AC-6).
  const a = commitFiles(weather, 'a typo', ['src/cache.ts']);
  const b = commitFiles(weather, 'the age line reworded\n\nTask: weather/hourly', ['docs/offline.md', 'src/chart.ts']);
  const refusal = `${ID}: its work changed after review.md's head ${reviewed}, in 2 file(s) the review never saw: run a new review (a review step whose output is review-2.md):\n  src/cache.ts  ${a}  no task\n  docs/offline.md  ${b}  weather/hourly`;
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'nothing open' }), (e) => e.message === refusal);
  // A head named HEAD would be the code as it is at accept, so the check would pass for nothing: not a review.
  writeFileSync(join(dir, 'review.md'), REVIEW('HEAD', 'verdict: met', false));
  reviewsRan(dir);
  assert.throws(() => accept({ ws, id: ID, checklistOpen: 'nothing open' }), /not a review k accept takes:\n {2}line 1: head HEAD is not a commit id/);
  // Changed and changed back still blocks: the commits are judged, not the net diff.
  writeFileSync(join(dir, 'review.md'), REVIEW(headOf(weather), 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, 'the review again');
  const added = commitFiles(weather, 'a line', ['src/cache.ts']);
  sh(weather, 'git', ['revert', '--no-edit', 'HEAD']);
  const back = headOf(weather);
  assert.throws(() => accept({ ws, id: ID }), (e) => e.message.endsWith(`:\n  src/cache.ts  ${added}  no task\n  src/cache.ts  ${back}  no task`));
});

test('a file or folder the workspace names as a record is never the task\'s own change and never blocks accept (accept-shared-repo AC-5, D-3)', async () => {
  const { ws: plain, weather } = await makeWorkspace();
  const root = plain.repos.find((r) => r.name === 'weather').root;
  const ws = { ...plain, records: [join(root, 'kirunak/plan.md'), `${join(root, 'notes')}/`] };
  const dir = taskDir(weather);
  await approve({ ws, id: ID, now: NOV5 });
  commitFiles(weather, `${ID} S-1: the cache, the plan and a note`, ['src/cache.ts', 'kirunak/plan.md', 'notes/a.md']);
  writeFileSync(join(dir, 'review.md'), REVIEW(headOf(weather), 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, `kirunak/tasks/offline-forecast: the review (${ID})`);
  // Its own commit touched the plan and the notes; later commits to them, one naming the task, block nothing.
  commitFiles(weather, 'the plan of weather/hourly', ['kirunak/plan.md', 'notes/a.md']);
  const ticked = commitFiles(weather, `${ID}: the plan ticked`, ['kirunak/plan.md']);
  assert.equal(accept({ ws, id: ID, dryRun: true }).state, 'would accept');
  // Named by no workspace, the same files block (AC-1, AC-7).
  assert.throws(() => accept({ ws: plain, id: ID, dryRun: true }), (e) => e.message.includes(`\n  kirunak/plan.md  ${ticked}  ${ID}`) && e.message.includes('  notes/a.md  '));
});

test('a later commit naming the task blocks accept whatever files it touches, unless they are all records (accept-shared-repo AC-7)', async () => {
  const { ws, weather } = await makeWorkspace();
  const dir = taskDir(weather);
  await approve({ ws, id: ID, now: NOV5 });
  commitFiles(weather, `${ID} S-1: the cache`, ['src/cache.ts']);
  const reviewed = headOf(weather);
  writeFileSync(join(dir, 'review.md'), REVIEW(reviewed, 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, 'the review');
  commitFiles(weather, `kirunak/tasks/offline-forecast: notes (${ID})`, ['kirunak/tasks/offline-forecast/notes.md']);
  assert.equal(accept({ ws, id: ID, dryRun: true }).state, 'would accept');
  // A new file, by slug, by id and by trailer.
  const slug = commitFiles(weather, 'offline-forecast: the hourly cut', ['src/hourly.ts']);
  const trailer = commitFiles(weather, `the README\n\nTask: ${ID}`, ['README.md', 'kirunak/drafts/x.md']);
  assert.throws(() => accept({ ws, id: ID }), (e) => e.message.endsWith(`in 2 file(s) the review never saw: run a new review (a review step whose output is review-2.md):\n  src/hourly.ts  ${slug}  ${ID}\n  README.md  ${trailer}  ${ID}`));
});

test('a merge after the review blocks accept by code of its own in a file of the task\'s change and by a conflict it resolved there; a clean merge blocks nothing (accept-merge-gaps AC-2, AC-3, E-2)', async () => {
  const { ws, weather } = await makeWorkspace();
  const dir = taskDir(weather);
  await approve({ ws, id: ID, now: NOV5 });
  commitFiles(weather, `${ID} S-1: the cache`, ['src/cache.ts']);
  writeFileSync(join(dir, 'review.md'), REVIEW(headOf(weather), 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, `kirunak/tasks/offline-forecast: the review (${ID})`);
  const branch = (name, message, files) => {
    sh(weather, 'git', ['checkout', '-q', '-b', name]);
    const sha = commitFiles(weather, message, files);
    sh(weather, 'git', ['checkout', '-q', '-']);
    return sha;
  };
  // Sides that changed other files, merged clean: the merge lists nothing of its own (AC-3).
  branch('chart', 'a chart for weather/hourly', ['src/chart.ts']);
  commitFiles(weather, 'notes for weather/hourly', ['src/notes.ts']);
  sh(weather, 'git', ['merge', '-q', '--no-ff', '-m', 'merge chart', 'chart']);
  assert.equal(accept({ ws, id: ID, dryRun: true }).state, 'would accept');
  // A merge of a side that never touched the task's file, with code of its own added there (AC-2).
  branch('side', 'a side for weather/hourly', ['src/side.ts']);
  sh(weather, 'git', ['merge', '-q', '--no-ff', '--no-commit', 'side']);
  writeFileSync(join(weather, 'src/cache.ts'), 'its own line\n', { flag: 'a' });
  sh(weather, 'git', ['add', '-A']);
  sh(weather, 'git', ['commit', '-q', '-m', 'merge side']);
  const evil = headOf(weather);
  assert.throws(() => accept({ ws, id: ID, dryRun: true }), (e) => e.message.endsWith(`in 1 file(s) the review never saw: run a new review (a review step whose output is review-2.md):\n  src/cache.ts  ${evil}  no task`));
  // The review again, then both sides change the task's file and the merge resolves the conflict (E-2).
  writeFileSync(join(dir, 'review.md'), REVIEW(headOf(weather), 'verdict: met', false));
  reviewsRan(dir);
  gitCommitAll(weather, 'the review again');
  const theirs = branch('clash', 'the side\'s cache (weather/hourly)', ['src/cache.ts']);
  const mine = commitFiles(weather, 'master\'s cache (weather/hourly)', ['src/cache.ts']);
  assert.throws(() => sh(weather, 'git', ['merge', '-q', '--no-ff', 'clash']));
  writeFileSync(join(weather, 'src/cache.ts'), 'both caches\n');
  sh(weather, 'git', ['add', '-A']);
  sh(weather, 'git', ['commit', '-q', '--no-edit']);
  const merged = headOf(weather);
  assert.throws(() => accept({ ws, id: ID, dryRun: true }), (e) => [theirs, mine, merged].every((sha) => e.message.includes(`\n  src/cache.ts  ${sha}  `)));
});

// Rows the owner should check, spelled as no verdict, a cited line past its file, and the last line met anyway.
const MISSPELT = (head) =>
  REVIEW(head, 'verdict: met')
    .replace('| AC-2 | met | file docs/offline.md:1 |', '| AC-2 | met | file nowhere.ts:999 |')
    .replace('needs device | On a phone', 'Needs device | On a phone')
    .replace('needs owner | Read', 'needs owner: the wording | Read');

test('accept refuses a review that fails the grammar, and one no finished review step wrote, whatever the flags', async () => {
  const { ws, weather } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const dir = taskDir(weather);
  const reviewed = headOf(weather);
  reviewsRan(dir);
  writeFileSync(join(dir, 'review.md'), MISSPELT(reviewed));
  gitCommitAll(weather, 'review');
  const r = () => accept({ ws, id: ID, checklistOpen: 'nothing to check' });
  assert.throws(r, /not a review k accept takes:\n {2}line 9: AC-2: nowhere\.ts does not exist at head\n {2}line 10: AC-3: the verdict Needs device is not one of/);
  assert.throws(r, /line 11: E-1: the verdict needs owner: the wording is not one of/);
  // Rows met without evidence, every attempt of the review step failed, and the step escalated.
  const rows = ['AC-1', 'AC-2', 'AC-3', 'E-1'].map((x) => `| ${x} | met | it works |`).join('\n');
  writeFileSync(join(dir, 'review.md'), `---\ntask: ${ID}\nhead: ${reviewed}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${rows}\n\nverdict: met\n`);
  writeFileSync(join(dir, 'plan.md'), readFileSync(join(dir, 'plan.md'), 'utf8').replace('Review [review]', 'Review [review] [escalate]'));
  writeFileSync(join(dir, 'progress.md'), '2026-11-06 10:00 S-2 failed: k review check\n2026-11-06 11:00 S-2 failed: k review check\n2026-11-06 11:00 S-2 escalated\n');
  assert.throws(r, /line 9: AC-2: met without evidence[^]*\n {2}S-2, the review step that writes review\.md, has not finished \(escalated\)$/);
  // In the grammar now, but still no finished step wrote it; nor any step at all once the plan has none.
  writeFileSync(join(dir, 'review.md'), REVIEW(reviewed, 'verdict: met', false));
  assert.throws(() => accept({ ws, id: ID }), /takes:\n {2}S-2, the review step that writes review\.md, has not finished \(escalated\)$/);
  writeFileSync(join(dir, 'plan.md'), '### S-1 Build [agent]\ncovers: all\ninputs: task\noutputs: review.md\n');
  assert.throws(() => accept({ ws, id: ID }), /takes:\n {2}no review step of plan\.md writes review\.md: a review is what a finished review step wrote$/);
  assert.equal(existsSync(join(dir, 'done.json')), false);
});

test('approve says queued or parked, by the queue, when the state cannot be read after its commit, never a failure (S-7 review, finding 7)', async () => {
  for (const [noQueue, state, queuePlace] of [[false, 'queued', 1], [true, 'parked', null]]) {
    const { ws, weather } = await makeWorkspace();
    // The state reads plan.md, after the commit; a folder there makes the read throw.
    mkdirSync(join(taskDir(weather), 'plan.md'));
    const r = await approve({ ws, id: ID, noQueue, now: NOV5 });
    assert.deepEqual([r.state, r.queuePlace], [state, queuePlace]);
    assert.equal(verify(ws, ID), 'ok');
    assert.equal(subject(weather), `kirunak: approve ${ID}`);
  }
});

test('k queue add takes an approved task that is not done, and names why it refuses one never approved, stale or done, a dry run too (S-7 review, finding 6)', async () => {
  const { ws, weather, home } = await makeWorkspace();
  const add = (...flags) => k(home, ['queue', 'add', ID, ...flags]);
  const refused = (r, why) => {
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, why);
  };
  for (const flags of [[], ['--dry-run']]) refused(add(...flags), /weather\/offline-forecast was never approved: k approve weather\/offline-forecast queues it/);
  await approve({ ws, id: ID, noQueue: true, now: NOV5 });
  const text = readFileSync(taskFile(weather), 'utf8');
  editTask(weather, 'title:', 'title: Changed:');
  refused(add(), /weather\/offline-forecast: task\.md does not match its approval \(stale\), so it cannot be queued/);
  writeFileSync(taskFile(weather), text);
  assert.equal(add('--dry-run').status, 0);
  assert.deepEqual(queue.read(ws), []);
  assert.equal(add().status, 0);
  assert.deepEqual(queue.read(ws), [ID]);
  queue.remove(ws, ID);
  // Accepted since the list was shown: Put back refuses it.
  writeFileSync(join(taskDir(weather), 'done.json'), '{}\n');
  for (const flags of [[], ['--dry-run']]) refused(add(...flags), /weather\/offline-forecast is done; a done task stays out of the queue/);
  assert.deepEqual(queue.read(ws), []);
});

test('hold writes hold.md with the date and why, resume deletes it, each in its own commit', async () => {
  const { ws, weather } = await makeWorkspace();
  const file = join(taskDir(weather), 'hold.md');
  assert.throws(() => hold({ ws, id: ID, why: '' }), /needs its reason/);
  hold({ ws, id: ID, why: 'waiting for the provider', now: NOV6 });
  assert.equal(readFileSync(file, 'utf8'), `# On hold: ${ID}\n\nHeld 2026-11-06: waiting for the provider\n`);
  assert.equal(subject(weather), `kirunak: hold ${ID}`);
  assert.throws(() => hold({ ws, id: ID, why: 'again' }), /already on hold/);
  resume({ ws, id: ID });
  assert.equal(existsSync(file), false);
  assert.equal(subject(weather), `kirunak: resume ${ID}`);
  assert.equal(sh(weather, 'git', ['status', '--porcelain']).trim(), '');
  assert.throws(() => resume({ ws, id: ID }), /not on hold/);
});

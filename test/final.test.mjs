import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept, approve, hashBytes, readRecord } from '../lib/approval.mjs';
import { close, closeIfFinal } from '../lib/close.mjs';
import { byFinalStep, signOff } from '../lib/final.mjs';
import * as queue from '../lib/queue.mjs';
import { stateOf } from '../lib/state.mjs';
import * as steps from '../lib/steps.mjs';
import { acceptRow } from '../lib/waiting.mjs';
import { gitCommitAll, makeWorkspace, sh } from './helpers.mjs';

// gulnya/fast-heavy-queue AC-7, AC-8: the owner's accept on a release signs off, the final steps run, and kirunak
// closes the release once they pass; a failed final step withdraws the sign-off.

const ID = 'weather/offline-forecast';
const NOV5 = new Date(2026, 10, 5, 9, 12, 0);
const NOV7 = new Date(2026, 10, 7, 11, 30, 0);
const NOV8 = new Date(2026, 10, 8, 8, 0, 0);
const taskDir = (weather) => join(weather, 'kirunak/tasks/offline-forecast');
const headOf = (repo) => sh(repo, 'git', ['rev-parse', '--short', 'HEAD']).trim();
const subject = (dir) => sh(dir, 'git', ['log', '-1', '--format=%s']).trim();

const step = (n, title, extra = '') => `### S-${n} ${title} [agent]\n${extra}covers: all\ninputs: task\noutputs: steps/S-${n}/report.md\n`;
const PLAN = (finals) => [
  `---\ntask: ${ID}\n${finals ? 'release: yes\n' : ''}---\n`,
  step(1, 'Build'),
  '### S-2 Review [review]\nneeds: S-1\ncovers: all\ninputs: task, diff, evidence/\noutputs: review.md\n',
  ...(finals ? [step(3, 'Store screenshots', 'final: yes\nneeds: S-2\n'), step(4, 'Store listing upload', 'final: yes\nneeds: S-2\n')] : []),
].join('\n');

const REVIEW = (head) => `---\ntask: ${ID}\nhead: ${head}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${['AC-1', 'AC-2', 'AC-3', 'E-1'].map((x) => `| ${x} | met | file docs/offline.md:1 |`).join('\n')}\n\nverdict: met\n`;

// An approved task, built and reviewed, with a release plan of two final steps (or none), all committed.
async function reviewed({ finals = true } = {}) {
  const { ws, weather, home } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const dir = taskDir(weather);
  writeFileSync(join(dir, 'plan.md'), PLAN(finals));
  writeFileSync(join(dir, 'review.md'), REVIEW(headOf(weather)));
  writeFileSync(join(dir, 'progress.md'), `2026-11-06 10:00 S-1 started\n2026-11-06 10:30 S-1 finished\n2026-11-06 11:00 S-2 started\n2026-11-06 11:40 S-2 finished (review.md ${hashBytes(readFileSync(join(dir, 'review.md')))})\n`);
  gitCommitAll(weather, 'review');
  return { ws, weather, home, dir };
}

const stateNow = (ws, dir) => stateOf({ taskDir: dir, record: readRecord(join(dir, '..', '..', '..'), 'offline-forecast'), id: ID });
const stepState = (ws, s) => steps.load(ws, ID).states.get(s);

// A final step run to its end: started, its report written, finished as k run finishes it (one records commit).
function runFinal(ws, dir, s, now) {
  appendFileSync(join(dir, 'progress.md'), `2026-11-07 12:0${s.at(-1)} ${s} started (opus, session aa)\n`);
  mkdirSync(join(dir, 'steps', s), { recursive: true });
  writeFileSync(join(dir, 'steps', s, 'report.md'), `# ${s}\n`);
  return steps.finish({ ws, id: ID, step: s, now });
}

test('k run holds a release\'s final steps until the owner signs off; the dry run and k waiting say the accept queues them', async () => {
  const { ws, dir } = await reviewed();
  for (const s of ['S-3', 'S-4']) assert.deepEqual(stepState(ws, s), { state: 'pending', why: steps.SIGN_OFF_WAIT });
  const dry = accept({ ws, id: ID, dryRun: true });
  assert.equal(dry.state, 'would sign off');
  assert.deepEqual(dry.final, ['S-3', 'S-4']);
  const row = await acceptRow(ws, { id: ID, title: 't', state: 'reviewed', review: 'review.md' });
  assert.equal(row.why, null);
  assert.deepEqual(row.final, ['S-3', 'S-4']);
  assert.equal(stateNow(ws, dir), 'reviewed');
});

test('a release with two final steps: the accept signs off, the steps run, and the last one\'s finish closes it; a final step\'s commit never blocks', async () => {
  const { ws, weather, home, dir } = await reviewed();
  queue.remove(ws, ID);
  const r = await close({ ws, id: ID, session: 'sess-1', now: NOV7 });
  assert.equal(r.state, 'final');
  assert.deepEqual(r.final, ['S-3', 'S-4']);
  assert.equal(existsSync(join(dir, 'done.json')), false, 'no done.json at the sign-off');
  assert.equal(r.worktrees, undefined, 'no worktree removed at the sign-off');
  const progress = readFileSync(join(dir, 'progress.md'), 'utf8');
  assert.match(progress, /\n2026-11-07 11:30 signed off by the owner: final steps S-3, S-4 queued \(session sess-1\)\n$/);
  assert.equal(subject(weather), `kirunak: ${ID} signed off by the owner, final steps S-3, S-4 queued`);
  assert.deepEqual(queue.read(ws), [ID], 'queued again, for k run');
  assert.match(readFileSync(join(home, 'events.jsonl'), 'utf8'), /"kind":"signed-off"/);
  assert.equal(stateNow(ws, dir), 'final');
  for (const s of ['S-3', 'S-4']) assert.equal(stepState(ws, s).state, 'ready');
  assert.throws(() => accept({ ws, id: ID }), /is signed off \(2026-11-07 11:30\): its final step\(s\) S-3, S-4 are not finished yet/);

  // S-3 commits work of its own, naming the step, after the review's head.
  appendFileSync(join(weather, 'docs/offline.md'), 'store set captions\n');
  gitCommitAll(weather, `Store screenshots (${ID} S-3)`);
  assert.equal(byFinalStep(`Store screenshots (${ID} S-3)`, ID, ['S-3', 'S-4']), true);
  assert.equal(byFinalStep(`Build (${ID} S-1)`, ID, ['S-3', 'S-4']), false);
  assert.equal(runFinal(ws, dir, 'S-3', NOV7).state, 'done');
  assert.equal(await closeIfFinal({ ws, id: ID, step: 'S-3' }), null, 'S-4 is left');
  assert.equal(stateNow(ws, dir), 'final');
  assert.equal(runFinal(ws, dir, 'S-4', NOV7).state, 'done');
  const c = await closeIfFinal({ ws, id: ID, step: 'S-4', now: NOV8 });
  assert.equal(c.state, 'done');
  assert.ok(c.worktrees, 'the close removes the merged worktrees as k accept does');
  const done = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  assert.equal(done.via, 'sign-off');
  assert.equal(done.signedOff, '2026-11-07 11:30');
  assert.deepEqual(done.finalSteps, ['S-3', 'S-4']);
  assert.ok(done.cost, 'the cost is recorded as k accept records it');
  assert.equal(subject(weather), `kirunak: accept ${ID}`);
  assert.equal(stateNow(ws, dir), 'done');
  assert.deepEqual(queue.read(ws), []);
});

test('a failed final step withdraws the sign-off; the next accept runs every final step again', async () => {
  const { ws, weather, dir } = await reviewed();
  await close({ ws, id: ID, session: 'sess-1', now: NOV7 });
  assert.equal(runFinal(ws, dir, 'S-3', NOV7).state, 'done');
  appendFileSync(join(dir, 'progress.md'), '2026-11-07 12:10 S-4 started (opus, session bb)\n');
  const f = steps.fail({ ws, id: ID, step: 'S-4', why: 'the upload refused the build', now: NOV7 });
  assert.equal(f.withdrawn, true);
  assert.match(readFileSync(join(dir, 'progress.md'), 'utf8'), /\n2026-11-07 11:30 sign-off withdrawn: S-4 failed\n$/);
  assert.equal(signOff(readFileSync(join(dir, 'progress.md'), 'utf8')), null);
  assert.equal(stateNow(ws, dir), 'reviewed', 'open for a fix, as the reviewed task it was');
  for (const s of ['S-3', 'S-4']) assert.deepEqual(stepState(ws, s), { state: 'pending', why: steps.SIGN_OFF_WAIT });
  gitCommitAll(weather, 'records');

  const again = await close({ ws, id: ID, session: 'sess-2', now: NOV8 });
  assert.equal(again.state, 'final');
  assert.deepEqual(again.final, ['S-3', 'S-4']);
  for (const s of ['S-3', 'S-4']) assert.equal(stepState(ws, s).state, 'ready', `${s} runs again: the build may have changed`);
  assert.equal(signOff(readFileSync(join(dir, 'progress.md'), 'utf8')).session, 'sess-2');
  // A stop is no failure: it withdraws nothing.
  appendFileSync(join(dir, 'progress.md'), '2026-11-08 08:10 S-3 started (opus, session cc)\n');
  assert.equal(steps.fail({ ws, id: ID, step: 'S-3', why: `${steps.UNFINISHED}the captions`, now: NOV8 }).withdrawn, undefined);
  assert.equal(stateNow(ws, dir), 'final');
});

test('a task with no final steps closes at once, as today (AC-8)', async () => {
  const { ws, dir } = await reviewed({ finals: false });
  assert.equal(accept({ ws, id: ID, dryRun: true }).state, 'would accept');
  const row = await acceptRow(ws, { id: ID, title: 't', state: 'reviewed', review: 'review.md' });
  assert.deepEqual(row.final, []);
  const r = await close({ ws, id: ID, session: 'sess-1', now: NOV7 });
  assert.equal(r.state, 'done');
  const done = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  assert.equal(done.signedOff, undefined);
  assert.equal(done.via, 'shell');
  assert.equal(readFileSync(join(dir, 'progress.md'), 'utf8').includes('signed off'), false);
});

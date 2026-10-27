import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { approve, verify } from '../lib/approval.mjs';
import { bugPaths, checkBug, checkBugText, drop, format, from, list, newBug, readReview, reviewLockPath, reviewing } from '../lib/bugs.mjs';
import { parseDraft } from '../lib/drafts.mjs';
import { gitCommitAll, gitInit, k, makeWorkspace, sh } from './helpers.mjs';

// gulnya/kirunak-bugs S-1: a bug, kirunak/bugs/<slug>.md, its checks, its list, its drop and the move into it.

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const OCT22 = new Date(2026, 9, 22, 10, 30, 0);
const TASK = 'weather/offline-forecast';
const BUG = 'hub/stale-tiles';
const rootOf = (w, repo = 'weather') => w.ws.repos.find((r) => r.name === repo).root;
const bugFile = (w, slug = 'stale-tiles', repo = 'hub') => join(rootOf(w, repo), 'kirunak', 'bugs', `${slug}.md`);
const draftFile = (w, slug = 'stale-tiles', repo = 'hub') => join(rootOf(w, repo), 'kirunak', 'drafts', `${slug}.md`);
const git = (dir, ...args) => sh(dir, 'git', args).trim();
const lineOf = (text, s) => text.split('\n').findIndex((l) => l.includes(s)) + 1;

// The invented workspace with kirunak's own checkout a scratch repo (named in the workspace module, so the CLI's
// children see it too), and weather/offline-forecast accepted unless `accepted` is false.
async function bugWorkspace({ accepted = true } = {}) {
  const w = await makeWorkspace();
  const self = join(w.root, 'kirunak-self');
  mkdirSync(self);
  gitInit(self);
  writeFileSync(join(self, 'README.md'), 'kirunak\n');
  gitCommitAll(self);
  writeFileSync(w.modulePath, readFileSync(w.modulePath, 'utf8').replace("queue: './queue.md',", `queue: './queue.md',\n  kirunakRoot: ${JSON.stringify(self)},`));
  gitCommitAll(w.hub, 'kirunak root');
  w.ws.kirunakRoot = realpathSync(self);
  w.self = realpathSync(self);
  if (accepted) {
    await approve({ ws: w.ws, id: TASK });
    writeFileSync(join(rootOf(w), 'kirunak', 'tasks', 'offline-forecast', 'done.json'), '{"accepted":"2026-10-20"}\n');
    gitCommitAll(w.weather, 'accept');
  }
  return w;
}

// A commit on `branch` that the repo's master lacks, made without checking anything out: its sha.
function fixBranch(root, branch, message = 'the fix') {
  const sha = git(root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', message);
  git(root, 'branch', branch, sha);
  return sha;
}

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// A groomed bug: the owner's words, why, findings with sources, the fix written, questions each with its Proposed line.
const filled = ({ id = BUG, front = `bug-of: ${TASK}\n`, fix = '- the cache expires [commit 1a2b3c4]\n', written = '2026-10-22' } = {}) => `---
id: ${id}
title: Stale map tiles
written: ${written}
${front}---

## Who raised it
> the map shows yesterday's tiles
owner, 2026-10-22, session 5f0c2a

## Why
After a refresh the map keeps the old tiles; open the map, refresh, and the tiles stay.

## What was found
- the tile cache never expires [file src/Tiles.kt]
${fix === null ? '' : `\n## Fix written\n${fix}`}
## Questions
1. Should the cache expire hourly?
   Proposed: hourly, as the forecast refreshes hourly
2. Clear the old tiles on start?
   Proposed: only the owner can say whether offline tiles must survive a start
`;

test('k bug new writes the skeleton in kirunak/bugs/, commits nothing, and the check refuses every placeholder', async () => {
  const w = await bugWorkspace();
  const r = newBug({ ws: w.ws, id: BUG, title: ' Stale map tiles ', bugOf: ` ${TASK} `, session: '5f0c2a', now: OCT22 });
  assert.deepEqual([r.path, r.bugOf, r.fixRepo, r.branch], [bugFile(w), TASK, null, 'bug/stale-tiles']);
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /^---\nid: hub\/stale-tiles\ntitle: Stale map tiles\nwritten: 2026-10-22\nbug-of: weather\/offline-forecast\n---\n/);
  assert.deepEqual(parseDraft(text).sections.map((s) => s.name), ['Who raised it', 'Why', 'What was found', 'Fix written', 'Questions']);
  assert.match(text, /session 5f0c2a/);
  assert.match(text, /on the branch bug\/stale-tiles/);
  assert.match(text, /each with an indented "Proposed:" line under it/);
  assert.equal(git(w.hub, 'status', '--porcelain'), '?? kirunak/bugs/');
  assert.equal(existsSync(draftFile(w)), false);
  assert.deepEqual(checkBug(w.ws, BUG).map((p) => p.problem), [
    '## Who raised it is empty: it still holds its placeholder',
    '## Why is empty: it still holds its placeholder',
    '## What was found is empty: it still holds its placeholder',
    "## Fix written still holds its placeholder: name the fix's commits or patch file, or delete the section when no fix exists",
    '## Questions is empty: it still holds its placeholder',
  ]);
  // No task and no fix repo of its own: neither line is written.
  const plain = newBug({ ws: w.ws, id: 'weather/slow-start', title: 'Slow start', fixRepo: 'weather', now: OCT22 });
  assert.equal(plain.fixRepo, null);
  assert.match(readFileSync(plain.path, 'utf8'), /^---\nid: weather\/slow-start\ntitle: Slow start\nwritten: 2026-10-22\n---\n/);
  const elsewhere = newBug({ ws: w.ws, id: 'hub/k-crash', title: 'k crashes', fixRepo: 'kirunak', now: OCT22 });
  assert.match(readFileSync(elsewhere.path, 'utf8'), /\nwritten: 2026-10-22\nfix-repo: kirunak\n---\n/);
});

test('k bug new refuses an unknown repo, a bad id, a title missing or long, and an id already a bug, a draft or a task', async () => {
  const w = await bugWorkspace();
  const nu = (id, more = {}) => () => newBug({ ws: w.ws, id, title: 'Stale tiles', ...more });
  assert.throws(nu('radio/x'), (e) => e.code === 1 && /^unknown repo radio: kirunak's workspace lists weather, hub\. Ask the owner to add radio to kirunak's workspace first \(.*\), then write the bug$/.test(e.message));
  assert.throws(nu('hub/Stale'), (e) => e.code === 2 && /^not a bug id: hub\/Stale/.test(e.message));
  assert.throws(nu(BUG, { title: ' ' }), (e) => e.code === 2 && /^a bug needs its title/.test(e.message));
  assert.throws(nu(BUG, { title: 'x'.repeat(81) }), (e) => e.code === 2 && /^a bug's title is a few words, at most/.test(e.message));
  newBug({ ws: w.ws, id: BUG, title: 'Stale tiles' });
  assert.throws(nu(BUG), (e) => e.code === 1 && e.message === `${BUG} is already a bug: ${bugFile(w)}`);
  put(draftFile(w, 'wind'), '---\nid: hub/wind\n---\n');
  assert.throws(nu('hub/wind', { dryRun: true }), (e) => e.code === 1 && e.message === `hub/wind is already a draft: ${draftFile(w, 'wind')}; \`k bug from hub/wind\` moves it into kirunak/bugs/`);
  assert.throws(nu(TASK), (e) => e.code === 1 && /^weather\/offline-forecast is already a task: /.test(e.message));
  put(join(w.hub, 'kirunak', 'approvals', 'gone.json'), '{}\n');
  assert.throws(nu('hub/gone'), /hub\/gone is already a task: .*approvals\/gone\.json$/);
  assert.equal(existsSync(bugFile(w, 'wind')), false);
});

test('AC-10, E-1, E-2: --bug-of names an accepted task or is refused; --fix-repo names a repo of the workspace or kirunak', async () => {
  const w = await bugWorkspace({ accepted: false });
  const nu = (more) => () => newBug({ ws: w.ws, id: BUG, title: 'Stale tiles', ...more });
  const open = `${TASK} is not accepted yet: a bug found while a task is open goes into that task, through its review or an amendment (k amend new ${TASK} --title "...")`;
  const gone = join(rootOf(w), 'kirunak', 'tasks', 'gone', 'task.md');
  for (const dryRun of [false, true]) {
    assert.throws(nu({ bugOf: TASK, dryRun }), (e) => e.code === 1 && e.message === open);
    assert.throws(nu({ bugOf: 'weather/gone', dryRun }), (e) => e.code === 1 && e.message === `unknown task weather/gone: ${gone} does not exist; a bug names the accepted task it was found in`);
    assert.throws(nu({ bugOf: 'weather/Gone', dryRun }), (e) => e.code === 2 && /^not a task id: weather\/Gone/.test(e.message));
    assert.throws(nu({ bugOf: ' ', dryRun }), (e) => e.code === 2 && e.message === '--bug-of names the accepted task the bug was found in: --bug-of <repo>/<slug>');
    assert.throws(nu({ fixRepo: 'radio', dryRun }), (e) => e.code === 1 && e.message === "unknown fix repo radio: name a repo of the workspace (weather, hub) or kirunak, kirunak's own checkout");
    assert.throws(nu({ fixRepo: '', dryRun }), (e) => e.code === 2 && /^--fix-repo names the repo of the fix branch bug\/stale-tiles/.test(e.message));
  }
  assert.equal(existsSync(bugFile(w)), false);
  // With no bug-of it needs no task at all (AC-10), and a dry run writes nothing.
  assert.equal(newBug({ ws: w.ws, id: BUG, title: 'Stale tiles', dryRun: true }).path, bugFile(w));
  assert.equal(existsSync(bugFile(w)), false);
});

test('the shape: a groomed draft\'s, Fix written optional, each question with its Proposed line, no state', () => {
  const problems = (opts, id = BUG) => checkBugText(filled(opts), id).map((p) => p.problem);
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems({ fix: null }), []);
  assert.deepEqual(problems({ front: '' }), []);
  assert.deepEqual(problems({ front: 'fix-repo: kirunak\n' }), []);
  const noProposed = filled().replace('   Proposed: hourly, as the forecast refreshes hourly\n', '');
  assert.deepEqual(checkBugText(noProposed, BUG), [{
    line: lineOf(noProposed, '1. Should'),
    problem: '## Questions: question 1 has no "Proposed:" line: under it, indented, your answer and why, or what is missing when only the owner can answer',
  }]);
  const flat = filled().replace('   Proposed: only', 'Proposed: only');
  assert.deepEqual(checkBugText(flat, BUG).map((p) => p.problem), [
    '## Questions: question 2 has no "Proposed:" line: under it, indented, your answer and why, or what is missing when only the owner can answer',
    '## Questions: a question is a numbered line, "1. <question>"',
  ]);
  assert.deepEqual(problems({ front: 'bug-of: weather\n' }), ['bug-of weather is not a task id: name the accepted task the bug was found in, <repo>/<slug>, or leave the line out']);
  assert.deepEqual(problems({ front: 'bug-of:\n' }), ['bug-of is empty: name the accepted task the bug was found in, <repo>/<slug>, or leave the line out']);
  assert.deepEqual(problems({ front: 'fix-repo:\n' }), ["fix-repo is empty: name the repo of the fix branch, or leave the line out when it is the bug's own"]);
  assert.deepEqual(problems({ front: 'state: open\n' }), ['a bug has no state field: whether its fix is ready is worked out each time, from its branch bug/<slug> and the reviews beside it']);
  assert.deepEqual(problems({}, 'hub/other'), ["id hub/stale-tiles is not this bug's id hub/other"]);
  assert.deepEqual(problems({ fix: '- the cache expires\n' }), ['## Fix written: this fix names no commit or patch file: end it with [commit <sha>] or [file <patch path>]']);
  const order = 'Who raised it, Why, What was found, Fix written, Questions';
  assert.deepEqual(checkBugText(filled({ fix: null }) + '\n## Fix written\n- the cache [commit 1a2b3c4]\n', BUG).map((p) => p.problem), [`section Fix written is out of order: ${order}`]);
});

test('E-4, E-6: k bug check finds the fix\'s commits in its fix repo, its own or its task\'s, and names the repos looked in', async () => {
  const w = await bugWorkspace();
  const inTask = git(w.weather, 'rev-parse', '--short', 'HEAD');
  const inBug = git(w.hub, 'rev-parse', 'HEAD');
  const inSelf = fixBranch(w.self, 'bug/stale-tiles');
  const nowhere = '0123456789abc';
  const fix = (...shas) => shas.map((s) => `- a part of it [commit ${s}]\n`).join('');
  put(bugFile(w), filled({ fix: fix(inTask, inBug) }));
  assert.deepEqual(checkBug(w.ws, BUG), []);
  put(bugFile(w), filled({ front: `bug-of: ${TASK}\nfix-repo: kirunak\n`, fix: fix(inSelf, inTask) }));
  assert.deepEqual(checkBug(w.ws, BUG), []);
  const lost = filled({ front: `bug-of: ${TASK}\nfix-repo: kirunak\n`, fix: fix(nowhere) });
  put(bugFile(w), lost);
  assert.deepEqual(checkBug(w.ws, BUG), [{ line: lineOf(lost, nowhere), problem: `## Fix written: commit ${nowhere} is found in none of kirunak, hub, weather` }]);
  put(bugFile(w), filled({ front: '', fix: fix(inSelf) }));
  assert.deepEqual(checkBug(w.ws, BUG).map((p) => p.problem), [`## Fix written: commit ${inSelf} is not found in hub`]);
  const unknown = filled({ front: 'fix-repo: radio\n', fix: null });
  put(bugFile(w), unknown);
  assert.deepEqual(checkBug(w.ws, BUG), [{ line: 5, problem: "fix-repo: unknown repo radio: name a repo of the workspace (weather, hub) or kirunak, kirunak's own checkout" }]);
  // A task not accepted any more is refused, as the drafts' bugs were (kirunak-spikes E-4).
  sh(w.weather, 'rm', [join('kirunak', 'tasks', 'offline-forecast', 'done.json')]);
  put(bugFile(w), filled({ fix: null }));
  assert.deepEqual(checkBug(w.ws, BUG).map((p) => p.problem), [`bug-of: ${TASK} is not accepted yet: a bug found while a task is open goes into that task, through its review or an amendment (k amend new ${TASK} --title "...")`]);
  assert.throws(() => checkBug(w.ws, 'hub/none'), (e) => e.code === 1 && /^no bug hub\/none: /.test(e.message));
});


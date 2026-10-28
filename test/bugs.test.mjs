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

// A groomed bug: the owner's words, why, findings with sources, the fix written, questions each with its Proposed line,
// marked yes unless `mark` says otherwise ('' for none, as a draft has).
const filled = ({ id = BUG, front = `bug-of: ${TASK}\n`, mark = 'quad-damage: yes\n', fix = '- the cache expires [commit 1a2b3c4]\n', written = '2026-10-22' } = {}) => `---
id: ${id}
title: Stale map tiles
written: ${written}
${front}${mark}---

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
  const r = newBug({ ws: w.ws, id: BUG, title: ' Stale map tiles ', quadDamage: ' yes ', bugOf: ` ${TASK} `, session: '5f0c2a', now: OCT22 });
  assert.deepEqual([r.path, r.bugOf, r.fixRepo, r.branch, r.quadDamage], [bugFile(w), TASK, null, 'bug/stale-tiles', 'yes']);
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /^---\nid: hub\/stale-tiles\ntitle: Stale map tiles\nwritten: 2026-10-22\nbug-of: weather\/offline-forecast\nquad-damage: yes\n---\n/);
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
  const plain = newBug({ ws: w.ws, id: 'weather/slow-start', title: 'Slow start', quadDamage: 'no', fixRepo: 'weather', now: OCT22 });
  assert.equal(plain.fixRepo, null);
  assert.match(readFileSync(plain.path, 'utf8'), /^---\nid: weather\/slow-start\ntitle: Slow start\nwritten: 2026-10-22\nquad-damage: no\n---\n/);
  const elsewhere = newBug({ ws: w.ws, id: 'hub/k-crash', title: 'k crashes', quadDamage: 'yes', fixRepo: 'kirunak', now: OCT22 });
  assert.match(readFileSync(elsewhere.path, 'utf8'), /\nwritten: 2026-10-22\nfix-repo: kirunak\nquad-damage: yes\n---\n/);
});

test('k bug new refuses an unknown repo, a bad id, a title missing or long, and an id already a bug, a draft or a task', async () => {
  const w = await bugWorkspace();
  const nu = (id, more = {}) => () => newBug({ ws: w.ws, id, title: 'Stale tiles', quadDamage: 'yes', ...more });
  assert.throws(nu('radio/x'), (e) => e.code === 1 && /^unknown repo radio: kirunak's workspace lists weather, hub\. Ask the owner to add radio to kirunak's workspace first \(.*\), then write the bug$/.test(e.message));
  assert.throws(nu('hub/Stale'), (e) => e.code === 2 && /^not a bug id: hub\/Stale/.test(e.message));
  assert.throws(nu(BUG, { title: ' ' }), (e) => e.code === 2 && /^a bug needs its title/.test(e.message));
  assert.throws(nu(BUG, { title: 'x'.repeat(81) }), (e) => e.code === 2 && /^a bug's title is a few words, at most/.test(e.message));
  newBug({ ws: w.ws, id: BUG, title: 'Stale tiles', quadDamage: 'no' });
  assert.throws(nu(BUG), (e) => e.code === 1 && e.message === `${BUG} is already a bug: ${bugFile(w)}`);
  put(draftFile(w, 'wind'), '---\nid: hub/wind\n---\n');
  assert.throws(nu('hub/wind', { dryRun: true }), (e) => e.code === 1 && e.message === `hub/wind is already a draft: ${draftFile(w, 'wind')}; \`k bug from hub/wind --quad-damage yes|no\` moves it into kirunak/bugs/`);
  assert.throws(nu(TASK), (e) => e.code === 1 && /^weather\/offline-forecast is already a task: /.test(e.message));
  put(join(w.hub, 'kirunak', 'approvals', 'gone.json'), '{}\n');
  assert.throws(nu('hub/gone'), /hub\/gone is already a task: .*approvals\/gone\.json$/);
  assert.equal(existsSync(bugFile(w, 'wind')), false);
});

test('AC-10, E-1, E-2: --bug-of names an accepted task or is refused; --fix-repo names a repo of the workspace or kirunak', async () => {
  const w = await bugWorkspace({ accepted: false });
  const nu = (more) => () => newBug({ ws: w.ws, id: BUG, title: 'Stale tiles', quadDamage: 'yes', ...more });
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
  assert.equal(newBug({ ws: w.ws, id: BUG, title: 'Stale tiles', quadDamage: 'yes', dryRun: true }).path, bugFile(w));
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
  // With no fix-repo named, kirunak's own checkout is looked in too (gulnya/draft-check-kirunak-commits AC-1).
  put(bugFile(w), filled({ front: '', fix: fix(inSelf) }));
  assert.deepEqual(checkBug(w.ws, BUG), []);
  const unknown = filled({ front: 'fix-repo: radio\n', fix: null });
  put(bugFile(w), unknown);
  assert.deepEqual(checkBug(w.ws, BUG), [{ line: 5, problem: "fix-repo: unknown repo radio: name a repo of the workspace (weather, hub) or kirunak, kirunak's own checkout" }]);
  // A task not accepted any more is refused, as the drafts' bugs were (kirunak-spikes E-4).
  sh(w.weather, 'rm', [join('kirunak', 'tasks', 'offline-forecast', 'done.json')]);
  put(bugFile(w), filled({ fix: null }));
  assert.deepEqual(checkBug(w.ws, BUG).map((p) => p.problem), [`bug-of: ${TASK} is not accepted yet: a bug found while a task is open goes into that task, through its review or an amendment (k amend new ${TASK} --title "...")`]);
  assert.throws(() => checkBug(w.ws, 'hub/none'), (e) => e.code === 1 && /^no bug hub\/none: /.test(e.message));
});

test('gulnya/draft-check-kirunak-commits AC-1 to AC-3, E-1, E-2: k bug check looks in kirunak\'s own checkout too, when it is one', async () => {
  const w = await bugWorkspace();
  const inTask = git(w.weather, 'rev-parse', 'HEAD');
  const inSelf = fixBranch(w.self, 'bug/stale-tiles');
  const nowhere = '0123456789abc';
  const fix = (...shas) => shas.map((s) => `- a part of it [commit ${s}]\n`).join('');
  const problems = (ws = w.ws) => checkBug(ws, BUG).map((p) => p.problem);
  // AC-1: a commit only in kirunak's own repo passes, with a task or none; AC-3: the bug's and the task's still do.
  for (const front of ['', `bug-of: ${TASK}\n`]) {
    put(bugFile(w), filled({ front, fix: fix(inSelf) }));
    assert.deepEqual(problems(), []);
  }
  put(bugFile(w), filled({ fix: fix(inTask, inSelf) }));
  assert.deepEqual(problems(), []);
  // AC-2: a commit in none of them is refused, the problem naming each repo looked in.
  put(bugFile(w), filled({ front: '', fix: fix(nowhere) }));
  assert.deepEqual(problems(), [`## Fix written: commit ${nowhere} is found in neither hub nor kirunak`]);
  put(bugFile(w), filled({ fix: fix(nowhere) }));
  assert.deepEqual(problems(), [`## Fix written: commit ${nowhere} is found in none of hub, weather, kirunak`]);
  // E-2: a kirunak commit on a branch since deleted and pruned no longer exists.
  const gone = fixBranch(w.self, 'bug/gone', 'a fix since dropped');
  git(w.self, 'branch', '-D', 'bug/gone');
  git(w.self, 'reflog', 'expire', '--expire=now', '--all');
  git(w.self, 'gc', '-q', '--prune=now');
  put(bugFile(w), filled({ front: '', fix: fix(gone) }));
  assert.deepEqual(problems(), [`## Fix written: commit ${gone} is found in neither hub nor kirunak`]);
  // E-1: k run from a copy that is no git checkout (here inside weather's, as an npm install in a project would be)
  // looks in the workspace's repos only, as before, and never in the checkout around it.
  const copy = join(w.weather, 'node_modules', 'kirunak');
  mkdirSync(copy, { recursive: true });
  const fromCopy = { ...w.ws, kirunakRoot: copy };
  put(bugFile(w), filled({ front: '', fix: fix(inSelf) }));
  assert.deepEqual(problems(fromCopy), [`## Fix written: commit ${inSelf} is not found in hub`]);
  put(bugFile(w), filled({ front: '', fix: fix(inTask) }));
  assert.deepEqual(problems(fromCopy), [`## Fix written: commit ${inTask} is not found in hub`]);
});

test('k bugs: every repo\'s bugs, a ready fix first, then by date; fix ready from the branch and the reviews; reviewing from the lock', async () => {
  const w = await bugWorkspace();
  const bug = (id, written, front = '') => put(bugFile(w, id.split('/')[1], id.split('/')[0]), filled({ id, written, front, fix: null }));
  bug('hub/a', '2026-10-20');
  bug('hub/b', '2026-10-25');
  bug('weather/c', '2026-10-21');
  bug('weather/d', '2026-10-19');
  bug('hub/e', '', 'fix-repo: kirunak\n');
  put(join(w.hub, 'kirunak', 'bugs', 'notes.txt'), 'not a bug\n');
  put(join(w.hub, 'kirunak', 'bugs', 'a', 'review-1.md'), 'verdict: findings\n');
  const b = fixBranch(w.hub, 'bug/b');
  const c = fixBranch(w.weather, 'bug/c');
  put(join(w.weather, 'kirunak', 'bugs', 'c', 'review-1.md'), `---\nverdict: findings\nhead: ${c.slice(0, 9)}\n---\nthe cache still leaks\n`);
  git(w.weather, 'branch', 'bug/d');
  const old = fixBranch(w.self, 'bug/e-old');
  git(w.self, 'branch', 'bug/e', fixBranch(w.self, 'bug/e-new', 'the fix again'));
  put(join(w.hub, 'kirunak', 'bugs', 'e', 'review-1.md'), `verdict: findings\nhead: ${old}\n`);
  put(reviewLockPath(w.home, 'hub/e'), JSON.stringify({ pid: process.pid, started: '2026-10-27T10:00:00Z' }));
  const rows = list(w.ws);
  assert.deepEqual(rows.map((r) => [r.id, r.fixReady]), [['hub/b', true], ['hub/e', true], ['weather/d', false], ['hub/a', false], ['weather/c', false]]);
  const at = (id) => rows.find((r) => r.id === id);
  assert.deepEqual(Object.keys(at('hub/b')), ['id', 'repo', 'slug', 'title', 'written', 'bugOf', 'fixRepo', 'quadDamage', 'branch', 'head', 'ahead', 'fixReady', 'reviewing', 'quadDamageRun', 'review', 'path']);
  assert.deepEqual([at('hub/b').branch, at('hub/b').head, at('hub/b').ahead, at('hub/b').fixRepo, at('hub/b').review], ['bug/b', b, 1, 'hub', null]);
  assert.deepEqual([at('hub/e').fixRepo, at('hub/e').written, at('hub/e').reviewing], ['kirunak', null, { pid: process.pid, started: '2026-10-27T10:00:00Z' }]);
  assert.deepEqual(at('hub/e').review, { file: 'review-1.md', verdict: 'findings', head: old, atHead: false });
  assert.deepEqual([at('weather/c').head, at('weather/c').review.atHead], [c, true]);
  assert.deepEqual([at('weather/d').branch, at('weather/d').ahead], ['bug/d', 0]);
  assert.deepEqual([at('hub/a').branch, at('hub/a').head, at('hub/a').path], [null, null, bugFile(w, 'a')]);
  const lines = format(rows).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^hub\/b      Stale map tiles  2026-10-25  fix ready$/);
  assert.match(lines[1], /^hub\/e      Stale map tiles  no date     reviewing$/);
  assert.match(lines[4], /^weather\/c  Stale map tiles  2026-10-21  fix not ready: review-1\.md found findings$/);
  assert.match(lines[3], /  no fix$/);
  assert.equal(format([]), 'no bugs');

  // A lock whose pid is gone, or that cannot be read, is no review running; a clean review at the head keeps it ready.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  put(reviewLockPath(w.home, 'hub/e'), JSON.stringify({ pid: dead, started: 'then' }));
  assert.equal(reviewing(w.home, 'hub/e'), null);
  put(reviewLockPath(w.home, 'hub/e'), '{not json');
  assert.equal(reviewing(w.home, 'hub/e'), null);
  assert.equal(reviewLockPath(w.home, 'hub/e'), join(w.home, 'bugs', 'hub', 'e.review.json'));
  put(join(w.hub, 'kirunak', 'bugs', 'b', 'review-1.md'), `verdict: clean\nhead: ${b}\n`);
  assert.equal(list(w.ws).find((r) => r.id === 'hub/b').fixReady, true);
  put(join(w.hub, 'kirunak', 'bugs', 'b', 'review-2.md'), `verdict: conflict\nhead: ${b}\n`);
  assert.equal(list(w.ws).find((r) => r.id === 'hub/b').fixReady, false);
  assert.deepEqual(readReview('---\nverdict: clean\n---\nbase: abc1234\n'), { verdict: 'clean', head: null, base: 'abc1234' });
});

test('E-5: k bug drop removes the bug and its folder in a commit of their own, the reason in it, the fix branch kept and named', async () => {
  const w = await bugWorkspace();
  put(bugFile(w), filled());
  put(join(w.hub, 'kirunak', 'bugs', 'stale-tiles', 'review-1.md'), 'verdict: findings\n');
  gitCommitAll(w.hub, 'a bug');
  const sha = fixBranch(w.hub, 'bug/stale-tiles');
  put(join(w.hub, 'README.md'), 'staged, not the drop\n');
  git(w.hub, 'add', 'README.md');
  assert.throws(() => drop({ ws: w.ws, id: BUG, why: ' ' }), (e) => e.code === 2 && /^dropping a bug needs its reason/.test(e.message));
  assert.throws(() => drop({ ws: w.ws, id: 'hub/none', why: 'x' }), (e) => e.code === 1 && /^no bug hub\/none: /.test(e.message));
  const dry = drop({ ws: w.ws, id: BUG, why: 'fixed by another', dryRun: true });
  assert.equal(dry.tracked, true);
  assert.ok(existsSync(bugFile(w)));
  const r = drop({ ws: w.ws, id: BUG, why: 'fixed by another' });
  assert.equal(r.commit, git(w.hub, 'rev-parse', '--short', 'HEAD'));
  assert.equal(git(w.hub, 'log', '-1', '--format=%B'), `kirunak: drop the bug ${BUG}: fixed by another\n\nIts fix branch bug/stale-tiles is kept in hub, at ${sha.slice(0, 12)}.`);
  assert.equal(git(w.hub, 'show', '--name-status', '--format=', 'HEAD'), 'D\tkirunak/bugs/stale-tiles.md\nD\tkirunak/bugs/stale-tiles/review-1.md');
  assert.equal(git(w.hub, 'rev-parse', 'bug/stale-tiles'), sha);
  assert.equal(git(w.hub, 'diff', '--cached', '--name-only'), 'README.md');
  assert.equal(existsSync(join(w.hub, 'kirunak', 'bugs', 'stale-tiles')), false);
  // A bug never committed is only deleted; one with its fix in kirunak names the branch there.
  put(bugFile(w, 'k-crash'), filled({ id: 'hub/k-crash', front: 'fix-repo: kirunak\n' }));
  const kept = fixBranch(w.self, 'bug/k-crash');
  const loose = drop({ ws: w.ws, id: 'hub/k-crash', why: 'a duplicate' });
  assert.deepEqual([loose.commit, existsSync(bugFile(w, 'k-crash'))], [null, false]);
  assert.deepEqual(loose.branch, { repo: 'kirunak', branch: 'bug/k-crash', head: kept.slice(0, 12) });
});

// The paths a commit or the index holds, sorted, a rename's score left out.
const moved = (status) => status.split('\n').map((l) => l.replace(/^R\d+/, 'R')).sort();
const MOVED = ['M\tkirunak/drafts-order.md', 'R\tkirunak/drafts/stale-tiles.md\tkirunak/bugs/stale-tiles.md'];

// A draft as kirunak-spikes wrote a bug: bug-of and Fix written, its fix on draft/<slug> in kirunak's own checkout.
async function draftedBug() {
  const w = await bugWorkspace();
  const sha = fixBranch(w.self, 'draft/stale-tiles');
  put(draftFile(w), filled({ mark: '', fix: `- the cache expires [commit ${sha.slice(0, 10)}]\n` }));
  put(w.ws.draftOrder, `# the order\n${BUG}\nweather/wind-alerts\n`);
  gitCommitAll(w.hub, 'the draft');
  return { w, sha };
}

test('AC-3, E-4: k bug from moves a draft with its history, renames draft/<slug> to bug/<slug> where it is, and commits each repo\'s paths alone', async () => {
  const { w, sha } = await draftedBug();
  put(join(w.hub, 'README.md'), 'staged, not the move\n');
  git(w.hub, 'add', 'README.md');
  const dry = from({ ws: w.ws, id: BUG, quadDamage: 'yes', dryRun: true });
  assert.deepEqual([dry.kind, dry.moves, dry.renames, dry.fixRepo, dry.quadDamage], ['draft', [{ from: 'kirunak/drafts/stale-tiles.md', to: 'kirunak/bugs/stale-tiles.md' }], [{ repo: 'kirunak', from: 'draft/stale-tiles', to: 'bug/stale-tiles' }], 'kirunak', 'yes']);
  assert.ok(existsSync(draftFile(w)));
  assert.equal(git(w.self, 'branch', '--list', 'bug/*'), '');

  const r = from({ ws: w.ws, id: BUG, quadDamage: 'yes' });
  assert.equal(existsSync(draftFile(w)), false);
  const text = readFileSync(bugFile(w), 'utf8');
  assert.match(text, /^---\nid: hub\/stale-tiles\ntitle: Stale map tiles\nwritten: 2026-10-22\nbug-of: weather\/offline-forecast\nfix-repo: kirunak\nquad-damage: yes\n---\n/);
  assert.equal(git(w.self, 'rev-parse', 'bug/stale-tiles'), sha);
  assert.equal(git(w.self, 'branch', '--list', 'draft/*'), '');
  assert.deepEqual(checkBug(w.ws, BUG), []);
  assert.equal(r.commits[0].commit, git(w.hub, 'rev-parse', '--short', 'HEAD'));
  assert.equal(git(w.hub, 'log', '-1', '--format=%s'), 'kirunak: hub/stale-tiles is a bug: moved from kirunak/drafts/ into kirunak/bugs/');
  assert.deepEqual(moved(git(w.hub, 'show', '--name-status', '--format=', '-M', 'HEAD')), MOVED);
  assert.deepEqual(git(w.hub, 'log', '--follow', '--format=%s', '--', 'kirunak/bugs/stale-tiles.md').split('\n').slice(-1), ['the draft']);
  assert.equal(readFileSync(w.ws.draftOrder, 'utf8'), '# the order\nweather/wind-alerts\n');
  assert.equal(git(w.hub, 'diff', '--cached', '--name-only'), 'README.md');
  assert.deepEqual(list(w.ws).map((x) => [x.id, x.fixReady, x.fixRepo]), [[BUG, true, 'kirunak']]);
  assert.throws(() => from({ ws: w.ws, id: BUG, quadDamage: 'no' }), (e) => e.code === 1 && e.message === `${BUG} is already a bug: ${bugFile(w)}`);
});

test('k bug from --no-commit only stages; a bug/<slug> anywhere already, or no draft or intake, refuses before anything moves', async () => {
  const { w } = await draftedBug();
  const head = git(w.hub, 'rev-parse', 'HEAD');
  git(w.weather, 'branch', 'bug/stale-tiles');
  assert.throws(() => from({ ws: w.ws, id: BUG, quadDamage: 'yes' }), (e) => e.code === 1 && /^bug\/stale-tiles exists already in weather: a bug's fix branch is its own/.test(e.message));
  assert.ok(existsSync(draftFile(w)));
  assert.equal(git(w.self, 'branch', '--list', 'draft/stale-tiles'), 'draft/stale-tiles');
  git(w.weather, 'branch', '-D', 'bug/stale-tiles');
  assert.throws(() => from({ ws: w.ws, id: 'hub/none', quadDamage: 'yes' }), (e) => e.code === 1 && /^no draft or intake hub\/none: /.test(e.message));
  put(draftFile(w, 'offline-forecast', 'weather'), '---\nid: weather/offline-forecast\n---\n');
  assert.throws(() => from({ ws: w.ws, id: TASK, quadDamage: 'yes' }), (e) => e.code === 1 && /is an approved task \(kirunak\/approvals\/offline-forecast\.json\)/.test(e.message));

  const r = from({ ws: w.ws, id: BUG, quadDamage: 'yes', noCommit: true });
  assert.equal(r.commits[0].commit, null);
  assert.equal(git(w.hub, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(moved(git(w.hub, 'diff', '--cached', '--name-status', '-M')), MOVED);
  assert.equal(git(w.self, 'rev-parse', '--abbrev-ref', 'bug/stale-tiles'), 'bug/stale-tiles');
});

test('AC-3: k bug from moves a task whose intake is not approved, its folder whole; draft.md becomes the bug, or a skeleton is left', async () => {
  const w = await bugWorkspace({ accepted: false });
  const dir = join(rootOf(w), 'kirunak', 'tasks', 'offline-forecast');
  const intake = readFileSync(join(dir, 'intake.md'));
  const r = from({ ws: w.ws, id: TASK, quadDamage: 'no' });
  assert.deepEqual([r.kind, r.skeleton, r.moves], ['intake', true, [{ from: 'kirunak/tasks/offline-forecast', to: 'kirunak/bugs/offline-forecast' }]]);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readFileSync(join(w.weather, 'kirunak', 'bugs', 'offline-forecast', 'intake.md')), intake);
  assert.match(git(w.weather, 'log', '-1', '--format=%s'), /^kirunak: weather\/offline-forecast is a bug: its intake, never approved, moved/);
  assert.equal(git(w.weather, 'status', '--porcelain'), '?? kirunak/bugs/offline-forecast.md');
  assert.match(readFileSync(bugFile(w, 'offline-forecast', 'weather'), 'utf8'), /^---\nid: weather\/offline-forecast\ntitle: The last forecast stays readable offline\nwritten: \d{4}-\d\d-\d\d\nquad-damage: no\n---\n\n## Who raised it\n<!-- fill in/);

  // With a draft.md the intake took, that draft is the bug, its history kept.
  const v = await bugWorkspace({ accepted: false });
  const vdir = join(rootOf(v), 'kirunak', 'tasks', 'offline-forecast');
  put(join(vdir, 'draft.md'), filled({ id: TASK, front: '', mark: '', fix: null }));
  gitCommitAll(v.weather, 'the intake took a draft');
  from({ ws: v.ws, id: TASK, quadDamage: 'no' });
  assert.equal(git(v.weather, 'status', '--porcelain'), '');
  // The draft is marked as it moves, so its rename carries the one line of the mark.
  assert.match(git(v.weather, 'show', '--name-status', '--format=', '-M', 'HEAD'), new RegExp(`^${[
    'R09\\d\tkirunak/tasks/offline-forecast/draft.md\tkirunak/bugs/offline-forecast.md',
    'R100\tkirunak/tasks/offline-forecast/intake.md\tkirunak/bugs/offline-forecast/intake.md',
    'R100\tkirunak/tasks/offline-forecast/task.md\tkirunak/bugs/offline-forecast/task.md',
  ].join('\n')}$`));
  assert.match(readFileSync(bugFile(v, 'offline-forecast', 'weather'), 'utf8'), /\nwritten: 2026-10-22\nquad-damage: no\n---\n/);
  assert.deepEqual(checkBug(v.ws, TASK), []);
});

test('k bug from refuses an approved task, naming its review, an amendment or a bug of it', async () => {
  const w = await bugWorkspace({ accepted: false });
  await approve({ ws: w.ws, id: TASK });
  for (const dryRun of [false, true]) {
    assert.throws(() => from({ ws: w.ws, id: TASK, quadDamage: 'yes', dryRun }), (e) => e.code === 1 && e.message ===
      `${TASK} is an approved task (kirunak/approvals/offline-forecast.json): only a draft or a task whose intake is not approved moves into kirunak/bugs/; ` +
      `a fault in an approved task goes into it, through its review or an amendment (k amend new ${TASK} --title "..."), and once it is accepted, into a bug of it (k bug new <repo>/<slug> --bug-of ${TASK})`);
  }
  assert.ok(existsSync(join(rootOf(w), 'kirunak', 'tasks', 'offline-forecast', 'task.md')));
  assert.equal(verify(w.ws, TASK), 'ok');
});

test('AC-2, AC-3: every bug carries its mark, quad-damage yes or no; new and from refuse one without it, the check one with neither, k bugs reads it', async () => {
  const hint = 'yes when Quad Damage may take the bug (the k-bug skill says when), else no';
  const problems = (mark) => checkBugText(filled({ mark }), BUG);
  assert.deepEqual(problems('quad-damage: no\n'), []);
  assert.deepEqual(problems(''), [{ line: 1, problem: `front matter has no quad-damage: write quad-damage: ${hint}` }]);
  const at = lineOf(filled(), 'quad-damage:');
  assert.deepEqual(problems('quad-damage:\n'), [{ line: at, problem: `quad-damage is empty: ${hint}` }]);
  assert.deepEqual(problems('quad-damage: maybe\n'), [{ line: at, problem: `quad-damage maybe is neither yes nor no: ${hint}` }]);
  assert.deepEqual(problems('quad-damage: Yes\n').map((p) => p.problem), [`quad-damage Yes is neither yes nor no: ${hint}`]);

  // k bug new and k bug from refuse before anything is written or moved, a dry run too.
  const { w } = await draftedBug();
  const refused = (given) => (e) => e.code === 2 && e.message === `${given}: ${hint}`;
  const none = 'a bug needs its mark, --quad-damage yes or --quad-damage no';
  for (const dryRun of [false, true]) {
    assert.throws(() => newBug({ ws: w.ws, id: 'weather/slow-start', title: 'Slow start', dryRun }), refused(none));
    assert.throws(() => newBug({ ws: w.ws, id: 'weather/slow-start', title: 'Slow start', quadDamage: 'maybe', dryRun }), refused('--quad-damage maybe is neither yes nor no'));
    assert.throws(() => from({ ws: w.ws, id: BUG, dryRun }), refused(none));
    assert.throws(() => from({ ws: w.ws, id: BUG, quadDamage: ' ', dryRun }), refused(none));
  }
  assert.equal(existsSync(bugFile(w, 'slow-start', 'weather')), false);
  assert.equal(existsSync(draftFile(w)), true);

  // The draft is marked as it moves; k bugs carries the mark, false when it is no or missing.
  from({ ws: w.ws, id: BUG, quadDamage: 'no' });
  assert.equal(parseDraft(readFileSync(bugFile(w), 'utf8')).front['quad-damage'], 'no');
  put(bugFile(w, 'a'), filled({ id: 'hub/a', fix: null }));
  put(bugFile(w, 'b'), filled({ id: 'hub/b', mark: '', fix: null }));
  assert.deepEqual(list(w.ws).map((r) => [r.id, r.quadDamage]), [[BUG, false], ['hub/a', true], ['hub/b', false]]);

  // The CLI: the option is needed and takes a value.
  const run = (...args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  const nu = (...more) => run('bug', 'new', 'weather/slow-start', '--title', 'Slow start', ...more);
  for (const r of [nu(), nu('--quad-damage', 'maybe'), nu('--quad-damage'), run('bug', 'from', 'weather/wind-alerts')]) {
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /--quad-damage/);
  }
  assert.equal(existsSync(bugFile(w, 'slow-start', 'weather')), false);
});

test('the verbs: k bug new, check, drop and from, and k bugs, with --json and --dry-run, in the help', async () => {
  const { w } = await draftedBug();
  const run = (...args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  const help = run('help').stdout;
  assert.match(help, /k bug new <repo>\/<slug> --title "\.\.\." --quad-damage yes\|no \[--bug-of <task>\] \[--fix-repo <repo>\]/);
  assert.match(help, /k bug from <id> --quad-damage yes\|no \[--no-commit\]/);
  assert.doesNotMatch(help, /--bug-of <task>: a bug of that accepted task/);
  const nu = (...more) => run('bug', 'new', 'weather/slow-start', '--title', 'Slow start', '--quad-damage', 'no', ...more);
  assert.equal(nu('--bug-of', TASK, '--dry-run').stdout, `would write ${bugFile(w, 'slow-start', 'weather')}, a bug of ${TASK}\n`);
  assert.equal(nu('--bug-of').status, 2);
  assert.equal(nu('--fix-repo', 'radio').status, 1);
  const made = nu('--fix-repo', 'kirunak');
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /, its fix in kirunak: fill in every section \(name the fix on bug\/slow-start under Fix written, or delete that section when no fix exists\), then `k bug check weather\/slow-start`, and commit it\n$/);
  assert.equal(run('bug', 'check', 'weather/slow-start').status, 1);
  assert.match(run('bug', 'from', BUG, '--quad-damage', 'yes', '--dry-run').stdout, /^would move the draft hub\/stale-tiles into kirunak\/bugs\/:\n  kirunak\/drafts\/stale-tiles\.md -> kirunak\/bugs\/stale-tiles\.md\n  kirunak: branch draft\/stale-tiles -> bug\/stale-tiles\n/);
  const moved = run('bug', 'from', BUG, '--quad-damage', 'yes', '--json');
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(JSON.parse(moved.stdout).kind, 'draft');
  assert.equal(run('bug', 'check', BUG).stdout, `${BUG}: check passes\n`);
  const rows = JSON.parse(run('bugs', '--json').stdout);
  assert.deepEqual(rows.map((r) => [r.id, r.fixReady]), [[BUG, true], ['weather/slow-start', false]]);
  assert.match(run('bugs').stdout, /^hub\/stale-tiles     Stale map tiles  2026-10-22  fix ready, bug of weather\/offline-forecast\n/);
  assert.equal(run('bugs', 'move').status, 2);
  assert.equal(run('bug', 'fix', BUG).status, 2);
  const dropped = run('bug', 'drop', BUG, '--why', 'fixed elsewhere');
  assert.equal(dropped.status, 0, dropped.stderr);
  assert.match(dropped.stdout, /^hub\/stale-tiles: dropped in [0-9a-f]+; its fix branch bug\/stale-tiles is kept in kirunak\n$/);
  assert.equal(bugPaths(w.ws, BUG).dirRel, 'kirunak/bugs/stale-tiles');
});

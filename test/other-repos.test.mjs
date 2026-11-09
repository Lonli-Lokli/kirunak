import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accept } from '../lib/approval.mjs';
import * as steps from '../lib/steps.mjs';
import { acceptRow } from '../lib/waiting.mjs';
import { approvedWorkspace, gitCommitAll, gitInit, k, reviewsRan, sh } from './helpers.mjs';

// A task's change in other repos (gulnya/kirunak-review-base): found by itself in the workspace's repos (AC-8, D-2),
// added by repos.md (AC-9), and a repos.md line kirunak cannot read stopping the review (E-6).

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1
inputs: task
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

// A file of the repo at `dir` written and committed alone. → the commit's short hash
function work(dir, path, text, message, env) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
  sh(dir, 'git', ['add', '--', path], env);
  sh(dir, 'git', ['commit', '-qm', message, '--', path], env);
  return sh(dir, 'git', ['rev-parse', '--short', 'HEAD']).trim();
}

const brief = (w) => steps.brief({ ws: w.ws, id: w.id, step: 'S-2', session: 'rev-1' });
const inDir = (w) => join(w.p.dir, 'steps', 'S-2', 'in');
const patchOf = (w, name) => readFileSync(join(inDir(w), 'repos', `${name}.patch`), 'utf8');
const files = (patch) => [...patch.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1]);
const given = (w) => JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-2', 'given.json'), 'utf8'));
const hand = (w, ...lines) => writeFileSync(join(w.p.dir, 'repos.md'), `# Where the work is\n\nProse, not a line.\n${lines.map((l) => `- ${l}\n`).join('')}`);

test('a commit naming the task in another workspace repo, on a side branch, is found; its slug alone or a commit before the approval is not (AC-8, D-2)', async () => {
  const w = await approvedWorkspace(PLAN);
  const old = { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' };
  work(w.hub, 'tools/old.txt', 'old\n', `tools/old.txt (${w.id})`, old);
  sh(w.hub, 'git', ['checkout', '-qb', 'side']);
  const named = work(w.hub, 'tools/cache.txt', 'three days\n', `tools/cache.txt (${w.id} S-1)`);
  work(w.hub, 'tools/slug.txt', 'slug\n', 'tools/slug.txt (offline-forecast)');
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  const { text } = await brief(w);
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/cache.txt']);
  const head = sh(w.hub, 'git', ['rev-parse', '--short', 'side']).trim();
  const base = sh(w.hub, 'git', ['rev-parse', '--short', `${named}^`]).trim();
  assert.deepEqual(given(w).repos, [{ name: 'hub', root: realpathSync(w.hub), ref: 'side', base, head, files: ['tools/cache.txt'] }]);
  assert.ok(text.includes(`\`kirunak/tasks/offline-forecast/steps/S-2/in/repos/hub.patch\`: the task's change in hub`), 'the brief names the patch');
  assert.ok(text.includes(`from ${base} to ${head} (side)`));
  assert.ok(text.includes('So is each other repo, at the head its patch names. A `met` row cites a file there under the root its patch line names, `file <root>/<path>:<line>`, and it must exist at that head.'));
});

test('the queue\'s own commit naming the task in another repo brings no patch: records are never a change (E-2)', async () => {
  const w = await approvedWorkspace(PLAN);
  assert.match(sh(w.hub, 'git', ['log', '-1', '--format=%s']), /weather\/offline-forecast/, 'the approval queued it in hub');
  await brief(w);
  assert.ok(!existsSync(join(inDir(w), 'repos')));
  assert.deepEqual(given(w).repos, []);
});

test('a branch named after the task holds a commit naming no task: found unmerged, and merged by its reflog; other work there is left out (D-2)', async () => {
  const w = await approvedWorkspace(PLAN);
  work(w.hub, 'tools/before.txt', 'before\n', 'tools/before.txt: other work on master');
  sh(w.hub, 'git', ['checkout', '-qb', 'offline-forecast']);
  const quiet = work(w.hub, 'tools/quiet.txt', 'quiet\n', 'tools/quiet.txt: names nothing');
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  work(w.hub, 'tools/after.txt', 'after\n', 'tools/after.txt: other work on master');
  let { text } = await brief(w);
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/quiet.txt'], 'unmerged: master..branch');
  assert.equal(given(w).repos[0].ref, 'offline-forecast');
  assert.ok(text.includes(`- hub \`${quiet}\` tools/quiet.txt: names nothing: tools/quiet.txt`), 'listed as naming no task (AC-7)');
  sh(w.hub, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge the branch', 'offline-forecast']);
  ({ text } = await brief(w));
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/quiet.txt'], 'merged: from the commit its reflog was created from');
  assert.equal(given(w).repos[0].ref, 'master', 'the default branch first on a tie');
});

test('a branch with the slug in a repo that has a task of that slug is that task\'s, not this one\'s (D-2)', async () => {
  const w = await approvedWorkspace(PLAN);
  work(w.hub, 'kirunak/tasks/offline-forecast/task.md', '# hub\'s own task\n', 'kirunak: intake hub/offline-forecast');
  sh(w.hub, 'git', ['checkout', '-qb', 'offline-forecast']);
  work(w.hub, 'tools/theirs.txt', 'theirs\n', 'tools/theirs.txt');
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  await brief(w);
  assert.deepEqual(given(w).repos, []);
});

test('commits on two branches: the diff is read at the one holding the most, and the brief lists what it does not hold', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.hub, 'git', ['checkout', '-qb', 'a-side']);
  work(w.hub, 'tools/a1.txt', 'a1\n', `tools/a1.txt (${w.id})`);
  work(w.hub, 'tools/a2.txt', 'a2\n', `tools/a2.txt (${w.id})`);
  sh(w.hub, 'git', ['checkout', '-q', '-b', 'b-side', 'master']);
  const b = work(w.hub, 'tools/b.txt', 'b\n', `tools/b.txt (${w.id})`);
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  const { text } = await brief(w);
  assert.equal(given(w).repos[0].ref, 'a-side');
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/a1.txt', 'tools/a2.txt']);
  assert.ok(text.includes(`Not in it: \`${b}\` tools/b.txt (${w.id}), on b-side.`));
});

test('repos.md adds a repo by its path with a branch, a range in a repo kirunak found, and a range in the task\'s own repo (AC-9)', async () => {
  const w = await approvedWorkspace(PLAN);
  const tools = join(w.root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'README.md'), 'tools\n');
  gitInit(tools);
  gitCommitAll(tools);
  sh(tools, 'git', ['checkout', '-qb', 'feature']);
  work(tools, 'src/a.txt', 'a\n', 'src/a.txt: names nothing');
  sh(tools, 'git', ['checkout', '-q', 'master']);
  work(w.hub, 'tools/named.txt', 'named\n', `tools/named.txt (${w.id})`);
  const from = sh(w.hub, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const to = work(w.hub, 'tools/ranged.txt', 'ranged\n', 'tools/ranged.txt: names nothing');
  const ownFrom = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const ownTo = work(w.weather, 'src/theirs.txt', 'theirs\n', 'src/theirs.txt (weather/other-thing)');
  work(w.weather, 'kirunak/tasks/other-thing/task.md', '# another\n', 'kirunak: intake weather/other-thing');
  hand(w, `${tools} feature`, `hub ${from}..${to}`, `weather ${ownFrom}..${ownTo}`);
  await brief(w);
  assert.deepEqual(files(patchOf(w, 'tools')), ['src/a.txt']);
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/named.txt', 'tools/ranged.txt']);
  assert.deepEqual(files(readFileSync(join(inDir(w), 'diff.patch'), 'utf8')), ['src/theirs.txt'], 'a commit naming only another task, added by hand');
  assert.deepEqual(given(w).repos.map((r) => [r.name, r.ref]), [['hub', 'master'], ['tools', 'feature']]);
});

test('a repos.md line kirunak cannot read stops the review from starting, and kirunak names the line (E-6)', async () => {
  const w = await approvedWorkspace(PLAN);
  const plain = join(w.root, 'plain');
  mkdirSync(plain);
  hand(w, 'nowhere main', `${plain} main`, 'hub no-such-branch', 'hub abc1234..def5678', 'hub', 'hub master extra');
  await assert.rejects(brief(w), (e) => {
    for (const line of [
      'line 4, "- nowhere main": nowhere is neither a repo of the workspace nor a git repository',
      `line 5, "- ${plain} main": ${plain} is neither a repo of the workspace nor a git repository`,
      'line 6, "- hub no-such-branch": ' ,
      'has no branch no-such-branch',
      'line 7, "- hub abc1234..def5678": git cannot read the range abc1234..def5678',
      'line 8, "- hub": a line is',
      'line 9, "- hub master extra": a line is',
    ]) assert.ok(e.message.includes(line), `${line}\n${e.message}`);
    return /names what kirunak cannot read, so the review cannot start/.test(e.message);
  });
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  writeFileSync(join(w.p.dir, 'steps', 'S-1', 'report.md'), 'done');
  mkdirSync(join(w.p.dir, 'evidence'), { recursive: true });
  writeFileSync(join(w.p.dir, 'evidence', 'S-1-cache-sizes.tsv'), 'x');
  assert.equal(k(w.home, ['step', 'finish', w.id, 'S-1']).status, 0);
  const r = k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 4, "- nowhere main"/);
  assert.ok(!existsSync(join(w.p.dir, 'steps', 'S-2', 'in')), 'nothing written');
});

test('a repo whose default branch is only on its remote: the branch rule finds nothing there, and the commits naming the task are still found', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.hub, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  sh(w.hub, 'git', ['checkout', '-qb', 'offline-forecast']);
  work(w.hub, 'tools/quiet.txt', 'quiet\n', 'tools/quiet.txt: names nothing');
  work(w.hub, 'tools/named.txt', 'named\n', `tools/named.txt (${w.id})`);
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  await brief(w);
  assert.deepEqual(files(patchOf(w, 'hub')), ['tools/named.txt']);
});

test('a repos.md branch line whose start kirunak cannot tell refuses rather than adding nothing: the default branch itself, merged with no reflog, no default branch of its own (E-6)', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.hub, 'git', ['checkout', '-qb', 'merged']);
  work(w.hub, 'tools/merged.txt', 'merged\n', 'tools/merged.txt');
  sh(w.hub, 'git', ['checkout', '-q', 'master']);
  sh(w.hub, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge merged', 'merged']);
  sh(w.hub, 'git', ['reflog', 'expire', '--expire=now', 'refs/heads/merged']);
  hand(w, 'hub master', 'hub merged');
  await assert.rejects(brief(w), (e) => {
    assert.ok(e.message.includes('line 4, "- hub master": master is the default branch itself: give a range instead, `<from>..master`'), e.message);
    assert.ok(e.message.includes('line 5, "- hub merged": kirunak cannot tell where merged began: it is merged into master and has no reflog'), e.message);
    return true;
  });
  sh(w.hub, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  hand(w, 'hub merged');
  await assert.rejects(brief(w), /line 4, "- hub merged": kirunak cannot tell where merged began, .* having no default branch of its own/);
});

test('a range of the task\'s own repo on a branch other than the folder\'s comes as its own patch, not an empty diff.patch (bug gulnya/review-own-repo-range-empty)', async () => {
  const w = await approvedWorkspace(PLAN);
  const from = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  sh(w.weather, 'git', ['checkout', '-qb', 'code']);
  work(w.weather, 'src/cache.txt', 'three days\n', 'src/cache.txt: names nothing');
  const to = work(w.weather, 'src/zoom.txt', 'zoom\n', 'src/zoom.txt: names nothing');
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  hand(w, `weather ${from}..${to}`);
  const { text } = await brief(w);
  assert.equal(readFileSync(join(inDir(w), 'diff.patch'), 'utf8'), '', 'the folder\'s branch never changed those files');
  assert.deepEqual(files(patchOf(w, 'weather')), ['src/cache.txt', 'src/zoom.txt']);
  assert.ok(text.includes(`\`kirunak/tasks/offline-forecast/steps/S-2/in/repos/weather.patch\`: repos.md's lines in the task's own repo, weather`), 'the brief names the patch');
  assert.ok(text.includes(`from ${from} to ${to} (${to})`));
  assert.deepEqual(given(w).repos, [], 'given.json\'s repos stay the other repos');
});

test('an own-repo range already merged into the folder\'s branch still comes as its own patch (bug gulnya/review-own-repo-range-empty, edge case)', async () => {
  const w = await approvedWorkspace(PLAN);
  const from = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const to = work(w.weather, 'src/cache.txt', 'three days\n', 'src/cache.txt: names nothing');
  hand(w, `weather ${from}..${to}`);
  await brief(w);
  assert.deepEqual(files(readFileSync(join(inDir(w), 'diff.patch'), 'utf8')), ['src/cache.txt']);
  assert.deepEqual(files(patchOf(w, 'weather')), ['src/cache.txt']);
});

// The task's own-repo work on a branch the checkout is not on (gulnya/review-own-repo-branch): `branch` of weather, made
// from master in the worktree `at` when given, holds a commit naming no task and one naming the task; then on master,
// where the checkout stays, another task's commit changes one of the branch's files and a commit naming the task
// another file. → { base, head, master, quiet }: where the branch left master, its head, master's head, the commit
// naming no task
function ownBranch(w, branch, at = null) {
  work(w.weather, 'kirunak/tasks/other-thing/task.md', '# another\n', 'kirunak: intake weather/other-thing');
  const base = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  if (at) sh(w.weather, 'git', ['worktree', 'add', '-q', '-b', branch, at, 'master']);
  else sh(w.weather, 'git', ['checkout', '-qb', branch]);
  const quiet = work(at ?? w.weather, 'src/cache.txt', 'three days\n', 'src/cache.txt: names nothing');
  const head = work(at ?? w.weather, 'src/zoom.txt', 'zoom\n', `src/zoom.txt (${w.id} S-1)`);
  if (!at) sh(w.weather, 'git', ['checkout', '-q', 'master']);
  work(w.weather, 'src/cache.txt', 'other\n', 'src/cache.txt (weather/other-thing)');
  const master = work(w.weather, 'src/forecast.txt', 'forecast\n', `src/forecast.txt (${w.id} S-1)`);
  return { base, head, master, quiet };
}

// What the review of ownBranch's task gets (AC-1, AC-2, AC-4, AC-6's first three checks).
async function seesOwnBranch(w, branch, { base, head, master, quiet }) {
  const { text } = await brief(w);
  const own = patchOf(w, 'weather');
  assert.deepEqual(files(own), ['src/cache.txt', 'src/zoom.txt'], 'in/ holds the branch\'s patch (AC-1)');
  assert.match(own, /^\+three days$/m, 'up to the branch\'s head');
  assert.doesNotMatch(own, /^\+other$/m);
  assert.deepEqual(files(readFileSync(join(inDir(w), 'diff.patch'), 'utf8')), ['src/forecast.txt'], 'diff.patch holds none of the branch\'s files (AC-2)');
  const files_ = ['src/cache.txt', 'src/zoom.txt'];
  assert.deepEqual(given(w).own, { name: 'weather', root: realpathSync(w.weather), ref: branch, base, head, files: files_, branch });
  assert.deepEqual(given(w).repos, [], 'given.json\'s repos stay the other repos');
  for (const s of [`\`kirunak/tasks/offline-forecast/steps/S-2/in/repos/weather.patch\`: the task's own-repo work is on the branch ${branch} of weather, which the checkout is not on`,
    `from ${base}, where it left master, to ${branch}'s head ${head}`, `The checkout is on master at ${master}, where \`diff.patch\` is read`,
    `- weather \`${quiet}\` src/cache.txt: names nothing: src/cache.txt`]) assert.ok(text.includes(s), `${s}\n${text}`);
  assert.equal(text.split(`\`${quiet}\``).length, 2, 'the commit naming no task is listed once');
}

test('the task\'s own-repo work on an unmerged branch named in repos.md comes as its own patch up to the branch\'s head, diff.patch holds none of its files, and the brief names the branch, its head and the checkout\'s (gulnya/review-own-repo-branch AC-1, AC-2, AC-4, AC-6)', async () => {
  const w = await approvedWorkspace(PLAN);
  const at = ownBranch(w, 'code');
  hand(w, 'weather code');
  await seesOwnBranch(w, 'code', at);
});

test('a branch of the task\'s own repo named after the task is found with no repos.md line (gulnya/review-own-repo-branch AC-5)', async () => {
  const w = await approvedWorkspace(PLAN);
  const at = ownBranch(w, 'task/offline-forecast');
  await seesOwnBranch(w, 'task/offline-forecast', at);
});

test('a repos.md line naming a worktree of the task\'s own repo with its branch is the own repo\'s branch line (gulnya/review-own-repo-branch E-3)', async () => {
  const w = await approvedWorkspace(PLAN);
  const tree = join(w.root, 'weather-code');
  const at = ownBranch(w, 'code', tree);
  hand(w, `${tree} code`);
  await seesOwnBranch(w, 'code', at);
  assert.deepEqual(readdirSync(join(inDir(w), 'repos')), ['weather.patch'], 'no part of another repo for the worktree');
});

test('the checkout on the branch itself, or the branch merged before the review, gives no second patch; diff.patch is the branch\'s change (gulnya/review-own-repo-branch E-4)', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.weather, 'git', ['checkout', '-qb', 'offline-forecast']);
  work(w.weather, 'src/cache.txt', 'three days\n', 'src/cache.txt: names nothing');
  hand(w, 'weather offline-forecast');
  await brief(w);
  assert.ok(!existsSync(join(inDir(w), 'repos')), 'the checkout on the branch');
  assert.equal(given(w).own, undefined);
  assert.deepEqual(files(readFileSync(join(inDir(w), 'diff.patch'), 'utf8')), ['src/cache.txt']);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  sh(w.weather, 'git', ['checkout', '-qb', 'code']);
  work(w.weather, 'src/zoom.txt', 'zoom\n', 'src/zoom.txt: names nothing');
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge offline-forecast', 'offline-forecast']);
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge code', 'code']);
  hand(w, 'weather code');
  await brief(w);
  assert.ok(!existsSync(join(inDir(w), 'repos')), 'both merged into the checkout\'s branch');
  assert.equal(given(w).own, undefined);
  assert.deepEqual(files(readFileSync(join(inDir(w), 'diff.patch'), 'utf8')), ['src/cache.txt', 'src/zoom.txt']);
});

test('a file the task changed on the checkout\'s branch and on the other branch is in both patches, each with its own commits\' change (gulnya/review-own-repo-branch E-6)', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.weather, 'git', ['checkout', '-qb', 'code']);
  work(w.weather, 'src/both.txt', 'on the branch\n', `src/both.txt (${w.id} S-1)`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  work(w.weather, 'src/both.txt', 'on master\n', `src/both.txt (${w.id} S-1)`);
  hand(w, 'weather code');
  await brief(w);
  const diff = readFileSync(join(inDir(w), 'diff.patch'), 'utf8');
  const own = patchOf(w, 'weather');
  assert.deepEqual(files(diff), ['src/both.txt']);
  assert.deepEqual(files(own), ['src/both.txt']);
  assert.match(diff, /^\+on master$/m);
  assert.doesNotMatch(diff, /^\+on the branch$/m);
  assert.match(own, /^\+on the branch$/m);
  assert.doesNotMatch(own, /^\+on master$/m);
});

test('kirunak\'s records on the own repo\'s branch are never in its patch: a branch of records only gives none (gulnya/review-own-repo-branch E-1)', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.weather, 'git', ['checkout', '-qb', 'offline-forecast']);
  work(w.weather, 'kirunak/tasks/offline-forecast/notes.md', 'notes\n', `kirunak: notes of ${w.id}`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  await brief(w);
  assert.ok(!existsSync(join(inDir(w), 'repos')), 'records only');
  assert.equal(given(w).own, undefined);
  sh(w.weather, 'git', ['checkout', '-q', 'offline-forecast']);
  work(w.weather, 'src/cache.txt', 'three days\n', `src/cache.txt (${w.id} S-1)`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  await brief(w);
  assert.deepEqual(files(patchOf(w, 'weather')), ['src/cache.txt']);
  assert.deepEqual(given(w).own.files, ['src/cache.txt']);
});

test('a repos.md line beside the own repo\'s branch naming a repo kirunak does not know, or a range git cannot read in the own repo, stops the review and is named (gulnya/review-own-repo-branch E-2)', async () => {
  const w = await approvedWorkspace(PLAN);
  sh(w.weather, 'git', ['branch', 'code']);
  hand(w, 'weather code', 'nowhere code', 'weather abc1234..def5678');
  await assert.rejects(brief(w), (e) => {
    assert.ok(e.message.includes('line 5, "- nowhere code": nowhere is neither a repo of the workspace nor a git repository'), e.message);
    assert.ok(e.message.includes('line 6, "- weather abc1234..def5678": git cannot read the range abc1234..def5678'), e.message);
    assert.ok(!e.message.includes('line 4'), e.message);
    return true;
  });
  assert.ok(!existsSync(join(inDir(w), 'repos')), 'nothing written');
});

// k accept on the own repo's branch (gulnya/review-own-repo-branch AC-3, E-5, E-7). The review of a brief just given,
// met on every line, at the checkout's head now; accept's dry run, and its refusal with the rows it names.
function reviewed(w) {
  const head = sh(w.weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  const first = sh(w.weather, 'git', ['log', '--diff-filter=A', '--format=%h', '--', 'kirunak/approvals/offline-forecast.json']).trim();
  const rows = ['AC-1', 'AC-2', 'AC-3', 'E-1'].map((id) => `| ${id} | met | file src/forecast.txt:1 |`).join('\n');
  writeFileSync(join(w.p.dir, 'review.md'), `---\ntask: ${w.id}\nhead: ${head}\nbase: ${first}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${rows}\n\nverdict: met\n`);
  reviewsRan(w.p.dir);
}
const accepts = (w, why) => assert.equal(accept({ ws: w.ws, id: w.id, dryRun: true }).state, 'would accept', why);
function refuses(w, rows, where) {
  assert.throws(() => accept({ ws: w.ws, id: w.id, dryRun: true }), (e) => {
    assert.match(e.message, new RegExp(`its work changed after review\\.md's head \\w+${where}, in \\d+ file\\(s\\) the review never saw`), e.message);
    assert.deepEqual(e.blocking.map((x) => `${x.path}  ${x.commit}  ${x.task}`), rows);
    for (const x of rows) assert.ok(e.message.includes(`\n  ${x}`), x);
    return true;
  });
}
const onBranch = ` \\(on weather's branch code, after the head it saw there\\)`;
const back = (w) => sh(w.weather, 'git', ['reset', '-q', '--hard', 'HEAD~1']);

// The branch code of weather, from master, holds a commit naming the task and one naming nothing, each its own file;
// master, where the checkout stays, then a commit naming the task. Nothing conflicts, so code merges cleanly.
function sideBranch(w) {
  work(w.weather, 'kirunak/tasks/other-thing/task.md', '# another\n', 'kirunak: intake weather/other-thing');
  sh(w.weather, 'git', ['checkout', '-qb', 'code']);
  work(w.weather, 'src/zoom.txt', 'zoom\n', `src/zoom.txt (${w.id} S-1)`);
  work(w.weather, 'src/cache.txt', 'three days\n', 'src/cache.txt: names nothing');
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  work(w.weather, 'src/forecast.txt', 'forecast\n', `src/forecast.txt (${w.id} S-1)`);
  hand(w, 'weather code');
}

test('k accept refuses a task whose own-repo work on an unmerged branch changed after the review, naming the branch and the file; with no new commit it accepts (gulnya/review-own-repo-branch AC-3, AC-6)', async () => {
  const w = await approvedWorkspace(PLAN);
  ownBranch(w, 'code');
  hand(w, 'weather code');
  await brief(w);
  reviewed(w);
  accepts(w, 'no new commit on the branch');
  sh(w.weather, 'git', ['checkout', '-q', 'code']);
  work(w.weather, 'kirunak/tasks/offline-forecast/notes.md', 'a note\n', `kirunak: notes (${w.id})`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  accepts(w, 'records only on the branch');
  sh(w.weather, 'git', ['checkout', '-q', 'code']);
  const a = work(w.weather, 'src/zoom.txt', 'zoom, wider\n', 'src/zoom.txt wider: names nothing');
  const b = work(w.weather, 'src/new.txt', 'new\n', `src/new.txt (${w.id} S-1)`);
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  const rows = [`code:src/zoom.txt  ${a}  no task`, `code:src/new.txt  ${b}  ${w.id}`];
  refuses(w, rows, onBranch);
  const row = await acceptRow(w.ws, { id: w.id });
  assert.deepEqual(row.blocking.map((x) => `${x.path}  ${x.commit}  ${x.task}`), rows, 'k waiting says the same');
});

test('the branch merged into the checked-out branch after the review: the commits the review saw never refuse, one it did not see does, whichever way it came (gulnya/review-own-repo-branch E-5)', async () => {
  const w = await approvedWorkspace(PLAN);
  sideBranch(w);
  await brief(w);
  assert.equal(given(w).own.branch, 'code');
  reviewed(w);
  accepts(w);
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge code', 'code']);
  accepts(w, 'merged with a merge commit');
  back(w);
  sh(w.weather, 'git', ['checkout', '-q', 'code']);
  const late = work(w.weather, 'src/cache.txt', 'four days\n', 'src/cache.txt four days: names nothing');
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  refuses(w, [`code:src/cache.txt  ${late}  no task`], onBranch);
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge code', 'code']);
  refuses(w, [`src/cache.txt  ${late}  no task`], '');
  back(w);
  sh(w.weather, 'git', ['branch', '-qf', 'code', 'code~1']);
  accepts(w, 'the late commit gone');
  const other = work(w.weather, 'src/zoom.txt', 'zoom, theirs\n', 'src/zoom.txt (weather/other-thing)');
  refuses(w, [`src/zoom.txt  ${other}  weather/other-thing`], '');
});

test('a review whose given.json has no own part is not refused for the own repo\'s branch, and a merge of it is judged as before (gulnya/review-own-repo-branch E-7)', async () => {
  const w = await approvedWorkspace(PLAN);
  sideBranch(w);
  await brief(w);
  const { own, ...before } = given(w);
  assert.ok(own);
  writeFileSync(join(w.p.dir, 'steps', 'S-2', 'given.json'), JSON.stringify(before, null, 2) + '\n');
  reviewed(w);
  sh(w.weather, 'git', ['checkout', '-q', 'code']);
  work(w.weather, 'src/cache.txt', 'four days\n', 'src/cache.txt four days: names nothing');
  sh(w.weather, 'git', ['checkout', '-q', 'master']);
  accepts(w, 'no head recorded for the branch');
  sh(w.weather, 'git', ['merge', '-q', '--no-ff', '-m', 'Merge code', 'code']);
  const zoom = sh(w.weather, 'git', ['log', '-1', '--format=%h', '--', 'src/zoom.txt']).trim();
  refuses(w, [`src/zoom.txt  ${zoom}  ${w.id}`], '');
});

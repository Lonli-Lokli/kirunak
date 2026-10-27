import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from '../lib/steps.mjs';
import { approvedWorkspace, gitCommitAll, gitInit, k, sh } from './helpers.mjs';

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
  assert.ok(text.includes('So is each other repo, at the head its patch names.'));
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

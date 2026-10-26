// The worktrees an acceptance removes (approval.md §4), on fixture repos: lib/worktrees.mjs, `k worktrees`, `k accept`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve } from '../lib/approval.mjs';
import { holdsLine, worktrees } from '../lib/worktrees.mjs';
import { gitCommitAll, gitInit, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const ID = 'weather/offline-forecast';
const NOV5 = new Date(2026, 10, 5, 9, 12, 0);
const none = () => [];
const taskDir = (weather) => join(weather, 'kirunak/tasks/offline-forecast');

// A worktree of `repo` at `path` on a new branch from master (or detached), its path as git and the module see it.
function add(repo, path, branch) {
  sh(repo, 'git', ['worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), path, 'master']);
  return realpathSync(path);
}
function commitIn(dir, file, text = file) {
  writeFileSync(join(dir, file), text);
  sh(dir, 'git', ['add', file]);
  sh(dir, 'git', ['commit', '-q', '-m', file]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
}
const ignore = (repo, ...names) => writeFileSync(join(repo, '.git', 'info', 'exclude'), names.map((n) => `${n}/\n`).join(''));
const branchExists = (repo, b) => sh(repo, 'git', ['branch', '--list', b]).trim() !== '';
const paths = (list) => list.map((w) => w.path);
const whys = (list) => Object.fromEntries(list.map((w) => [w.path, w.why]));

test('AC-1, AC-3, E-2, E-5: a merged, clean worktree goes whole with its branch, deepest first; unmerged or changed ones stay, and no main checkout is ever listed', async () => {
  const { ws, root, weather, hub } = await makeWorkspace();
  ignore(weather, 'build', 'store');
  const done = add(weather, join(root, 'done'), 'done');
  commitIn(done, 'a.txt');
  sh(weather, 'git', ['merge', '-q', '--no-ff', 'done', '-m', 'merge done']);
  mkdirSync(join(done, 'build', 'x'), { recursive: true });
  writeFileSync(join(done, 'build', 'x', 'out.bin'), 'x'.repeat(5000));
  mkdirSync(join(done, 'store'));
  writeFileSync(join(done, 'store', 'shot.png'), 'png');
  const open = add(weather, join(root, 'open'), 'open');
  commitIn(open, 'b.txt');
  const dirty = add(weather, join(root, 'dirty'), 'dirty');
  writeFileSync(join(dirty, 'README.md'), 'changed\n');
  const untracked = add(weather, join(root, 'untracked'), 'untracked');
  writeFileSync(join(untracked, 'new.txt'), 'new\n');
  mkdirSync(join(hub, 'tmp'));
  const nested = add(weather, join(hub, 'tmp', 'weather-n'), 'nested');

  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(paths(look.removed), [nested, done], 'the one inside another checkout first');
  assert.deepEqual(whys(look.kept), {
    [dirty]: '1 uncommitted change',
    [open]: 'open has 1 commit not in master',
    [untracked]: '1 uncommitted change',
  });
  assert.deepEqual(look.problems, []);
  assert.ok(existsSync(done) && existsSync(nested), 'a look removes nothing');

  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(r.removed.map((w) => [w.path, w.why, w.branchDeleted]), [
    [nested, 'nested merged into master', true],
    [done, 'done merged into master', true],
  ]);
  assert.equal(existsSync(done), false, 'with what git ignores in it (AC-3)');
  assert.equal(existsSync(nested), false);
  assert.equal(branchExists(weather, 'done'), false, 'E-2');
  assert.equal(branchExists(weather, 'nested'), false);
  for (const p of [open, dirty, untracked]) assert.ok(existsSync(p));
  assert.ok(branchExists(weather, 'open'));
  assert.ok(existsSync(weather) && existsSync(hub));
});

test('E-1: a branch whose every change is in the main line counts as merged; one more commit keeps it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const picked = add(weather, join(root, 'picked'), 'picked');
  const sha = commitIn(picked, 'c.txt');
  commitIn(weather, 'other.txt');
  sh(weather, 'git', ['cherry-pick', sha]);
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).removed), { [picked]: 'picked merged into master' });
  commitIn(picked, 'd.txt');
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [picked]: 'picked has 1 commit not in master' });
});

test("the main line is origin's HEAD branch when there is one; a worktree on the main line itself stays", async () => {
  const { ws, root, weather } = await makeWorkspace();
  sh(weather, 'git', ['branch', 'trunk']);
  sh(weather, 'git', ['update-ref', 'refs/remotes/origin/trunk', 'master']);
  sh(weather, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  sh(weather, 'git', ['checkout', '-q', '-b', 'side']);
  const trunk = add(weather, join(root, 'trunk-wt'), null);
  sh(trunk, 'git', ['checkout', '-q', 'trunk']);
  const feature = add(weather, join(root, 'feature'), 'feature');
  commitIn(feature, 'f.txt');
  sh(weather, 'git', ['branch', '-f', 'master', 'feature']);
  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.kept), { [feature]: 'feature has 1 commit not in trunk', [trunk]: 'it is trunk, the main line' });
});

test('AC-1: a worktree an open task names stays, unless that task is the one closing; a done task or a longer name does not count', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const named = add(weather, join(root, 'named'), 'named');
  const plan = join(taskDir(weather), 'plan.md');
  writeFileSync(plan, `work in ${named}-2 first\n`);
  assert.deepEqual(paths((await worktrees({ ws, processes: none })).removed), [named], 'a longer name is another folder');
  writeFileSync(plan, `work in ${named}/src, then merge\n`);
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [named]: `the open task ${ID} names it (plan.md)` });
  assert.deepEqual(paths((await worktrees({ ws, closing: ID, processes: none })).removed), [named]);
  const home = process.env.HOME;
  try {
    process.env.HOME = realpathSync(root);
    writeFileSync(plan, 'work in ~/named.\n');
    assert.deepEqual(paths((await worktrees({ ws, processes: none })).kept), [named], 'from ~');
  } finally {
    process.env.HOME = home;
  }
  writeFileSync(join(taskDir(weather), 'done.json'), '{}\n');
  assert.deepEqual(paths((await worktrees({ ws, processes: none })).removed), [named], 'an accepted task is not open');
});

test('AC-1: a worktree a process works in stays (lsof), and so does every one when lsof cannot tell', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const busy = add(weather, join(root, 'busy'), 'busy');
  mkdirSync(join(busy, 'deep'));
  const child = spawn('sleep', ['30'], { cwd: join(busy, 'deep'), stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    assert.deepEqual(whys((await worktrees({ ws })).kept), { [busy]: `sleep (pid ${child.pid}) works in it` });
  } finally {
    child.kill();
  }
  assert.deepEqual(whys((await worktrees({ ws, processes: () => null })).kept), { [busy]: 'lsof cannot tell whether a process works in it or runs from it' });
});

test('E-6: a detached worktree goes only when a plugin offers it; a keep from any plugin wins; a plugin adds repos; a failing plugin removes nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const cache = add(weather, join(root, 'cache'), null);
  const merged = add(weather, join(root, 'merged'), 'merged');
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [cache]: 'detached (no branch), and no plugin offers it' });

  const extra = join(root, 'extra');
  mkdirSync(extra);
  gitInit(extra);
  writeFileSync(join(extra, 'x.txt'), 'x');
  gitCommitAll(extra);
  const outside = add(extra, join(root, 'outside'), 'outside');
  const offer = { repos: () => [extra], candidates: () => [{ path: cache, remove: true, why: 'a cache nothing pins' }], buildOutput: () => [] };
  ws.seams.worktrees = [offer];
  let look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.removed), { [cache]: 'a cache nothing pins', [merged]: 'merged merged into master', [outside]: 'outside merged into master' });

  const keeper = { repos: () => [], candidates: () => [{ path: cache, remove: false, why: 'pinned by a lock' }, { path: merged, remove: false, why: 'kept by the plugin' }], buildOutput: () => [] };
  ws.seams.worktrees = [offer, keeper];
  look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.kept), { [cache]: 'pinned by a lock', [merged]: 'kept by the plugin' });

  ws.seams.worktrees = [{ repos: () => [], candidates: () => { throw new Error('no cache folder'); }, buildOutput: () => [] }];
  look = await worktrees({ ws, processes: none });
  assert.deepEqual(paths(look.removed), [merged]);
  assert.deepEqual(look.problems, ['a worktrees plugin failed: no cache folder']);
});

test('a worktree holding another checkout stays while that one stays, and goes after it', async () => {
  const { ws, root, weather, hub } = await makeWorkspace();
  ignore(weather, 'tmp');
  const outer = add(weather, join(root, 'outer'), 'outer');
  mkdirSync(join(outer, 'tmp'));
  const inner = add(hub, join(outer, 'tmp', 'inner'), 'inner');
  commitIn(inner, 'i.txt');
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), {
    [outer]: `it holds the checkout ${inner}`,
    [inner]: 'inner has 1 commit not in master',
  });
  sh(hub, 'git', ['merge', '-q', 'inner']);
  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(paths(r.removed), [inner, outer]);
  assert.equal(existsSync(outer), false);
});

test('AC-4: what a worktree that would go holds besides build output, one short line of folders and sizes', async () => {
  const { ws, root, weather } = await makeWorkspace();
  ignore(weather, 'build', 'store', 'renders', 'a', 'b', 'c', 'd', 'e');
  writeFileSync(join(weather, '.git', 'info', 'exclude'), '*.log\n', { flag: 'a' });
  const shots = add(weather, join(root, 'shots'), 'shots');
  for (const [dir, size] of [['build/x', 900000], ['store', 300000], ['renders', 20000], ['sub/build', 50000]]) {
    mkdirSync(join(shots, dir), { recursive: true });
    writeFileSync(join(shots, dir, 'f.bin'), 'x'.repeat(size));
  }
  writeFileSync(join(shots, 'store', 'g.bin'), 'x'.repeat(10000));
  writeFileSync(join(shots, 'top.log'), 'log');
  ws.seams.worktrees = [{ repos: () => [], candidates: () => [], buildOutput: () => ['build'] }];
  const [w] = (await worktrees({ ws, sizes: true, processes: none })).removed;
  assert.match(w.holds, /^store\/ 30\dK, renders\/ 2\dK, \.\/ 4K$/);
  assert.doesNotMatch(w.holds, /build/);

  for (const d of ['a', 'b', 'c', 'd', 'e']) {
    mkdirSync(join(shots, d));
    writeFileSync(join(shots, d, 'f'), 'x');
  }
  const [many] = (await worktrees({ ws, sizes: true, processes: none })).removed;
  assert.match(many.holds, /^store\/ 30\dK, renders\/ 2\dK, (\S+ 4K, ){3}and 3 more, 12K$/);

  assert.equal(holdsLine([]), 'nothing besides build output');
});

const REVIEW = (head) => `---
task: ${ID}
head: ${head}
---

| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | file docs/offline.md:1 |
| AC-2 | met | file docs/offline.md:1 |
| AC-3 | met | file docs/offline.md:1 |
| E-1 | met | file docs/offline.md:1 |

verdict: met
`;

test('AC-2, E-4, E-7: k accept removes after its commit and prints each removed and kept; a refusal or --dry-run removes nothing; a failed removal never undoes it', async () => {
  const { ws, root, weather, home } = await makeWorkspace();
  ignore(weather, 'locked');
  const gone = add(weather, join(root, 'gone'), 'gone');
  const stays = add(weather, join(root, 'stays'), 'stays');
  commitIn(stays, 's.txt');
  const stuck = add(weather, join(root, 'stuck'), 'stuck');
  mkdirSync(join(stuck, 'locked'));
  writeFileSync(join(stuck, 'locked', 'f'), 'f');
  chmodSync(join(stuck, 'locked'), 0o555);
  try {
    await approve({ ws, id: ID, now: NOV5 });
    const refused = k(home, ['accept', ID]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /has no review/);
    assert.ok(existsSync(gone) && branchExists(weather, 'gone'), 'E-7: a refused acceptance removes nothing');

    writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim()));
    reviewsRan(taskDir(weather));
    gitCommitAll(weather, 'review');
    assert.equal(k(home, ['accept', ID, '--dry-run']).status, 0);
    assert.ok(existsSync(gone), 'nor does --dry-run');

    const preview = k(home, ['worktrees', '--closing', ID]);
    assert.equal(preview.status, 0);
    assert.match(preview.stdout, new RegExp(`^would remove ${gone} \\(gone merged into master\\): nothing besides build output$`, 'm'));
    assert.match(preview.stdout, new RegExp(`^would keep ${stays}: stays has 1 commit not in master$`, 'm'));
    assert.ok(existsSync(gone), 'k worktrees removes nothing');

    const r = k(home, ['accept', ID]);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim().split('\n');
    assert.equal(out[0], `${ID}: done`);
    assert.ok(out.includes(`removed ${gone} (gone merged into master, branch deleted)`), r.stdout);
    assert.ok(out.some((l) => l.startsWith(`kept ${stuck}: git worktree remove failed: `)), r.stdout);
    assert.ok(out.includes(`kept ${stays}: stays has 1 commit not in master`), r.stdout);
    assert.ok(existsSync(join(taskDir(weather), 'done.json')), 'E-4: the acceptance stands');
    assert.equal(existsSync(gone), false);
    assert.ok(existsSync(stays));
  } finally {
    chmodSync(join(stuck, 'locked'), 0o755);
  }
});

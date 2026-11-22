// The worktrees an acceptance removes (approval.md §4), on fixture repos: lib/worktrees.mjs, `k worktrees`, `k accept`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { approve } from '../lib/approval.mjs';
import { processPaths, readerName, samePath } from '../lib/os.mjs';
import { holdsLine, pluginsBefore, tilde, worktrees } from '../lib/worktrees.mjs';
import { gitCommitAll, gitInit, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const ID = 'weather/offline-forecast';
const NOV5 = new Date(2026, 10, 5, 9, 12, 0);
const none = () => [];
const taskDir = (weather) => join(weather, 'kirunak/tasks/offline-forecast');

// A worktree of `repo` at `path` on a new branch from master (or detached), its path as git and the module see it
// (the case on disk, and on Windows no short 8.3 name).
function add(repo, path, branch) {
  sh(repo, 'git', ['worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), path, 'master']);
  return realpathSync.native(path);
}
// A path as a regular expression matches it: Windows' `\` and the dots taken as they are.
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// A detached worktree's age (gulnya/worktree-sweep-keeps-stale D-2) is its own git folder's HEAD file's mtime: set
// here `days` and an hour back.
function aged(wt, days) {
  const head = sh(wt, 'git', ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD']).trim();
  const t = new Date(Date.now() - days * 86_400_000 - 3_600_000);
  utimesSync(head, t, t);
}

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

test('worktree-sweep-keeps-stale AC-5: with the local master behind origin/master, a branch origin/master holds (merged, or every change picked) counts as merged; one more commit keeps it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const merged = add(weather, join(root, 'merged'), 'merged');
  commitIn(merged, 'm.txt');
  const picked = add(weather, join(root, 'picked'), 'picked');
  const sha = commitIn(picked, 'p.txt');
  // origin/master: master, another commit, merged merged in and picked's change picked; the local master stays behind
  sh(weather, 'git', ['checkout', '-q', '-b', 'upstream']);
  commitIn(weather, 'other.txt');
  sh(weather, 'git', ['merge', '-q', '--no-ff', 'merged', '-m', 'merge merged']);
  sh(weather, 'git', ['cherry-pick', sha]);
  sh(weather, 'git', ['update-ref', 'refs/remotes/origin/master', 'upstream']);
  sh(weather, 'git', ['checkout', '-q', 'master']);
  sh(weather, 'git', ['branch', '-D', 'upstream']);
  let look = await worktrees({ ws, processes: none });
  assert.deepEqual(look.problems, []);
  assert.deepEqual(whys(look.kept), {});
  assert.deepEqual(whys(look.removed), { [merged]: 'merged merged into origin/master', [picked]: 'picked merged into origin/master' });
  commitIn(picked, 'q.txt');
  look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.kept), { [picked]: 'picked has 1 commit not in origin/master' });
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
  // The home folder Node reads: $HOME, on Windows %USERPROFILE%.
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const home = process.env[homeKey];
  try {
    process.env[homeKey] = realpathSync.native(root);
    writeFileSync(plan, 'work in ~/named.\n');
    assert.deepEqual(paths((await worktrees({ ws, processes: none })).kept), [named], 'from ~');
  } finally {
    process.env[homeKey] = home;
  }
  writeFileSync(join(taskDir(weather), 'done.json'), '{}\n');
  assert.deepEqual(paths((await worktrees({ ws, processes: none })).removed), [named], 'an accepted task is not open');
});

// gulnya/worktrees-read-oom: a second open task, its files written under its folder.
function openTask(weather, slug, files) {
  const dir = join(weather, 'kirunak/tasks', slug);
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'task.md'), `# ${slug}\n`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('worktree-sweep-keeps-stale AC-1, E-2: a log, evidence, a brief, a diff or any file not a written one names nothing; the cache prune\'s "kept <sha>: locked by" line keeps nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const sha = sh(weather, 'git', ['rev-parse', 'HEAD']).trim();
  // Each file names a worktree of its own, so each is seen naming nothing.
  const lines = {
    'steps/S-1/bump.log': (p) => `gradle ran in ${p}\n`,
    'evidence/S-1-live.txt': (p) => `would keep ${p}: the open task weather/x names it (plan.md)\n`,
    'steps/S-2/cache-prune.log': (p) => `kept ${sha}: locked by ${p}/games-core.lock\nkept ${sha}: locked by ${p}\n`,
    'steps/S-1/brief.md': (p) => `work in ${p}\n`,
    'steps/S-1/diff.patch': (p) => `+ cd ${p}\n`,
    'steps/S-1/report.md.log': (p) => `${p}\n`,
    'steps/S-1/evidence/report.md': (p) => `${p}\n`,
    'steps/notes/report.md': (p) => `${p}\n`,
    'evidence/plan.md': (p) => `${p}\n`,
    'evidence/S-1/needs.json': (p) => `{ "unfinished": "${p}" }\n`,
    'amendments/A-1.md': (p) => `${p}\n`,
    'handoff.md': (p) => `${p}\n`,
  };
  const wts = Object.keys(lines).map((_, i) => add(weather, join(root, `s${i}`), `s${i}`));
  openTask(weather, 'stale', Object.fromEntries(Object.entries(lines).map(([f, line], i) => [f, line(wts[i])])));
  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(look.problems, []);
  assert.deepEqual(whys(look.kept), {});
  assert.deepEqual(paths(look.removed).sort(), [...wts].sort());
});

test('worktree-sweep-keeps-stale AC-2: a worktree an open task names in task.md, plan.md, notes.md, progress.md, review.md, or a step\'s report.md or needs.json stays, the step\'s folder any step id the plan reads (S-13a, S-14-M1)', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const files = ['task.md', 'plan.md', 'notes.md', 'progress.md', 'review.md', 'steps/S-1/report.md', 'steps/S-12/needs.json',
    'steps/S-13a/report.md', 'steps/S-14-M1/needs.json', 'steps/S-13c-2/report.md', 'steps/S-13-look/report.md'];
  const wts = files.map((_, i) => add(weather, join(root, `w${i}`), `w${i}`));
  openTask(weather, 'written', Object.fromEntries(files.map((f, i) => [f, `# written\nwork in ${wts[i]}\n`])));
  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(look.problems, []);
  assert.deepEqual(paths(look.removed), []);
  assert.deepEqual(whys(look.kept), Object.fromEntries(wts.map((w, i) => [w, `the open task weather/written names it (${files[i]})`])));
});

test('read-oom AC-1, AC-2: with the written files of open tasks holding more text than the heap, k worktrees --closing finishes, and a worktree a written file names still stays', async () => {
  const { root, weather, home } = await makeWorkspace();
  const free = add(weather, join(root, 'free'), 'free');
  const named = add(weather, join(root, 'named'), 'named');
  const big = 'a line of a report that names no worktree\n'.repeat(75_000); // 3.2 MB
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`steps/S-${i + 1}/report.md`, big]));
  openTask(weather, 'heavy', { ...files, 'steps/S-31/report.md': `work in ${named}\n` });
  const r = k(home, ['worktrees', '--closing', ID], { NODE_OPTIONS: '--max-old-space-size=48' });
  assert.equal(r.status, 0, r.stderr.split('\n').find((l) => /heap|FATAL/.test(l)) ?? r.stderr);
  assert.match(r.stdout, new RegExp(`^would remove ${re(tilde(free))} \\(free merged into master\\): `, 'm'));
  assert.match(r.stdout, new RegExp(`^would keep ${re(tilde(named))}: the open task weather/heavy names it \\(steps/S-31/report\\.md\\)$`, 'm'));
});

test('read-oom AC-3: a binary file naming a worktree names nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const shot = add(weather, join(root, 'shot'), 'shot');
  openTask(weather, 'shots', { 'steps/S-1/report.md': Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n\0\0'), Buffer.from(`made in ${shot}\n`)]) });
  assert.deepEqual(paths((await worktrees({ ws, processes: none })).removed), [shot], 'a NUL byte in the first 8,000 bytes: binary');
});

test('read-oom E-1: a file that cannot be read is skipped, never a stop', { skip: process.platform === 'win32' && 'chmod cannot make a file unreadable on Windows' }, async () => {
  const { ws, root, weather } = await makeWorkspace();
  const shot = add(weather, join(root, 'shot'), 'shot');
  const dir = openTask(weather, 'shots', {});
  let look;
  writeFileSync(join(dir, 'notes.md'), `work in ${shot}\n`);
  chmodSync(join(dir, 'notes.md'), 0o000);
  try {
    look = await worktrees({ ws, processes: none });
    assert.deepEqual(look.problems, []);
    assert.deepEqual(paths(look.removed), [shot]);
  } finally {
    chmodSync(join(dir, 'notes.md'), 0o644);
  }
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [shot]: `the open task weather/shots names it (notes.md)` });
});

// A process working in the worktree is named by lsof (macOS) or /proc (Linux); Windows is asked about no process, and
// refuses to move the worktree aside at its removal.
test('AC-1: a worktree a process works in stays (lsof, /proc, or on Windows the move aside)', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const busy = add(weather, join(root, 'busy'), 'busy');
  mkdirSync(join(busy, 'deep'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: join(busy, 'deep'), stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    if (process.platform === 'win32') {
      const r = await worktrees({ ws, remove: true });
      assert.deepEqual(r.removed, []);
      assert.match(whys(r.kept)[busy], /^Windows refuses to move it \(\w+\): a process works in it$/);
      assert.ok(existsSync(join(busy, 'deep')) && branchExists(weather, 'busy'));
    } else assert.deepEqual(whys((await worktrees({ ws })).kept), { [busy]: `node (pid ${child.pid}) works in it` });
  } finally {
    child.kill();
  }
});

test('AC-1: every worktree stays when lsof or /proc cannot tell', { skip: process.platform === 'win32' && 'Windows is asked about no process, so no look fails' }, async () => {
  const { ws, root, weather } = await makeWorkspace();
  const busy = add(weather, join(root, 'busy'), 'busy');
  assert.deepEqual(whys((await worktrees({ ws, processes: () => null })).kept), { [busy]: `cannot tell whether a process works in it or runs from it (${readerName()} gave no answer)` });
});

test('E-6: a detached worktree a plugin offers goes or stays as the plugin says; a keep from any plugin wins; a plugin adds repos; a failing plugin removes nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const cache = add(weather, join(root, 'cache'), null);
  const merged = add(weather, join(root, 'merged'), 'merged');
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [cache]: 'detached on master, under an hour old, not over 3 days' });

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

test('worktree-sweep-keeps-stale AC-3, AC-4, E-1: a clean detached worktree no plugin offers, on master or origin/master and over 3 days old, goes; a younger, locked, changed, named or off-master one stays, each line saying why', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const old = add(weather, join(root, 'old'), null);
  const young = add(weather, join(root, 'young'), null);
  const locked = add(weather, join(root, 'locked'), null);
  sh(weather, 'git', ['worktree', 'lock', '--reason', 'a baseline S-4 needs', locked]);
  const off = add(weather, join(root, 'off'), null);
  const offSha = commitIn(off, 'o.txt');
  const changed = add(weather, join(root, 'changed'), null);
  writeFileSync(join(changed, 'README.md'), 'changed\n');
  const named = add(weather, join(root, 'named'), null);
  writeFileSync(join(taskDir(weather), 'plan.md'), `S-4 compares against ${named}\n`);
  // origin/master one commit ahead of the local master, a worktree detached on it
  const ahead = add(weather, join(root, 'ahead'), null);
  sh(weather, 'git', ['update-ref', 'refs/remotes/origin/master', commitIn(ahead, 'u.txt')]);
  for (const w of [old, locked, off, changed, named, ahead]) aged(w, 5);
  aged(young, 2);
  const kept = {
    [young]: 'detached on master, 2 days old, not over 3 days',
    [locked]: 'locked: a baseline S-4 needs',
    [off]: `detached, its HEAD ${offSha.slice(0, 7)} is not on master or origin/master`,
    [changed]: '1 uncommitted change',
    [named]: `the open task ${ID} names it (plan.md)`,
  };
  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(look.problems, []);
  assert.deepEqual(whys(look.removed), { [old]: 'detached on master, 5 days old', [ahead]: 'detached on origin/master, 5 days old' });
  assert.deepEqual(whys(look.kept), kept);
  assert.ok(existsSync(old) && existsSync(ahead), 'a look removes nothing');
  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(whys(r.removed), { [old]: 'detached on master, 5 days old', [ahead]: 'detached on origin/master, 5 days old' });
  assert.deepEqual(whys(r.kept), kept);
  assert.equal(existsSync(old) || existsSync(ahead), false);
  for (const p of Object.keys(kept)) assert.ok(existsSync(p), p);
});

test('worktree-sweep-keeps-stale AC-6, D-3: the plugins are asked again with gone once the other worktrees are decided, so the cache worktree only a removed worktree pinned goes in the same sweep and shows in the same dry run; a plugin that fails keeps every detached worktree', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const cache = add(weather, join(root, 'cache'), null);
  const kept = add(weather, join(root, 'kept'), null);
  for (const w of [cache, kept]) aged(w, 5);
  const pinner = add(weather, join(root, 'pinner'), 'pinner');
  const staying = add(weather, join(root, 'staying'), 'staying');
  commitIn(staying, 's.txt');
  const asked = [];
  // Each cache worktree pinned by one checkout's own file, as gulnya's plugin reads it: free once that one is gone.
  const pin = (gone, path, by) =>
    gone?.has(by) ? { path, remove: true, why: 'games-core cache, and no games-core.lock pins it' } : { path, remove: false, why: `games-core cache, pinned by the games-core.lock of ${by}, as checked out` };
  const plugin = { repos: () => [], buildOutput: () => [], candidates: ({ gone }) => (asked.push(gone && [...gone].sort()), [pin(gone, cache, pinner), pin(gone, kept, staying)]) };

  // Failing the first time, or the second, the plugin's detached worktrees stay, whatever their age.
  ws.seams.worktrees = [{ ...plugin, candidates: () => { throw new Error('no cache folder'); } }];
  let look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.removed), { [pinner]: 'pinner merged into master' });
  for (const w of [cache, kept]) assert.equal(whys(look.kept)[w], 'detached, and a worktrees plugin failed, so whether one offers it cannot be told');
  let calls = 0;
  ws.seams.worktrees = [{ ...plugin, candidates: (a) => { if (calls++) throw new Error('no cache folder'); return plugin.candidates(a); } }];
  look = await worktrees({ ws, processes: none });
  assert.deepEqual(whys(look.removed), { [pinner]: 'pinner merged into master' });
  assert.equal(whys(look.kept)[cache], `a worktrees plugin failed when asked again (it first said: games-core cache, pinned by the games-core.lock of ${pinner}, as checked out)`);
  assert.deepEqual(look.problems, ['a worktrees plugin failed: no cache folder']);

  ws.seams.worktrees = [plugin];
  asked.length = 0;
  look = await worktrees({ ws, processes: none });
  assert.deepEqual(asked, [undefined, [pinner]], 'asked first with no gone, then with what would go');
  const removed = { [pinner]: 'pinner merged into master', [cache]: 'games-core cache, and no games-core.lock pins it' };
  const stay = { [staying]: 'staying has 1 commit not in master', [kept]: `games-core cache, pinned by the games-core.lock of ${staying}, as checked out` };
  assert.deepEqual(look.problems, []);
  assert.deepEqual(whys(look.removed), removed);
  assert.deepEqual(whys(look.kept), stay);
  assert.ok(existsSync(pinner) && existsSync(cache), 'a look removes nothing');
  asked.length = 0;
  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(asked, [undefined, [pinner]]);
  assert.deepEqual(whys(r.removed), removed);
  assert.deepEqual(whys(r.kept), stay);
  assert.equal(existsSync(pinner) || existsSync(cache), false);
  assert.ok(existsSync(staying) && existsSync(kept));
});

test('a worktree holding another checkout stays while that one stays, and goes after it', async () => {
  const { ws, root, weather, hub } = await makeWorkspace();
  ignore(weather, 'tmp');
  const outer = add(weather, join(root, 'outer'), 'outer');
  mkdirSync(join(outer, 'tmp'));
  const inner = add(hub, join(outer, 'tmp', 'inner'), 'inner');
  commitIn(inner, 'i.txt');
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), {
    [outer]: `it holds the checkout ${tilde(inner)}`,
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
  // The disk a file or folder takes is the file system's: a folder's own blocks count on Linux and not on macOS, and
  // NTFS keeps a file of a few bytes in its table, taking none.
  const [w] = (await worktrees({ ws, sizes: true, processes: none })).removed;
  assert.match(w.holds, /^store\/ 3[01]\dK, renders\/ 2\dK, \.\/ \dK$/);
  assert.doesNotMatch(w.holds, /build/);

  for (const d of ['a', 'b', 'c', 'd', 'e']) {
    mkdirSync(join(shots, d));
    writeFileSync(join(shots, d, 'f'), 'x');
  }
  const [many] = (await worktrees({ ws, sizes: true, processes: none })).removed;
  assert.match(many.holds, /^store\/ 3[01]\dK, renders\/ 2\dK, (\S+ \dK, ){3}and 3 more, \d+K$/);

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
  // Windows ignores the mode of a folder: a file held open there makes the removal fail, refused the move aside.
  const held = process.platform === 'win32' ? openSync(join(stuck, 'locked', 'f'), 'r') : null;
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
    assert.match(preview.stdout, new RegExp(`^would remove ${re(tilde(gone))} \\(gone merged into master\\): nothing besides build output$`, 'm'));
    assert.match(preview.stdout, new RegExp(`^would keep ${re(tilde(stays))}: stays has 1 commit not in master$`, 'm'));
    assert.ok(existsSync(gone), 'k worktrees removes nothing');

    const r = k(home, ['accept', ID]);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim().split('\n');
    assert.equal(out[0], `${ID}: done`);
    assert.ok(out.includes(`removed ${tilde(gone)} (gone merged into master, branch deleted)`), r.stdout);
    const failed = process.platform === 'win32' ? 'Windows refuses to move it' : 'git worktree remove failed: ';
    assert.ok(out.some((l) => l.startsWith(`kept ${tilde(stuck)}: ${failed}`)), r.stdout);
    assert.ok(out.includes(`kept ${tilde(stays)}: stays has 1 commit not in master`), r.stdout);
    assert.ok(existsSync(join(taskDir(weather), 'done.json')), 'E-4: the acceptance stands');
    assert.equal(existsSync(gone), false);
    assert.ok(existsSync(stays));
  } finally {
    if (held !== null) closeSync(held);
    chmodSync(join(stuck, 'locked'), 0o755);
  }
});

test("AC-18: k accept takes the session that runs it ($CLAUDE_CODE_SESSION_ID here) out of every worktree's lock first: a merged worktree only it held goes, one another session holds stays", async () => {
  const { ws, root, weather, home } = await makeWorkspace();
  const mine = add(weather, join(root, 'mine'), 'mine');
  const shared = add(weather, join(root, 'shared'), 'shared');
  sh(weather, 'git', ['worktree', 'lock', '--reason', 'kirunak s1 2099-01-01T00:00:00.000Z', mine]);
  sh(weather, 'git', ['worktree', 'lock', '--reason', 'kirunak s1 2099-01-01T00:00:00.000Z s2 2099-01-01T00:00:00.000Z', shared]);
  await approve({ ws, id: ID, now: NOV5 });
  writeFileSync(join(taskDir(weather), 'review.md'), REVIEW(sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim()));
  reviewsRan(taskDir(weather));
  gitCommitAll(weather, 'review');
  const r = k(home, ['accept', ID], { CLAUDE_CODE_SESSION_ID: 's1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split('\n').includes(`removed ${tilde(mine)} (mine merged into master, branch deleted)`), r.stdout);
  assert.match(r.stdout, new RegExp(`^kept ${re(tilde(shared))}: locked: session s2 works in it until \\d\\d:\\d\\d$`, 'm'));
  assert.equal(existsSync(mine), false);
  assert.equal(sh(weather, 'git', ['worktree', 'list', '--porcelain']).match(/^locked (.*)$/m)?.[1], 'kirunak s2 2099-01-01T00:00:00.000Z');
});

// asilak/kirunak-worktrees-lsof-windows, asilak/kirunak-cross-platform AC-10: the cleanup as Windows reads it over
// real repos. Windows is asked about no process: the session locks and the move aside alone tell a worktree in use.
const asksNothing = (o) => processPaths({ ...o, run: () => assert.fail('Windows is asked nothing') });

test('AC-7: on win32 a merged worktree goes, and its branch with it, no process asked about', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const free = add(weather, join(root, 'free'), 'free');
  const r = await worktrees({ ws, remove: true, platform: 'win32', processes: asksNothing });
  assert.deepEqual(r.removed.map((w) => [w.path, w.why, w.branchDeleted]), [[free, 'free merged into master', true]]);
  assert.deepEqual(r.kept, []);
  assert.equal(existsSync(free), false);
  assert.equal(branchExists(weather, 'free'), false);
});

test('AC-10: on win32 the empty look is no "cannot tell": a worktree a session\'s lock holds stays, the one no lock holds goes', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const held = add(weather, join(root, 'held'), 'held');
  const free = add(weather, join(root, 'free'), 'free');
  sh(weather, 'git', ['worktree', 'lock', '--reason', 'kirunak s1 2099-01-01T00:00:00.000Z', held]);
  const until = new Date('2099-01-01T00:00:00.000Z');
  const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
  const r = await worktrees({ ws, remove: true, platform: 'win32', processes: asksNothing });
  assert.deepEqual(whys(r.kept), { [held]: `locked: session s1 works in it until ${hhmm}` });
  assert.deepEqual(paths(r.removed), [free]);
  assert.ok(existsSync(held) && branchExists(weather, 'held'));
});

// A rename that refuses as Windows does while a process works in the folder.
const refuses = (code) => () => {
  throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
};

test('AC-5 (A-1): on win32 a worktree Windows refuses to move aside is kept whole, still known to git with its branch; a later pass removes it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const held = add(weather, join(root, 'held'), 'held');
  let tried = 0;
  const look = await worktrees({ ws, platform: 'win32', processes: asksNothing, rename: () => tried++ });
  assert.deepEqual(paths(look.removed), [held]);
  assert.equal(tried, 0, 'a look moves nothing');

  const r = await worktrees({ ws, remove: true, platform: 'win32', processes: asksNothing, rename: refuses('EBUSY') });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(whys(r.kept), { [held]: 'Windows refuses to move it (EBUSY): a process works in it' });
  assert.ok(existsSync(join(held, 'README.md')), 'whole');
  assert.ok(sh(weather, 'git', ['worktree', 'list', '--porcelain']).split('\n').some((l) => l.startsWith('worktree ') && samePath(l.slice(9), held)), 'still known to git');
  assert.ok(branchExists(weather, 'held'));

  const moves = [];
  const rename = (from, to) => {
    renameSync(from, to);
    moves.push([from, to, existsSync(held)]);
  };
  const later = await worktrees({ ws, remove: true, platform: 'win32', processes: asksNothing, rename });
  const aside = `${held}.kirunak-removing`;
  assert.deepEqual(moves, [[held, aside, false], [aside, held, true]], 'aside and straight back, at its own path before the removal');
  assert.deepEqual(later.removed.map((w) => [w.path, w.branchDeleted]), [[held, true]]);
  assert.equal(existsSync(held) || existsSync(aside), false);
  assert.equal(branchExists(weather, 'held'), false);
});

test('A-1: on win32 a worktree Windows moves aside but not back is kept, the line naming both paths', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const stuck = add(weather, join(root, 'stuck'), 'stuck');
  const aside = `${stuck}.kirunak-removing`;
  const rename = (from, to) => {
    if (from === aside) refuses('EPERM')();
    renameSync(from, to);
  };
  const r = await worktrees({ ws, remove: true, platform: 'win32', processes: asksNothing, rename });
  assert.deepEqual(whys(r.kept), {
    [stuck]: `moved to ${aside} to see whether a process works in it, and Windows refuses to move it back to ${stuck} (EPERM): move it back by hand`,
  });
  assert.ok(existsSync(aside) && branchExists(weather, 'stuck'));
  renameSync(aside, stuck);
});

// A lock as a session's lease leaves it (lib/worktree-lock.mjs), or as a hand makes it; read back from git, which
// writes the path with `/` on Windows too.
const lock = (repo, path, reason) => sh(repo, 'git', ['worktree', 'lock', ...(reason === undefined ? [] : ['--reason', reason]), path]);
const lockOf = (repo, path) => {
  let at = null;
  for (const f of sh(repo, 'git', ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    if (f.startsWith('worktree ')) at = f.slice(9);
    else if (at !== null && samePath(at, path) && (f === 'locked' || f.startsWith('locked '))) return f.slice(7);
  }
  return null;
};

test('AC-2: a live lease keeps a merged worktree, any other lock keeps it as before, and a lease that ended is lifted and the worktree removed with its branch; a dry run lifts nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const now = new Date('2026-11-10T09:00:00.000Z');
  const live = add(weather, join(root, 'live'), 'live');
  const stale = add(weather, join(root, 'stale'), 'stale');
  const hand = add(weather, join(root, 'hand'), 'hand');
  const bare = add(weather, join(root, 'bare'), 'bare');
  const staleDirty = add(weather, join(root, 'stale-dirty'), 'stale-dirty');
  writeFileSync(join(staleDirty, 'README.md'), 'changed\n');
  lock(weather, live, 'kirunak s1 2026-11-10T10:30:00.000Z');
  lock(weather, stale, 'kirunak s2 2026-11-10T08:59:59.000Z');
  lock(weather, staleDirty, 'kirunak s2 2026-11-10T08:00:00.000Z');
  lock(weather, hand, 'moving disks');
  lock(weather, bare);
  const until = new Date('2026-11-10T10:30:00.000Z');
  const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
  const keeps = {
    [bare]: 'locked: no reason given',
    [hand]: 'locked: moving disks',
    [live]: `locked: session s1 works in it until ${hhmm}`,
  };

  const look = await worktrees({ ws, processes: none, now });
  assert.deepEqual(look.removed.map((w) => [w.path, w.why]), [[stale, 'would lift the lock of session s2: its lease ended 2026-11-10T08:59:59.000Z; stale merged into master']]);
  assert.deepEqual(whys(look.kept), { ...keeps, [staleDirty]: 'would lift the lock of session s2: its lease ended 2026-11-10T08:00:00.000Z; 1 uncommitted change' });
  assert.equal(lockOf(weather, stale), 'kirunak s2 2026-11-10T08:59:59.000Z', 'a dry run lifts nothing');

  const r = await worktrees({ ws, remove: true, processes: none, now });
  assert.deepEqual(r.removed.map((w) => [w.path, w.why, w.branchDeleted]), [[stale, 'lock of session s2 lifted: its lease ended 2026-11-10T08:59:59.000Z; stale merged into master', true]]);
  assert.deepEqual(whys(r.kept), { ...keeps, [staleDirty]: 'lock of session s2 lifted: its lease ended 2026-11-10T08:00:00.000Z; 1 uncommitted change' });
  assert.deepEqual(r.problems, []);
  assert.equal(existsSync(stale), false);
  assert.equal(branchExists(weather, 'stale'), false);
  assert.equal(lockOf(weather, staleDirty), null, 'lifted, though kept for its change');
  assert.deepEqual([lockOf(weather, live), lockOf(weather, hand), lockOf(weather, bare)], ['kirunak s1 2026-11-10T10:30:00.000Z', 'moving disks', '']);
  for (const p of [live, hand, bare]) assert.ok(existsSync(p) && branchExists(weather, basename(p)));

  const k2 = await worktrees({ ws, remove: true, processes: none, now: new Date('2026-11-10T10:30:00.000Z') });
  assert.deepEqual(k2.removed.map((w) => [w.path, w.branchDeleted]), [[live, true]], 'once its lease ends, the live one goes too');
});

// The local HH:MM a lease's line names.
const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const works = (session, iso) => `locked: session ${session} works in it until ${clock(iso)}`;

test('AC-2: several leases in one lock: any live one keeps the worktree, its line naming each live one; the ended ones are taken out; with none live it goes with its branch; a dry run lifts nothing', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const now = new Date('2026-11-10T09:00:00.000Z');
  const both = add(weather, join(root, 'both'), 'both');
  const mixed = add(weather, join(root, 'mixed'), 'mixed');
  const ended = add(weather, join(root, 'ended'), 'ended');
  const reasons = {
    both: 'kirunak s1 2026-11-10T10:30:00.000Z s2 2026-11-10T09:45:00.000Z',
    mixed: 'kirunak s1 2026-11-10T08:00:00.000Z s2 2026-11-10T09:45:00.000Z',
    ended: 'kirunak s1 2026-11-10T08:00:00.000Z s2 2026-11-10T08:30:00.000Z',
  };
  lock(weather, both, reasons.both);
  lock(weather, mixed, reasons.mixed);
  lock(weather, ended, reasons.ended);
  const keeps = {
    [both]: `${works('s1', '2026-11-10T10:30:00.000Z')}; ${works('s2', '2026-11-10T09:45:00.000Z')}`,
    [mixed]: works('s2', '2026-11-10T09:45:00.000Z'),
  };

  const look = await worktrees({ ws, processes: none, now });
  assert.deepEqual(whys(look.kept), keeps);
  assert.deepEqual(look.removed.map((w) => [w.path, w.why]), [[ended,
    'would lift the lock of session s1: its lease ended 2026-11-10T08:00:00.000Z; would lift the lock of session s2: its lease ended 2026-11-10T08:30:00.000Z; ended merged into master']]);
  assert.deepEqual([lockOf(weather, both), lockOf(weather, mixed), lockOf(weather, ended)], [reasons.both, reasons.mixed, reasons.ended], 'a dry run lifts nothing');

  const r = await worktrees({ ws, remove: true, processes: none, now });
  assert.deepEqual(whys(r.kept), keeps);
  assert.deepEqual(r.removed.map((w) => [w.path, w.why, w.branchDeleted]), [[ended,
    'lock of session s1 lifted: its lease ended 2026-11-10T08:00:00.000Z; lock of session s2 lifted: its lease ended 2026-11-10T08:30:00.000Z; ended merged into master', true]]);
  assert.deepEqual(r.problems, []);
  assert.equal(existsSync(ended), false);
  assert.equal(branchExists(weather, 'ended'), false);
  assert.equal(lockOf(weather, mixed), 'kirunak s2 2026-11-10T09:45:00.000Z', "the ended lease taken out, the live one's pair as it was");
  assert.equal(lockOf(weather, both), reasons.both);
});

test("AC-18: worktrees({ remove, session }) first takes the session out of every lock: a merged worktree only it held goes, one another session holds stays; a dry run or no session releases nothing", async () => {
  const { ws, root, weather, hub } = await makeWorkspace();
  const now = new Date('2026-11-10T09:00:00.000Z');
  const mine = add(weather, join(root, 'mine'), 'mine');
  const shared = add(weather, join(root, 'shared'), 'shared');
  const theirs = add(hub, join(root, 'theirs'), 'theirs');
  lock(weather, mine, 'kirunak s1 2026-11-10T10:30:00.000Z');
  lock(weather, shared, 'kirunak s1 2026-11-10T10:30:00.000Z s2 2026-11-10T10:00:00.000Z');
  lock(hub, theirs, 'kirunak s2 2026-11-10T10:00:00.000Z');

  const dry = await worktrees({ ws, processes: none, now, session: 's1' });
  assert.deepEqual(dry.removed, []);
  assert.equal(lockOf(weather, mine), 'kirunak s1 2026-11-10T10:30:00.000Z', 'a dry run releases nothing');
  const plain = await worktrees({ ws, remove: true, processes: none, now });
  assert.deepEqual(plain.removed, [], 'no session: the pass as before');
  assert.equal(whys(plain.kept)[mine], works('s1', '2026-11-10T10:30:00.000Z'));

  const r = await worktrees({ ws, remove: true, processes: none, now, session: 's1' });
  assert.deepEqual(r.removed.map((w) => [w.path, w.why, w.branchDeleted]), [[mine, 'mine merged into master', true]]);
  assert.deepEqual(whys(r.kept), { [shared]: works('s2', '2026-11-10T10:00:00.000Z'), [theirs]: works('s2', '2026-11-10T10:00:00.000Z') });
  assert.deepEqual(r.problems, []);
  assert.equal(existsSync(mine), false);
  assert.equal(lockOf(weather, shared), 'kirunak s2 2026-11-10T10:00:00.000Z');
  assert.equal(lockOf(hub, theirs), 'kirunak s2 2026-11-10T10:00:00.000Z');
});

// asilak/kirunak-worktrees-lsof-windows E-1: a bug's fix branch bug/<slug> that reads as merged.
const bugFile = (repo, slug) => {
  mkdirSync(join(repo, 'kirunak', 'bugs'), { recursive: true });
  writeFileSync(join(repo, 'kirunak', 'bugs', `${slug}.md`), `---\ntitle: ${slug}\nwritten: 2026-11-10\nquad-damage: yes\n---\n`);
};
const runOn = (home, bug) => {
  mkdirSync(join(home, 'bugs'), { recursive: true });
  writeFileSync(join(home, 'bugs', 'quad-damage.json'), JSON.stringify({ pid: process.pid, started: '2026-11-10T09:00', by: 'owner', bug, phase: 'fixing', try: 1 }));
};
const mergeNoFf = (repo, branch) => sh(repo, 'git', ['merge', '--no-ff', '-q', '-m', `Merge ${branch}`, branch]);

test('E-1: a fresh bug/<slug> whose bug is open stays, as does the branch of the bug Quad Damage is on; a merged fix with commits, or a fresh branch whose bug is gone, goes', async () => {
  const { ws, root, home, weather } = await makeWorkspace();
  bugFile(weather, 'fresh');
  bugFile(weather, 'fixed');
  bugFile(weather, 'running');
  const fresh = add(weather, join(root, 'fresh'), 'bug/fresh');
  const dropped = add(weather, join(root, 'dropped'), 'bug/dropped');
  const fixed = add(weather, join(root, 'fixed'), 'bug/fixed');
  commitIn(fixed, 'fixed.txt');
  mergeNoFf(weather, 'bug/fixed');
  const running = add(weather, join(root, 'running'), 'bug/running');
  commitIn(running, 'running.txt');
  mergeNoFf(weather, 'bug/running');
  commitIn(weather, 'later.txt');
  runOn(home, 'weather/running');

  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(whys(r.kept), {
    [fresh]: 'the bug weather/fresh is still open and bug/fresh has no commit of its own',
    [running]: 'Quad Damage is on the bug weather/running',
  });
  assert.deepEqual(whys(r.removed), { [dropped]: 'bug/dropped merged into master', [fixed]: 'bug/fixed merged into master' });
  assert.ok(existsSync(fresh) && branchExists(weather, 'bug/fresh') && existsSync(running) && branchExists(weather, 'bug/running'));
  assert.equal(branchExists(weather, 'bug/fixed'), false);

  // Review & merge's own removal of the branch it just merged: the run on that bug is its own, and the branch has
  // commits of its own, so it goes even while its bug is still listed (closing it failed).
  const own = await worktrees({ ws, remove: true, processes: none, only: { root: weather, branch: 'bug/running' } });
  assert.deepEqual(whys(own.removed), { [running]: 'bug/running merged into master' });
  assert.deepEqual(own.kept, []);

  // The bug dropped, its fresh branch goes.
  rmSync(join(weather, 'kirunak', 'bugs', 'fresh.md'));
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).removed), { [fresh]: 'bug/fresh merged into master' });
});

test('E-1: the bugs and the run are read only when a bug/<slug> is a candidate, and bugs that cannot be read keep it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const plain = add(weather, join(root, 'plain'), 'plain');
  let reads = 0;
  const counted = () => {
    reads++;
    return [];
  };
  assert.deepEqual(paths((await worktrees({ ws, processes: none, openBugs: counted, quadDamage: counted })).removed), [plain]);
  assert.equal(reads, 0);
  const fresh = add(weather, join(root, 'fresh'), 'bug/fresh');
  const failing = () => {
    throw new Error('no bugs here');
  };
  assert.deepEqual(whys((await worktrees({ ws, processes: none, openBugs: failing })).kept), { [fresh]: 'cannot tell whether its bug is open: no bugs here' });
});

// gulnya/worktree-sweep-keeps-stale AC-6, the owner's ruling 2026-11-16 ("Remove it at Review & merge"): Review &
// merge's own removal (`only`) takes the cache worktrees it freed and nothing else. The fix repo is weather; the cache
// worktrees and a stale detached one no plugin offers are hub's, a repo `only` does not look in.
async function mergedBug({ merged = true } = {}) {
  const w = await makeWorkspace();
  const { root, weather, hub } = w;
  const fix = add(weather, join(root, 'fix'), 'bug/fix');
  const head = commitIn(fix, 'fix.txt');
  if (merged) mergeNoFf(weather, 'bug/fix');
  const staying = add(weather, join(root, 'staying'), 'staying');
  commitIn(staying, 's.txt');
  const [freed, pinned, free, byBranch, stray] = ['freed', 'pinned', 'free', 'branch', 'stray'].map((n) => add(hub, join(root, `cache-${n}`), null));
  for (const c of [freed, pinned, free, byBranch, stray]) aged(c, 5);
  const asked = [];
  const pin = (path, by) => (by ? { path, remove: false, why: `games-core cache, pinned by the games-core.lock of ${by}` } : { path, remove: true, why: 'games-core cache, and no games-core.lock pins it' });
  // As gulnya's plugin reads them: a checkout's own file pins until it is in gone, a branch's lock until it is merged.
  const branchMerged = () => sh(weather, 'git', ['branch', '--merged', 'master', '--list', 'bug/fix']).trim() !== '' || sh(weather, 'git', ['branch', '--list', 'bug/fix']).trim() === '';
  const plugin = {
    repos: () => [],
    buildOutput: () => [],
    candidates: ({ gone }) => {
      asked.push(gone && [...gone].sort());
      return [
        pin(freed, gone?.has(fix) ? null : `${fix}, as checked out`),
        pin(pinned, gone?.has(staying) ? null : `${staying}, as checked out`),
        pin(free, null),
        pin(byBranch, branchMerged() ? null : 'weather bug/fix'),
      ];
    },
  };
  w.ws.seams.worktrees = [plugin];
  return { ...w, fix, head, staying, freed, pinned, free, byBranch, stray, asked, plugin };
}

test('worktree-sweep-keeps-stale AC-6: Review & merge (only) removes the cache worktree only the merged branch\'s removed worktree pinned, in the dry run too; a cache worktree a staying checkout pins, one already free and a stale detached one no plugin offers are not touched', async () => {
  const { ws, weather, fix, freed, pinned, free, byBranch, stray, asked } = await mergedBug();
  const only = { root: weather, branch: 'bug/fix' };
  const removed = { [fix]: 'bug/fix merged into master', [freed]: 'games-core cache, and no games-core.lock pins it' };
  const look = await worktrees({ ws, processes: none, only });
  assert.deepEqual(look.problems, []);
  assert.deepEqual(asked, [undefined, [fix]], 'asked first with no gone, then with what would go');
  assert.deepEqual(whys(look.removed), removed);
  assert.deepEqual(look.kept, [], 'a cache worktree still pinned, or not freed by this removal, is no line of it');
  for (const p of [fix, freed]) assert.ok(existsSync(p), 'a dry run removes nothing');

  asked.length = 0;
  const r = await worktrees({ ws, remove: true, processes: none, only });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(asked, [undefined, [fix]]);
  assert.deepEqual(whys(r.removed), removed);
  assert.deepEqual(r.kept, []);
  assert.equal(existsSync(fix) || existsSync(freed), false);
  assert.equal(branchExists(weather, 'bug/fix'), false);
  for (const p of [pinned, free, byBranch, stray]) assert.ok(existsSync(p), p);
  // The two left stale are a full sweep's: it takes them.
  const sweep = await worktrees({ ws, processes: none });
  assert.deepEqual(paths(sweep.removed).filter((p) => [free, byBranch, stray].includes(p)).sort(), [byBranch, free, stray].sort());
});

test('worktree-sweep-keeps-stale AC-6: under only, a plugin failing on either ask keeps the cache worktree, as does any usual check (changes)', async () => {
  for (const failOn of [0, 1]) {
    const { ws, weather, fix, freed, plugin } = await mergedBug();
    let calls = 0;
    ws.seams.worktrees = [{ ...plugin, candidates: (a) => { if (calls++ === failOn) throw new Error('no cache folder'); return plugin.candidates(a); } }];
    const r = await worktrees({ ws, remove: true, processes: none, only: { root: weather, branch: 'bug/fix' } });
    assert.deepEqual(whys(r.removed), { [fix]: 'bug/fix merged into master' }, `failing on ask ${failOn + 1}`);
    assert.deepEqual(r.problems, ['a worktrees plugin failed: no cache folder']);
    assert.ok(existsSync(freed), `failing on ask ${failOn + 1}`);
  }
  const { ws, weather, fix, freed } = await mergedBug();
  writeFileSync(join(freed, 'README.md'), 'changed\n');
  const r = await worktrees({ ws, remove: true, processes: none, only: { root: weather, branch: 'bug/fix' } });
  assert.deepEqual(whys(r.removed), { [fix]: 'bug/fix merged into master' });
  assert.deepEqual(whys(r.kept), { [freed]: '1 uncommitted change' });
  assert.ok(existsSync(freed));
});

test('worktree-sweep-keeps-stale AC-6: with the plugins asked before the merge (only.before), the cache worktree only the merged branch\'s lock pinned goes too; asked only after it, that one reads as free before and stays', async () => {
  for (const ahead of [true, false]) {
    const { ws, weather, fix, freed, pinned, free, byBranch, stray } = await mergedBug({ merged: false });
    const before = ahead ? await pluginsBefore({ ws, root: weather }) : undefined;
    mergeNoFf(weather, 'bug/fix');
    const r = await worktrees({ ws, remove: true, processes: none, only: { root: weather, branch: 'bug/fix', ...(before ? { before } : {}) } });
    assert.deepEqual(r.problems, []);
    const why = 'games-core cache, and no games-core.lock pins it';
    assert.deepEqual(whys(r.removed), { [fix]: 'bug/fix merged into master', [freed]: why, ...(ahead ? { [byBranch]: why } : {}) }, `before given: ${ahead}`);
    assert.equal(existsSync(byBranch), !ahead);
    for (const p of [pinned, free, stray]) assert.ok(existsSync(p), p);
  }
});

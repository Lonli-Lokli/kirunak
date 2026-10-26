// What keeps a worktree that looks merged (approval.md §4), on fixture repos: a detached HEAD on no ref, a checkout
// deep inside, a name in another case, a program run from it, a plugin's offer it cannot take; and a removal cut short.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { holdsLine, worktrees } from '../lib/worktrees.mjs';
import { gitInit, makeWorkspace, sh } from './helpers.mjs';

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const none = () => [];
const add = (repo, path, branch) => {
  sh(repo, 'git', ['worktree', 'add', '-q', ...(branch ? ['-b', branch] : ['--detach']), path, 'master']);
  return realpathSync(path);
};
const commitIn = (dir, file) => {
  writeFileSync(join(dir, file), file);
  sh(dir, 'git', ['add', file]);
  sh(dir, 'git', ['commit', '-q', '-m', file]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
};
const ignore = (repo, ...names) => writeFileSync(join(repo, '.git', 'info', 'exclude'), names.map((n) => `${n}/\n`).join(''));
const paths = (list) => list.map((w) => w.path);
const whys = (list) => Object.fromEntries(list.map((w) => [w.path, w.why]));
const offering = (...list) => [{ repos: () => [], candidates: () => list, buildOutput: () => [] }];

test('E-6: a detached worktree a plugin offers stays while its HEAD is on no branch or tag, and goes once one holds it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const cache = add(weather, join(root, 'cache'), null);
  const sha = commitIn(cache, 'own.txt');
  ws.seams.worktrees = offering({ path: cache, remove: true, why: 'a cache nothing pins' });
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [cache]: `its HEAD ${sha.slice(0, 7)} is on no branch or tag` });
  sh(weather, 'git', ['tag', 'kept-work', sha]);
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).removed), { [cache]: 'a cache nothing pins' });
});

test('a plugin cannot offer an unmerged branch worktree or the main checkout; locked and prunable worktrees stay', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const open = add(weather, join(root, 'open'), 'open');
  commitIn(open, 'b.txt');
  const locked = add(weather, join(root, 'locked'), 'locked');
  sh(weather, 'git', ['worktree', 'lock', '--reason', 'on a stick', locked]);
  const lost = add(weather, join(root, 'lost'), 'lost');
  rmSync(lost, { recursive: true });
  ws.seams.worktrees = offering(...[open, weather, locked, lost].map((path) => ({ path, remove: true, why: 'offered' })));
  const look = await worktrees({ ws, processes: none });
  assert.deepEqual(look.removed, []);
  assert.deepEqual(Object.keys(whys(look.kept)).sort(), [locked, lost, open].sort());
  assert.equal(whys(look.kept)[open], 'open has 1 commit not in master');
  assert.equal(whys(look.kept)[locked], 'locked: on a stick');
  assert.match(whys(look.kept)[lost], /^its folder is gone \(.+\): git worktree prune forgets it$/);
});

test('a checkout at any depth inside an ignored folder keeps the worktree', async () => {
  const { ws, root, weather } = await makeWorkspace();
  ignore(weather, 'tmp');
  const outer = add(weather, join(root, 'outer'), 'outer');
  const clone = join(outer, 'tmp', '1', '2', '3', '4', '5', 'clone');
  mkdirSync(clone, { recursive: true });
  gitInit(clone);
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [outer]: `it holds the checkout ${clone}` });
});

test('an open task naming the worktree in another case keeps it on macOS', { skip: process.platform !== 'darwin' }, async () => {
  const { ws, root, weather } = await makeWorkspace();
  const named = add(weather, join(root, 'Named'), 'named');
  writeFileSync(join(weather, 'kirunak/tasks/offline-forecast/plan.md'), `work in ${named.toLowerCase()} first\n`);
  assert.deepEqual(paths((await worktrees({ ws, processes: none })).kept), [named]);
});

test('a worktree a program runs from stays, wherever the program works', async () => {
  const { ws, root, weather } = await makeWorkspace();
  ignore(weather, 'bin');
  const tools = add(weather, join(root, 'tools'), 'tools');
  mkdirSync(join(tools, 'bin'));
  copyFileSync('/bin/sleep', join(tools, 'bin', 'sleep'));
  // macOS kills a copied system program unless it is signed again
  if (process.platform === 'darwin') sh(root, 'codesign', ['-f', '-s', '-', join(tools, 'bin', 'sleep')]);
  const child = spawn(join(tools, 'bin', 'sleep'), ['30'], { cwd: root, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
    assert.deepEqual(whys((await worktrees({ ws })).kept), { [tools]: `sleep (pid ${child.pid}) runs from it` });
  } finally {
    child.kill();
  }
});

test('a removal cut short (only tracked files deleted) goes with --force; anything else besides keeps it', async () => {
  const { ws, root, weather } = await makeWorkspace();
  const half = add(weather, join(root, 'half'), 'half');
  const tracked = sh(half, 'git', ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const f of tracked) unlinkSync(join(half, f));
  writeFileSync(join(half, 'mine.txt'), 'mine');
  const n = tracked.length;
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).kept), { [half]: `${n + 1} uncommitted changes` });
  unlinkSync(join(half, 'mine.txt'));
  const why = `half merged into master; its only changes are ${n} deleted tracked files, as a removal cut short leaves, so it goes with --force`;
  assert.deepEqual(whys((await worktrees({ ws, processes: none })).removed), { [half]: why });
  const r = await worktrees({ ws, remove: true, processes: none });
  assert.deepEqual(r.removed.map((w) => [w.path, w.branchDeleted]), [[half, true]]);
  assert.equal(existsSync(half), false);
});

test('AC-4: a folder named like an option is sized; a size du cannot give is shown unknown', async () => {
  const { ws, root, weather } = await makeWorkspace();
  ignore(weather, '-x', 'keep');
  const shots = add(weather, join(root, 'shots'), 'shots');
  for (const d of ['-x', 'keep']) {
    mkdirSync(join(shots, d));
    writeFileSync(join(shots, d, 'f.bin'), 'x'.repeat(20000));
  }
  const [w] = (await worktrees({ ws, sizes: true, processes: none })).removed;
  assert.match(w.holds, /^(-x\/ 2\dK, keep\/ 2\dK|keep\/ 2\dK, -x\/ 2\dK)$/);
  assert.equal(holdsLine([{ folder: 'a/', kb: 8 }, { folder: 'b/', kb: null }]), 'a/ 8K, b/ size unknown');
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => ({ folder: `${f}/`, kb: 4 }));
  assert.equal(holdsLine([...many, { folder: 'g/', kb: null }]), 'a/ 4K, b/ 4K, c/ 4K, d/ 4K, e/ 4K, and 2 more, 4K and 1 of unknown size');
});

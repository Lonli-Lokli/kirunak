// The lock a session holds on the worktree it works in (approval.md §4, AC-1): lib/worktree-lock.mjs over real temp
// repos and a fixed clock, and the freeze and SessionEnd hooks that run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { holdFor, leasesOf, releaseAll, rootsFrom, worktreeOf } from '../lib/worktree-lock.mjs';
import { gitCommitAll, gitInit, sh } from './helpers.mjs';

const NOW = new Date('2026-11-10T09:00:00.000Z');
const later = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

// A repo with one commit, its linked worktree `wt` on branch `wt`, and a second repo no workspace names.
function repos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-lock-')));
  const repo = join(root, 'app');
  mkdirSync(repo);
  gitInit(repo);
  writeFileSync(join(repo, 'README.md'), 'app\n');
  gitCommitAll(repo);
  const wt = join(root, 'app-wt');
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'wt', wt, 'master']);
  const other = join(root, 'other');
  mkdirSync(other);
  gitInit(other);
  writeFileSync(join(other, 'README.md'), 'other\n');
  gitCommitAll(other);
  const otherWt = join(root, 'other-wt');
  sh(other, 'git', ['worktree', 'add', '-q', '-b', 'wt', otherWt, 'master']);
  return { root, repo, wt, other, otherWt };
}

// The lock reason git holds for the worktree at `path`, or null.
function lockOn(repo, path) {
  const fields = sh(repo, 'git', ['worktree', 'list', '--porcelain', '-z']).split('\0');
  let at = null;
  for (const f of fields) {
    if (f.startsWith('worktree ')) at = f.slice(9);
    else if (at === path && f === 'locked') return '';
    else if (at === path && f.startsWith('locked ')) return f.slice(7);
  }
  return null;
}

test('AC-1: a first call locks for two hours, a second within the lease changes nothing, one with under an hour left renews', () => {
  const { repo, wt } = repos();
  const hold = (now, paths = [wt]) => holdFor({ session: 's1', paths, now, roots: [repo] });
  assert.deepEqual(hold(NOW), [{ path: wt, did: 'locked' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T11:00:00.000Z');
  assert.deepEqual(hold(later(59), [join(wt, 'src', 'new.mjs'), wt]), [{ path: wt, did: 'held' }], 'one worktree once, a file not there yet');
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T11:00:00.000Z');
  assert.deepEqual(hold(later(61)), [{ path: wt, did: 'renewed' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T12:01:00.000Z');
  assert.deepEqual(hold(later(200)), [{ path: wt, did: 'renewed' }], 'a lease of its own that ended is taken again');
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T14:20:00.000Z');
});

test('AC-1: two sessions hold one worktree, each renewing its own pair; a lease that ended is dropped on the next rewrite', () => {
  const { repo, wt } = repos();
  const hold = (session, now) => holdFor({ session, paths: [wt], now, roots: [repo] });
  assert.deepEqual(hold('s1', NOW), [{ path: wt, did: 'locked' }]);
  assert.deepEqual(hold('s2', later(30)), [{ path: wt, did: 'joined' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T11:00:00.000Z s2 2026-11-10T11:30:00.000Z');
  assert.deepEqual([hold('s1', later(59)), hold('s2', later(59))], [[{ path: wt, did: 'held' }], [{ path: wt, did: 'held' }]]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T11:00:00.000Z s2 2026-11-10T11:30:00.000Z');
  assert.deepEqual(hold('s1', later(61)), [{ path: wt, did: 'renewed' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s2 2026-11-10T11:30:00.000Z s1 2026-11-10T12:01:00.000Z', "s2's pair as it was");
  assert.deepEqual(hold('s2', later(91)), [{ path: wt, did: 'renewed' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T12:01:00.000Z s2 2026-11-10T12:31:00.000Z');
  // s1 stops with no SessionEnd: its lease ends at 12:01, and s3 joining at 12:10 drops it.
  assert.deepEqual(hold('s3', later(190)), [{ path: wt, did: 'joined' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s2 2026-11-10T12:31:00.000Z s3 2026-11-10T14:10:00.000Z');
});

test("AC-1: a lock of one pair, as the first lease wrote it, reads and gains a second pair; one whose lease ended loses it", () => {
  const { repo, wt } = repos();
  sh(repo, 'git', ['worktree', 'lock', '--reason', 'kirunak s2 2026-11-10T10:00:00.000Z', wt]);
  assert.deepEqual(holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] }), [{ path: wt, did: 'joined' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s2 2026-11-10T10:00:00.000Z s1 2026-11-10T11:00:00.000Z');
  sh(repo, 'git', ['worktree', 'unlock', wt]);
  sh(repo, 'git', ['worktree', 'lock', '--reason', 'kirunak s2 2026-11-10T09:30:00.000Z', wt]);
  assert.deepEqual(holdFor({ session: 's1', paths: [wt], now: later(120), roots: [repo] }), [{ path: wt, did: 'joined' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T13:00:00.000Z');
});

test('AC-1: a lock kirunak did not write is left alone', () => {
  const { repo, wt } = repos();
  sh(repo, 'git', ['worktree', 'lock', wt]);
  assert.deepEqual(holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] }), [{ path: wt, did: 'theirs' }]);
  assert.equal(lockOn(repo, wt), '');
  sh(repo, 'git', ['worktree', 'unlock', wt]);
  sh(repo, 'git', ['worktree', 'lock', '--reason', 'moving disks', wt]);
  assert.deepEqual(holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] }), [{ path: wt, did: 'theirs' }]);
  assert.equal(lockOn(repo, wt), 'moving disks');
  sh(repo, 'git', ['worktree', 'unlock', wt]);
  sh(repo, 'git', ['worktree', 'lock', '--reason', 'kirunak s2 2026-11-10T10:00:00.000Z by hand', wt]);
  assert.deepEqual(holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] }), [{ path: wt, did: 'theirs' }]);
  assert.equal(lockOn(repo, wt), 'kirunak s2 2026-11-10T10:00:00.000Z by hand');
});

test('AC-1: the main checkout, a path outside any checkout, a repo the workspace does not name and a bad session lock nothing', () => {
  const { root, repo, wt, otherWt } = repos();
  const none = (paths, extra = {}) => assert.deepEqual(holdFor({ session: 's1', paths, now: NOW, roots: [repo], ...extra }), [], JSON.stringify(paths));
  none([repo, join(repo, 'README.md')]);
  none([root, tmpdir(), '/']);
  none([otherWt]);
  none([wt], { session: '../x' });
  none([wt], { roots: null });
  none([undefined, '', 7]);
  assert.equal(worktreeOf(repo), null);
  assert.equal(worktreeOf(join(wt, 'a', 'b.txt')).path, wt);
  assert.deepEqual([lockOn(repo, repo), lockOn(repo, wt), lockOn(join(root, 'other'), otherWt)], [null, null, null]);
});

test('AC-1: a submodule-like .git file that names no worktree is no linked worktree', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-lock-sub-')));
  writeFileSync(join(dir, '.git'), 'gitdir: ../.git/modules/sub\n');
  assert.equal(worktreeOf(join(dir, 'x.txt')), null);
});

test("AC-1: releaseAll unlocks only this session's locks, in every repo given", async () => {
  const { repo, wt, other, otherWt } = repos();
  const third = join(repo, '..', 'app-wt3');
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'wt3', third, 'master']);
  const fourth = join(repo, '..', 'app-wt4');
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'wt4', fourth, 'master']);
  holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] });
  holdFor({ session: 's1', paths: [otherWt], now: NOW, roots: [other] });
  holdFor({ session: 's2', paths: [third], now: NOW, roots: [repo] });
  sh(repo, 'git', ['worktree', 'lock', '--reason', 'moving disks', fourth]);
  const r = await releaseAll({ session: 's1', roots: [repo, other] });
  assert.deepEqual(r, { unlocked: [wt, otherWt], rewritten: [], problems: [] });
  assert.equal(lockOn(repo, wt), null);
  assert.equal(lockOn(other, otherWt), null);
  assert.equal(lockOn(repo, realpathSync(third)), 'kirunak s2 2026-11-10T11:00:00.000Z');
  assert.equal(lockOn(repo, realpathSync(fourth)), 'moving disks');
  assert.deepEqual(await releaseAll({ session: 's1', roots: [repo, other] }), { unlocked: [], rewritten: [], problems: [] }, 'a second end finds none');
});

test("AC-1: releaseAll of one session leaves the others' pairs as they were, and the last one's unlocks", async () => {
  const { repo, wt } = repos();
  holdFor({ session: 's1', paths: [wt], now: NOW, roots: [repo] });
  holdFor({ session: 's2', paths: [wt], now: later(10), roots: [repo] });
  holdFor({ session: 's3', paths: [wt], now: later(20), roots: [repo] });
  assert.deepEqual(await releaseAll({ session: 's2', roots: [repo] }), { unlocked: [], rewritten: [wt], problems: [] });
  assert.equal(lockOn(repo, wt), 'kirunak s1 2026-11-10T11:00:00.000Z s3 2026-11-10T11:20:00.000Z');
  assert.deepEqual(await releaseAll({ session: 's1', roots: [repo] }), { unlocked: [], rewritten: [wt], problems: [] });
  assert.equal(lockOn(repo, wt), 'kirunak s3 2026-11-10T11:20:00.000Z');
  assert.deepEqual(await releaseAll({ session: 's3', roots: [repo] }), { unlocked: [wt], rewritten: [], problems: [] });
  assert.equal(lockOn(repo, wt), null);
});

test('leasesOf reads only the reason kirunak writes, of one pair or more', () => {
  const lease = (session, text) => ({ session, until: new Date(text), text });
  assert.deepEqual(leasesOf('kirunak s1 2026-11-10T11:00:00.000Z\n'), [lease('s1', '2026-11-10T11:00:00.000Z')]);
  assert.deepEqual(leasesOf('kirunak s1 2026-11-10T11:00:00.000Z s2 2026-11-10T12:30:00Z'), [lease('s1', '2026-11-10T11:00:00.000Z'), lease('s2', '2026-11-10T12:30:00Z')]);
  for (const r of ['', 'kirunak', 'moving disks', 'kirunak s1', 'kirunak s1 tomorrow', 'kirunak s 1 2026-11-10T11:00:00.000Z', 'kirunak s1 2026-11-10T11:00:00.000Z s2',
    'kirunak s1 2026-11-10T11:00:00.000Z s/2 2026-11-10T11:00:00.000Z', 'kirunak s1 2026-13-40T11:00:00.000Z', null]) assert.equal(leasesOf(r), null, r);
});

// The hooks as Claude Code runs them: the JSON on stdin, with $KIRUNAK_HOME holding config.json's repos.
const hook = (name) => fileURLToPath(new URL(`../hooks/${name}`, import.meta.url));
function runHook(name, input, home) {
  const env = { ...process.env, KIRUNAK_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete env[key];
  return spawnSync(process.execPath, [hook(name)], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8' });
}

test('AC-1: the freeze hook locks the worktree of the cwd and of the file an edit names, after letting the call through; SessionEnd unlocks them', () => {
  const { root, repo, wt, otherWt } = repos();
  const home = join(root, 'home');
  mkdirSync(join(home, 'escalate'), { recursive: true });
  const editIn = (dir) => ({ session_id: 's1', tool_name: 'Edit', cwd: repo, tool_input: { file_path: join(dir, 'README.md'), old_string: 'a', new_string: 'b' } });
  assert.equal(runHook('kirunak-freeze.mjs', editIn(wt), home).stdout, '');
  assert.equal(lockOn(repo, wt), null, 'without config.json nothing is locked');
  writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify({ repos: { app: repo } }));
  assert.deepEqual(rootsFrom(home), [repo]);
  const r = runHook('kirunak-freeze.mjs', editIn(wt), home);
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.match(lockOn(repo, wt), /^kirunak s1 \d{4}-\d\d-\d\dT/);
  assert.equal(lockOn(repo, repo), null, 'the main checkout never');
  runHook('kirunak-freeze.mjs', editIn(otherWt), home);
  assert.equal(lockOn(join(root, 'other'), otherWt), null, 'a repo the workspace does not name');
  const s = runHook('kirunak-unlock.mjs', { session_id: 's1', hook_event_name: 'SessionEnd', reason: 'clear' }, home);
  assert.deepEqual([s.status, s.stdout], [0, '']);
  assert.equal(lockOn(repo, wt), null);
  runHook('kirunak-freeze.mjs', { session_id: 's1', tool_name: 'Bash', cwd: join(wt, 'src'), tool_input: { command: 'ls' } }, home);
  assert.match(lockOn(repo, wt), /^kirunak s1 /, "a Bash call's cwd inside it");
  assert.equal(runHook('kirunak-unlock.mjs', 'not json', home).status, 0, 'fails open');
});

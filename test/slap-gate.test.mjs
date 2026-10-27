import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIRUNAK, gitInit, sh } from './helpers.mjs';
import { hashBytes, recordFile, repoInfo } from '../lib/slap.mjs';

// The gate's other refusals (R22, R23, design/change-size.md §3): an unapproved .slapignore, an unlisted binary
// file; and what is left out: what .slapignore lists, a file deleted whole.

// A temp repo with the hook installed as k install writes it, and its own state folder.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-slap-'));
  gitInit(dir);
  const hook = join(dir, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(hook, `#!/bin/sh\nexec node ${JSON.stringify(join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs'))} "$@"\n`);
  chmodSync(hook, 0o755);
  const home = mkdtempSync(join(tmpdir(), 'kirunak-slap-home-'));
  return { dir, home };
}

const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KIRUNAK_') && !k.startsWith('GIT_')));
const git = (r, args, env = {}) => spawnSync('git', args, { cwd: r.dir, encoding: 'utf8', env: { ...clean, KIRUNAK_HOME: r.home, ...env } });
const put = (r, path, text) => {
  mkdirSync(join(r.dir, path, '..'), { recursive: true });
  writeFileSync(join(r.dir, path), text);
};
const message = (r) => sh(r.dir, 'git', ['log', '-1', '--format=%B']).trim();
const commit = (r, msg, extra = [], env = {}) => {
  git(r, ['add', '-A']);
  return git(r, ['commit', '-q', ...extra, '-m', msg], env);
};
const root = (r) => {
  put(r, 'src/root.mjs', 'export {};\n');
  assert.equal(commit(r, 'root').status, 0);
};
// The owner's approval of the repo's .slapignore as it is now, as `k slapignore approve` records it.
const approve = (r) => {
  const key = repoInfo(r.dir).key;
  const hash = hashBytes(readFileSync(join(r.dir, '.slapignore')));
  writeFileSync(recordFile(r.home), JSON.stringify({ repos: { [key]: { hash, approved: '2026-10-18T22:00:00+02:00', by: 'owner', via: 'shell', history: [] } } }));
};

test('an approved .slapignore leaves out what it lists; an unlisted binary is refused naming its pattern', () => {
  const r = repo();
  put(r, '.slapignore', '*.md\ndata/\n*.png\n');
  approve(r);
  put(r, 'docs/research.md', lines(3000));
  put(r, 'data/table.tsv', lines(3000));
  put(r, 'img/a.png', Buffer.from([0, 1, 2, 0, 255]));
  const ok = commit(r, 'Docs and tables');
  assert.equal(ok.status, 0, ok.stderr);
  // Only .slapignore counts: three lines in one file.
  assert.match(message(r), /SLAP: 1 \(S\)$/);
  put(r, 'art/b.webp', Buffer.from([0, 9, 9, 0]));
  const res = commit(r, 'Art');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /a binary file that \.slapignore does not list: art\/b\.webp/);
  assert.match(res.stderr, /add to \.slapignore either `\*\.webp` \(every file of that type\) or `\/art\/b\.webp` \(only this one\)/);
  assert.match(res.stderr, new RegExp(`! k slapignore approve ${repoInfo(r.dir).key}`));
});

test('a .slapignore the owner has not approved refuses the commit; approved, it passes', () => {
  const r = repo();
  root(r);
  put(r, '.slapignore', '*.md\n');
  let res = commit(r, 'Starter');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no \.slapignore is approved for .* \(R23\)/);
  approve(r);
  assert.equal(commit(r, 'Starter').status, 0);
  put(r, '.slapignore', '*.md\n*.kt\n');
  res = commit(r, 'Leave out the code');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /this \.slapignore is not the one the owner approved/);
  // Approved only as it was: putting it back passes.
  put(r, '.slapignore', '*.md\n');
  put(r, 'src/a.mjs', lines(5));
  assert.equal(commit(r, 'Small').status, 0);
  // Deleting it makes everything count again, which needs no approval.
  rmSync(join(r.dir, '.slapignore'));
  assert.equal(commit(r, 'No list').status, 0);
});

test('a worktree shares the approval of its repo', () => {
  const r = repo();
  put(r, '.slapignore', '*.md\n');
  approve(r);
  assert.equal(commit(r, 'root').status, 0);
  const wt = { dir: join(mkdtempSync(join(tmpdir(), 'kirunak-wt-')), 'wt'), home: r.home };
  assert.equal(git(r, ['worktree', 'add', '-q', '-b', 'side', wt.dir]).status, 0);
  put(wt, 'notes.md', lines(500));
  const res = commit(wt, 'Notes');
  assert.equal(res.status, 0, res.stderr);
});

test('a file deleted whole is left out; lines deleted inside a kept file count', () => {
  const r = repo();
  put(r, 'src/big.mjs', lines(1000));
  put(r, 'src/kept.mjs', lines(400, 'k'));
  assert.equal(git(r, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']).status, 0);
  assert.equal(git(r, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Old work']).status, 0);
  rmSync(join(r.dir, 'src/big.mjs'));
  const ok = commit(r, 'Delete the big file');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(message(r), /SLAP: 0 \(S\)$/);
  put(r, 'src/kept.mjs', lines(100, 'k'));
  const res = commit(r, 'Cut the kept file');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /300 lines of code in 1 files/);
});

// The owner's own record commits (bug gulnya/accept-refused-by-slap): `k accept` commits done.json, which holds k cost's
// numbers (518 lines in one accept), and a starter .slapignore does not list *.json.
const ID = 'weather/offline-forecast';
const TASK_DIR = 'kirunak/tasks/offline-forecast';
const json = (n) => JSON.stringify({ task: ID, rows: Array.from({ length: n - 5 }, (_, i) => i) }, null, 1) + '\n';

test("an owner's command committing only the records of the task its variable names is not measured; one more file, or no variable, is (R22)", () => {
  const r = repo();
  put(r, '.slapignore', '*.md\n');
  approve(r);
  root(r);
  put(r, `${TASK_DIR}/done.json`, json(600));
  put(r, `${TASK_DIR}/cost.md`, lines(40));
  const plain = commit(r, `kirunak: accept ${ID}`);
  assert.notEqual(plain.status, 0, 'without the variable it is measured as any commit');
  assert.match(plain.stderr, /this commit is L, SLAP \d+: 600 lines of code in 1 files \(kirunak\/tasks\/offline-forecast\/done\.json\)/);
  const other = commit(r, `kirunak: accept ${ID}`, [], { KIRUNAK_ACCEPTING: 'weather/radar-tiles' });
  assert.notEqual(other.status, 0, "another task's id leaves it measured");
  put(r, 'src/app.kt', lines(600));
  const mixed = commit(r, `kirunak: accept ${ID}`, [], { KIRUNAK_ACCEPTING: ID });
  assert.notEqual(mixed.status, 0, 'a path besides the records keeps the whole commit measured');
  assert.match(mixed.stderr, /1200 lines of code in 2 files \(.*src\/app\.kt/);
  // As `k accept` commits (git.mjs commit): only its own paths, whatever else is staged beside them.
  const own = [`${TASK_DIR}/done.json`, `${TASK_DIR}/cost.md`];
  const ok = git(r, ['commit', '-q', '-m', `kirunak: accept ${ID}`, '--', ...own], { KIRUNAK_ACCEPTING: ID });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(message(r), /SLAP:/, 'not measured, as a merge is not');
  assert.equal(git(r, ['status', '--porcelain']).stdout, 'A  src/app.kt\n', 'the other staged file stays staged');
});

test("hold.md under KIRUNAK_HOLDING and task.md with its approval under KIRUNAK_APPROVING are the owner's records too", () => {
  const r = repo();
  root(r);
  // No .slapignore: everything counts, prose too.
  put(r, `${TASK_DIR}/hold.md`, lines(600));
  assert.notEqual(commit(r, `kirunak: hold ${ID}`).status, 0);
  const held = commit(r, `kirunak: hold ${ID}`, [], { KIRUNAK_HOLDING: ID });
  assert.equal(held.status, 0, held.stderr);
  put(r, `${TASK_DIR}/task.md`, lines(600, 't'));
  put(r, 'kirunak/approvals/offline-forecast.json', json(10));
  assert.notEqual(commit(r, `kirunak: approve ${ID}`, [], { KIRUNAK_HOLDING: ID }).status, 0, 'task.md is the approval\'s alone');
  const approved = commit(r, `kirunak: approve ${ID}`, [], { KIRUNAK_APPROVING: ID });
  assert.equal(approved.status, 0, approved.stderr);
});

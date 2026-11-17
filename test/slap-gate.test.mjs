import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { approvedWorkspace, gitInit, k, KIRUNAK, sh, tempDir } from './helpers.mjs';
import { hashBytes, recordFile, repoInfo } from '../lib/slap.mjs';

// The gate's other refusals (R22, R23, design/change-size.md §3): an unapproved .slapignore, an unlisted binary
// file; and what is left out: what .slapignore lists, a file deleted whole.

// A temp repo with the hook installed as k install writes it, and its own state folder.
function repo() {
  const dir = tempDir('kirunak-slap-');
  gitInit(dir);
  const hook = join(dir, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(hook, `#!/bin/sh\nexec node ${JSON.stringify(join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs'))} "$@"\n`);
  chmodSync(hook, 0o755);
  const home = tempDir('kirunak-slap-home-');
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
  const wt = { dir: join(tempDir('kirunak-wt-'), 'wt'), home: r.home };
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

// A step's records commit (gulnya/close-leaves-untracked-step-files AC-5, D-1): `k step finish` commits progress.md and
// the step's records under KIRUNAK_RECORDING=<id>, and a review step's given.json runs to about 500 lines.
const GIVEN = `${TASK_DIR}/steps/S-4/given.json`;
const PROGRESS = `${TASK_DIR}/progress.md`;
const records = (r, tag) => {
  put(r, GIVEN, json(500).replace(ID, `${ID} ${tag}`));
  put(r, PROGRESS, `2026-11-15 10:00 S-4 started (session ${tag})\n2026-11-15 10:30 S-4 finished\n`);
};

test("a step's records commit under KIRUNAK_RECORDING naming its task, by id or slug, is not measured; one more file, no variable or another task's is (R22)", () => {
  const r = repo();
  root(r);
  // No .slapignore: everything counts, the records' 500 lines too.
  records(r, 'a');
  const plain = commit(r, `${ID} S-4: the step's records`);
  assert.notEqual(plain.status, 0, 'without the variable it is measured as any commit');
  assert.match(plain.stderr, /this commit is L, SLAP \d+: 502 lines of code in 2 files/);
  const other = commit(r, `${ID} S-4: the step's records`, [], { KIRUNAK_RECORDING: 'weather/radar-tiles' });
  assert.notEqual(other.status, 0, "another task's id leaves it measured");
  const owner = commit(r, `${ID} S-4: the step's records`, [], { KIRUNAK_ACCEPTING: ID });
  assert.notEqual(owner.status, 0, "an owner's variable does not cover a step's records");
  put(r, 'src/app.kt', lines(20));
  const mixed = commit(r, `${ID} S-4: the step's records`, [], { KIRUNAK_RECORDING: ID });
  assert.notEqual(mixed.status, 0, 'a path besides the records keeps the whole commit measured');
  assert.match(mixed.stderr, /522 lines of code in 3 files \(.*src\/app\.kt/);
  // As `k step finish` commits (git.mjs commit): only its own paths, whatever else is staged beside them.
  const ok = git(r, ['commit', '-q', '-m', `${ID} S-4: the step's records`, '--', GIVEN, PROGRESS], { KIRUNAK_RECORDING: ID });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(message(r), /SLAP:/, 'not measured, as a merge is not');
  assert.equal(git(r, ['status', '--porcelain']).stdout, 'A  src/app.kt\n', 'the other staged file stays staged');
  assert.equal(git(r, ['restore', '--staged', 'src/app.kt']).status, 0);
  rmSync(join(r.dir, 'src/app.kt'));
  records(r, 'b');
  const bySlug = commit(r, `${ID} S-4: the step's records`, [], { KIRUNAK_RECORDING: 'offline-forecast' });
  assert.equal(bySlug.status, 0, bySlug.stderr);
  // KIRUNAK_RECORDING is no owner's variable: the owner's done.json under it is measured.
  put(r, `${TASK_DIR}/done.json`, json(600));
  const done = commit(r, `kirunak: accept ${ID}`, [], { KIRUNAK_RECORDING: ID });
  assert.notEqual(done.status, 0, "the owner's records are not a step's");
});

// test/steps.test.mjs's plan: S-1 an agent's step, S-2 its review.
const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, E-1, D-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv
budget: 80 calls

### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

test("a review step's finish commits a 500-line given.json with its progress.md in a repo with the SLAP hook (AC-5)", async () => {
  const w = await approvedWorkspace(PLAN);
  const hook = join(w.weather, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(hook, `#!/bin/sh\nexec node ${JSON.stringify(join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs'))} "$@"\n`, { mode: 0o755 });
  const wg = (...args) => sh(w.weather, 'git', args).trim();
  const task = 'kirunak/tasks/offline-forecast';
  const put2 = (rel, text) => {
    mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
    writeFileSync(join(w.p.dir, rel), text);
  };
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-1', '--session', 'impl-1']).status, 0);
  put2('steps/S-1/report.md', 'done\n');
  put2('evidence/S-1-cache-sizes.tsv', 'days\tbytes\n3\t2048\n');
  const one = k(w.home, ['step', 'finish', w.id, 'S-1']);
  assert.equal(one.status, 0, one.stderr);
  const head = wg('rev-parse', '--short', 'HEAD');
  assert.equal(k(w.home, ['step', 'start', w.id, 'S-2', '--session', 'rev-1']).status, 0);
  const given = join(w.p.dir, 'steps', 'S-2', 'given.json');
  const g = JSON.parse(readFileSync(given, 'utf8'));
  writeFileSync(given, JSON.stringify({ ...g, rows: Array.from({ length: 495 }, (_, i) => i) }, null, 1) + '\n');
  assert.ok(readFileSync(given, 'utf8').split('\n').length > 500);
  const rows = ['AC-1', 'AC-2', 'AC-3'].map((id) => `| ${id} | met | file docs/offline.md:1 |`);
  rows.push('| E-1 | met | measure evidence/S-1-cache-sizes.tsv row 2 |');
  const base = wg('log', '--diff-filter=A', '--format=%h', '--', 'kirunak/approvals/offline-forecast.json');
  put2('review.md', `---\ntask: ${w.id}\nhead: ${head}\nbase: ${base}\n---\n\n| id | verdict | evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n\nverdict: met\n`);
  const done = k(w.home, ['step', 'finish', w.id, 'S-2']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(wg('show', '--name-only', '--format=%s', 'HEAD'),
    `${w.id} S-2: the step's records\n\n${task}/progress.md\n${task}/steps/S-2/given.json`);
  assert.doesNotMatch(wg('log', '-1', '--format=%B'), /SLAP:/);
  const evidence = wg('log', '--format=%H', '--grep', `^${w.id} S-1: the step's evidence$`);
  assert.match(wg('log', '-1', '--format=%B', evidence), /SLAP: \d+ \(S\)/, "the step's evidence commit, made with no variable, is still measured");
});

// The records commit `k records` makes, and the handoff k-done commits with it after the accept, under
// KIRUNAK_RECORDING=<id> (gulnya/accept-leaves-task-files AC-5): every path in the named task's folder, task.md aside,
// is not measured however long; task.md, a source file or another task's file beside them measures the whole commit,
// and the owner's records never pass under it.
const notesMd = (n, tag = 'note') => Array.from({ length: n }, (_, i) => `- ${tag} ${i}: what the step found`).join('\n') + '\n';

test("a task folder's records commit under KIRUNAK_RECORDING, 600-line notes.md and review.md or a 600-line handoff.md, is not measured; task.md, a source file or the owner's records beside them are (AC-5)", () => {
  const r = repo();
  root(r);
  put(r, `${TASK_DIR}/task.md`, '# Task\n');
  assert.equal(commit(r, 'the task').status, 0);
  const rec = (msg, paths, env = { KIRUNAK_RECORDING: ID }) => {
    git(r, ['add', '-A', '--', ...paths]);
    return git(r, ['commit', '-q', '-m', msg, '--', ...paths], env);
  };
  const reset = () => {
    git(r, ['reset', '-q']);
    git(r, ['checkout', '-q', '--', '.']);
    git(r, ['clean', '-qfd']);
  };

  // task.md beside the records: the whole commit is measured.
  put(r, `${TASK_DIR}/notes.md`, notesMd(600));
  put(r, `${TASK_DIR}/review.md`, notesMd(600, 'row'));
  put(r, `${TASK_DIR}/task.md`, '# Task\n\nchanged\n');
  const withTask = rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, `${TASK_DIR}/review.md`, `${TASK_DIR}/task.md`]);
  assert.notEqual(withTask.status, 0, 'task.md beside them keeps the commit measured');
  assert.match(withTask.stderr, /this commit is X?L, SLAP/);
  reset();
  // A source file beside them: measured.
  put(r, `${TASK_DIR}/notes.md`, notesMd(600));
  put(r, 'src/app.kt', lines(20));
  const withSource = rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, 'src/app.kt']);
  assert.notEqual(withSource.status, 0, 'a source file beside them keeps the commit measured');
  reset();
  // Another task's notes: measured.
  put(r, 'kirunak/tasks/radar-tiles/notes.md', notesMd(600));
  assert.notEqual(rec(`kirunak: ${ID} records`, ['kirunak/tasks/radar-tiles/notes.md']).status, 0, "another task's folder is measured");
  reset();
  // The owner's records are never a session's, even in the folder.
  for (const owned of ['done.json', 'cost.md', 'hold.md']) {
    put(r, `${TASK_DIR}/notes.md`, notesMd(600));
    put(r, `${TASK_DIR}/${owned}`, json(600));
    assert.notEqual(rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, `${TASK_DIR}/${owned}`]).status, 0, `${owned} beside them keeps the commit measured`);
    reset();
  }
  // An amendment's approval, its new applied: stamp, is the owner's; the amendment a session writes is the task's.
  put(r, `${TASK_DIR}/notes.md`, notesMd(600));
  put(r, `${TASK_DIR}/amendments/A-1.md`, '---\ntask: x\n---\n\n## Why\nwhy\n\napplied: 2026-11-15\n');
  assert.notEqual(rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, `${TASK_DIR}/amendments/A-1.md`]).status, 0, "an amendment's new stamp keeps the commit measured");
  reset();
  put(r, `${TASK_DIR}/notes.md`, notesMd(600));
  put(r, `${TASK_DIR}/amendments/A-1.md`, '---\ntask: x\n---\n\n## Why\nwhy\n');
  const amendment = rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, `${TASK_DIR}/amendments/A-1.md`]);
  assert.equal(amendment.status, 0, amendment.stderr);
  // No variable: measured.
  put(r, `${TASK_DIR}/notes.md`, notesMd(600, 'again'));
  assert.notEqual(rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`], {}).status, 0, 'without the variable it is measured');
  reset();

  // The records commit: 600-line notes.md and review.md, evidence and a deletion, by slug or id.
  put(r, `${TASK_DIR}/old.md`, 'early\n');
  assert.equal(commit(r, 'old.md').status, 0);
  put(r, `${TASK_DIR}/notes.md`, notesMd(600));
  put(r, `${TASK_DIR}/review.md`, notesMd(600, 'row'));
  put(r, `${TASK_DIR}/evidence/S-1-sizes.tsv`, notesMd(300, 'size'));
  rmSync(join(r.dir, TASK_DIR, 'old.md'));
  const ok = rec(`kirunak: ${ID} records`, [`${TASK_DIR}/notes.md`, `${TASK_DIR}/review.md`, `${TASK_DIR}/evidence/S-1-sizes.tsv`, `${TASK_DIR}/old.md`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(message(r), /SLAP:/, 'not measured');
  // The handoff, alone, after the accept.
  put(r, `${TASK_DIR}/handoff.md`, notesMd(600, 'handoff'));
  const handoff = rec(`kirunak: ${ID} records`, [`${TASK_DIR}/handoff.md`], { KIRUNAK_RECORDING: 'offline-forecast' });
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.doesNotMatch(message(r), /SLAP:/);
});

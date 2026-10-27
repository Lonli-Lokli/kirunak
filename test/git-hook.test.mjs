import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../hooks/git-pre-commit.mjs';
import { costMarkdown } from '../lib/cost-md.mjs';
import { defaultBranch, mainOnDefault } from '../lib/records.mjs';
import { repoInfo } from '../lib/slap.mjs';
import { makeWorkspace } from './helpers.mjs';

// D7: the git hook refuses a commit whose frozen task no longer matches its approval (approval.md §3).

const HOOK = fileURLToPath(new URL('../hooks/git-pre-commit.mjs', import.meta.url));
const SLUG = 'offline-forecast';
const ID = `weather/${SLUG}`;
const TASK = `kirunak/tasks/${SLUG}/task.md`;
const RECORD = `kirunak/approvals/${SLUG}.json`;
const INTAKE = `kirunak/tasks/${SLUG}/intake.md`;

const hash = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');

// Neither KIRUNAK_* nor GIT_* from the parent: the commit sees only what a test gives it.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('KIRUNAK_') && !k.startsWith('GIT_')) env[k] = v;
  return { ...env, ...extra };
}

const git = (dir, args, env) => execFileSync('git', args, { cwd: dir, env: cleanEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function put(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commit(dir, env = {}) {
  git(dir, ['add', '-A']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'test'], { cwd: dir, env: cleanEnv(env), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

// A repo with the hook installed and one approved task, committed as `k approve` commits it.
function makeRepo() {
  const dir = join(mkdtempSync(join(tmpdir(), 'kirunak-git-')), 'weather');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', '.git/hooks']);
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${HOOK}"\n`);
  chmodSync(hook, 0o755);
  const task = '# Offline forecast\n\n## Goal\nG-1: the forecast works offline. [owner 2026-11-02]\n';
  put(dir, 'README.md', 'weather\n');
  put(dir, TASK, task);
  put(dir, INTAKE, '# Intake\n\nQ-1 (2026-11-02): which data?\n');
  put(dir, `kirunak/tasks/${SLUG}/amendments/A-1.md`, `---\ntask: ${ID}\nproposed: 2026-11-04\n---\n`);
  put(dir, RECORD, JSON.stringify({ task: ID, hash: hash(task), approved: '2026-11-05T09:12:00+01:00', by: 'owner', via: 'shell', history: [] }) + '\n');
  const first = commit(dir, { KIRUNAK_APPROVING: ID });
  assert.equal(first.status, 0, first.stderr);
  return dir;
}

test('a commit with a changed frozen task is refused with the message', () => {
  const dir = makeRepo();
  appendFileSync(join(dir, TASK), 'G-2: and fast. [owner 2026-11-06]\n');
  const r = commit(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kirunak\/tasks\/offline-forecast\/task\.md: task\.md changed after approval/);
  assert.match(r.stderr, /`k approve weather\/offline-forecast --amendment A-n` applies an approved amendment and re-hashes/);
});

test('the same with KIRUNAK_APPROVING=<id> is allowed; another task\'s id is not', () => {
  const dir = makeRepo();
  appendFileSync(join(dir, TASK), 'G-2: and fast. [owner 2026-11-06]\n');
  assert.equal(commit(dir, { KIRUNAK_APPROVING: 'weather/radar-tiles' }).status, 1);
  assert.equal(commit(dir, { KIRUNAK_ACCEPTING: ID }).status, 1);
  const r = commit(dir, { KIRUNAK_APPROVING: ID });
  assert.equal(r.status, 0, r.stderr);
});

test('a frozen task re-approved in the same commit (the record\'s new hash) passes', () => {
  const dir = makeRepo();
  const text = readFileSync(join(dir, TASK), 'utf8') + 'G-2: and fast. [owner 2026-11-06]\n';
  put(dir, TASK, text);
  put(dir, RECORD, JSON.stringify({ task: ID, hash: hash(text), approved: '2026-11-06T10:00:00+01:00' }) + '\n');
  assert.equal(commit(dir, { KIRUNAK_APPROVING: ID }).status, 0);
});

test('a draft task (no record) changes freely', () => {
  const dir = makeRepo();
  put(dir, 'kirunak/tasks/radar-tiles/task.md', '# Radar\n');
  assert.equal(commit(dir).status, 0);
  appendFileSync(join(dir, 'kirunak/tasks/radar-tiles/task.md'), 'more\n');
  assert.equal(commit(dir).status, 0);
});

test('staged approvals/ without the variable is refused; with it, allowed', () => {
  const dir = makeRepo();
  put(dir, 'kirunak/approvals/radar-tiles.json', '{}\n');
  const r = commit(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kirunak\/approvals\/radar-tiles\.json: written by the owner's command only/);
  assert.equal(commit(dir, { KIRUNAK_APPROVING: 'weather/radar-tiles' }).status, 0);
});

test('a record moved or deleted is refused (renames are not hidden)', () => {
  const dir = makeRepo();
  git(dir, ['mv', RECORD, 'old-record.json']);
  assert.equal(commit(dir).status, 1);
  git(dir, ['reset', '-q', '--hard']);
  git(dir, ['rm', '-q', RECORD]);
  assert.equal(commit(dir).status, 1);
});

test('done.json and hold.md need the owner\'s variable naming the task', () => {
  const dir = makeRepo();
  put(dir, `kirunak/tasks/${SLUG}/done.json`, '{}\n');
  assert.equal(commit(dir).status, 1);
  assert.equal(commit(dir, { KIRUNAK_ACCEPTING: 'weather/other' }).status, 1);
  assert.equal(commit(dir, { KIRUNAK_ACCEPTING: ID }).status, 0);
  put(dir, `kirunak/tasks/${SLUG}/hold.md`, 'waiting\n');
  assert.equal(commit(dir).status, 1);
  assert.equal(commit(dir, { KIRUNAK_HOLDING: ID }).status, 0);
});

test('cost.md is refused unless it is the rendering of its done.json\'s cost', () => {
  const dir = makeRepo();
  const cost = { steps: [], total: { weight: 0, usd: 0, calls: 0, runs: 0, medianContext: null }, keeper: { keepalives: 0, misses: 0 }, interactive: { sessions: 0, usd: 0 }, comparisons: [] };
  const text = costMarkdown(ID, cost);
  put(dir, `kirunak/tasks/${SLUG}/cost.md`, text);
  const none = commit(dir);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /cost\.md is rendered from done\.json's cost, which k accept records, and there is none/);
  put(dir, `kirunak/tasks/${SLUG}/done.json`, JSON.stringify({ task: ID, cost: {} }));
  const odd = commit(dir, { KIRUNAK_ACCEPTING: ID });
  assert.equal(odd.status, 1, 'a cost no renderer takes is refused with a reason, not a crash');
  assert.match(odd.stderr, /done\.json's cost is not one k accept writes, so cost\.md cannot be rendered from it/);
  put(dir, `kirunak/tasks/${SLUG}/done.json`, JSON.stringify({ task: ID, cost }));
  assert.equal(commit(dir, { KIRUNAK_ACCEPTING: ID }).status, 0, 'the accept commits both');
  put(dir, `kirunak/tasks/${SLUG}/cost.md`, text.replace('Keep-alives 0', 'Keep-alives 9'));
  const edited = commit(dir, { KIRUNAK_ACCEPTING: ID });
  assert.equal(edited.status, 1, 'not even the owner\'s variable lets a hand edit through');
  assert.match(edited.stderr, new RegExp(`cost\\.md is generated from done\\.json; \`k cost ${ID} --write\` writes it again`));
  git(dir, ['rm', '-q', '-f', `kirunak/tasks/${SLUG}/cost.md`]);
  assert.equal(commit(dir).status, 0, 'a removal is anyone\'s: k cost --write brings it back');
  put(dir, `kirunak/tasks/${SLUG}/cost.md`, text);
  assert.equal(commit(dir).status, 0, 'and so is the rendering itself');
});

test('an amendment stamp needs the owner\'s variable; a new amendment does not', () => {
  const dir = makeRepo();
  put(dir, `kirunak/tasks/${SLUG}/amendments/A-2.md`, `---\ntask: ${ID}\nproposed: 2026-11-06\n---\n`);
  assert.equal(commit(dir).status, 0);
  put(dir, `kirunak/tasks/${SLUG}/amendments/A-1.md`, `---\ntask: ${ID}\nproposed: 2026-11-04\ndeclined: 2026-11-06 not now\n---\n`);
  const r = commit(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /amendments\/A-1\.md: its applied:\/declined: stamp is written by the owner's command only/);
  assert.equal(commit(dir, { KIRUNAK_APPROVING: ID }).status, 0);
});

test('a non-append intake.md is refused; an append and a new intake are allowed', () => {
  const dir = makeRepo();
  put(dir, INTAKE, '# Intake\n\nQ-1 (2026-11-02): which data, and how old?\n');
  const r = commit(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /intake\.md: intake\.md is append-only; use `k intake`/);
  git(dir, ['checkout', 'HEAD', '--', INTAKE]);
  appendFileSync(join(dir, INTAKE), 'A-1 (2026-11-03): "hourly" [owner 2026-11-03]\n');
  assert.equal(commit(dir).status, 0);
  put(dir, 'kirunak/tasks/radar-tiles/intake.md', '# Intake\n');
  assert.equal(commit(dir).status, 0);
});

test('a commit touching no kirunak file is allowed', () => {
  const dir = makeRepo();
  put(dir, 'src/main.txt', 'code\n');
  const r = commit(dir);
  assert.equal(r.status, 0, r.stderr);
});

test('a partial commit (`git commit -- paths`) is checked against what it records', () => {
  const dir = makeRepo();
  appendFileSync(join(dir, TASK), 'G-2: x [owner 2026-11-06]\n');
  put(dir, 'src/main.txt', 'code\n');
  git(dir, ['add', '-A']);
  const env = cleanEnv();
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 't', '--', 'src/main.txt'], { cwd: dir, env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 't', '--', TASK], { cwd: dir, env }).status, 1);
});

test('check, directly: the record in HEAD when the index has none, and a slug-only variable', () => {
  const task = Buffer.from('# t\n');
  const blobs = { ':kirunak/tasks/a/task.md': Buffer.from('# t, changed\n'), 'HEAD:kirunak/approvals/a.json': JSON.stringify({ task: 'r/a', hash: hash(task) }) };
  const show = (spec) => blobs[spec] ?? null;
  const staged = ['kirunak/tasks/a/task.md'];
  assert.equal(check({ staged, show, env: {} }).length, 1);
  assert.deepEqual(check({ staged, show, env: { KIRUNAK_APPROVING: 'a' } }), []);
  assert.deepEqual(check({ staged, show, env: { KIRUNAK_APPROVING: 'r/a' } }), []);
  assert.deepEqual(check({ staged: ['README.md'], show, env: {} }), []);
});

// The SLAP hook (prepare-commit-msg) and the commit-msg hook as k install writes them, in both repos of the invented
// workspace: the step's `Task:` trailer, and no new work on a task the owner accepted (accept-shared-repo AC-3, AC-4,
// AC-8, E-1).
const MSG_HOOKS = { 'prepare-commit-msg': 'git-prepare-commit-msg.mjs', 'commit-msg': 'git-commit-msg.mjs' };

async function hooked() {
  const w = await makeWorkspace();
  for (const dir of [w.weather, w.hub]) {
    for (const [name, module] of Object.entries(MSG_HOOKS)) {
      const hook = join(dir, '.git', 'hooks', name);
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL(`../hooks/${module}`, import.meta.url))}" "$@"\n`);
      chmodSync(hook, 0o755);
    }
    // Absolute, so a linked worktree runs them: it reads a relative one against its own root, where .git is a file.
    git(dir, ['config', 'core.hooksPath', join(dir, '.git', 'hooks')]);
  }
  return w;
}

function commitAs(w, dir, message, env = {}, extra = []) {
  git(dir, ['add', '-A']);
  const r = spawnSync('git', ['commit', '-q', ...extra, '-m', message], { cwd: dir, env: cleanEnv({ KIRUNAK_HOME: w.home, ...env }), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

const said = (dir) => git(dir, ['log', '-1', '--format=%B']).trim();

test('a commit in a step k run started carries Task: <id>, one after an amend; one with no task carries none and passes (accept-shared-repo AC-3, AC-4)', async () => {
  const w = await hooked();
  const step = { KIRUNAK_TASK: ID, KIRUNAK_STEP: 'S-2' };
  put(w.weather, 'src/a.ts', 'export const a = 1;\n');
  assert.equal(commitAs(w, w.weather, 'the cache', step).status, 0);
  assert.match(said(w.weather), /^the cache\n\nSLAP: .*\nTask: weather\/offline-forecast$/);
  put(w.weather, 'src/b.ts', 'export const b = 1;\n');
  const amend = commitAs(w, w.weather, 'unused', step, ['--amend', '--no-edit']);
  assert.equal(amend.status, 0, amend.stderr);
  assert.equal(said(w.weather).match(/^Task: /gm).length, 1);
  put(w.weather, 'src/c.ts', 'export const c = 1;\n');
  const plain = commitAs(w, w.weather, 'by hand');
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(said(w.weather), /Task:/);
});

test('a commit naming a task the owner accepted is refused unless it stages only kirunak\'s records (accept-shared-repo AC-8, E-1)', async () => {
  const w = await hooked();
  put(w.weather, `kirunak/tasks/${SLUG}/done.json`, JSON.stringify({ task: ID, accepted: '2026-11-09T10:00:00+01:00' }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0, 'the accept stages only its record');

  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  for (const [message, env] of [[`${SLUG}: one more line`, {}], ['the cache, as weather/offline-forecast left it', {}], ['one more line', { KIRUNAK_TASK: ID }]]) {
    const r = commitAs(w, w.weather, message, env);
    assert.equal(r.status, 1, message);
    assert.equal(r.stderr.trim(), `kirunak: this commit's message names ${ID}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${ID}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue, and what the workspace names as records) may still be committed naming it.`);
  }
  // Records beside the code do not make it a records' commit.
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: the handoff and a line`).status, 1);
  // Only the records, by a partial commit, and the records of other kinds, pass.
  const env = cleanEnv({ KIRUNAK_HOME: w.home });
  const partial = spawnSync('git', ['commit', '-q', '-m', `${ID}: the handoff`, '--', `kirunak/tasks/${SLUG}/handoff.md`], { cwd: w.weather, env, encoding: 'utf8' });
  assert.equal(partial.status, 0, partial.stderr);
  git(w.weather, ['reset', '-q']);
  put(w.weather, 'kirunak/drafts/offline-maps.md', '# Offline maps\n');
  put(w.weather, 'kirunak/approvals/offline-maps.json', '{}\n');
  git(w.weather, ['add', 'kirunak']);
  const records = spawnSync('git', ['commit', '-q', '-m', `a draft after ${SLUG}`, '--', 'kirunak'], { cwd: w.weather, env, encoding: 'utf8' });
  assert.equal(records.status, 0, records.stderr);
  // A longer word, or another repo's task of the same slug, names some other task; the code then passes.
  assert.equal(commitAs(w, w.weather, `${SLUG}-again: hub/${SLUG} is the hub's`).status, 0);
  assert.equal(git(w.weather, ['status', '--porcelain']), '');

  // The queue file where the workspace keeps it is a record too.
  put(w.hub, 'kirunak/tasks/board/done.json', JSON.stringify({ task: 'hub/board' }) + '\n');
  assert.equal(commitAs(w, w.hub, 'hub/board: accepted').status, 0);
  writeFileSync(join(w.hub, 'kirunak', 'queue.md'), '# Queue\n');
  assert.equal(commitAs(w, w.hub, 'kirunak: queue remove hub/board').status, 0);
  put(w.hub, 'README.md', 'hub, the board done\n');
  const code = commitAs(w, w.hub, 'the board: one more line');
  assert.equal(code.status, 1);
  assert.match(code.stderr, /names hub\/board, which the owner has accepted/);
});

test('the hook lets a clean merge naming an accepted task through (E-4), and without a workspace refuses nothing for an accepted task but still writes Task: (accept-shared-repo AC-8)', async () => {
  const w = await hooked();
  put(w.weather, `kirunak/tasks/${SLUG}/done.json`, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, 'accepted').status, 0);
  git(w.weather, ['checkout', '-q', '-b', 'side']);
  put(w.weather, 'src/side.ts', 'export {};\n');
  assert.equal(commitAs(w, w.weather, 'a side line').status, 0);
  git(w.weather, ['checkout', '-q', 'master']);
  const merge = spawnSync('git', ['merge', '-q', '--no-ff', '-m', `${SLUG}'s side, merged`, 'side'], { cwd: w.weather, env: cleanEnv({ KIRUNAK_HOME: w.home }), encoding: 'utf8' });
  assert.equal(merge.status, 0, merge.stderr);

  const nowhere = mkdtempSync(join(tmpdir(), 'kirunak-home-'));
  put(w.weather, 'src/again.ts', 'export {};\n');
  const r = commitAs({ home: nowhere }, w.weather, `${SLUG}: once more`, { KIRUNAK_TASK: ID });
  assert.equal(r.status, 0, r.stderr);
  assert.match(said(w.weather), /\nTask: weather\/offline-forecast$/);
});

// An editor that puts KIRUNAK_TEST_LINES before what git wrote in the message file: git's status comments stay below.
function editor() {
  const file = join(mkdtempSync(join(tmpdir(), 'kirunak-editor-')), 'edit.sh');
  writeFileSync(file, '#!/bin/sh\n{ printf "%s\\n" "$KIRUNAK_TEST_LINES"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n');
  chmodSync(file, 0o755);
  return file;
}

function editAs(w, dir, lines, extra = [], env = {}) {
  git(dir, ['add', '-A']);
  const r = spawnSync('git', ['commit', '-q', ...extra], { cwd: dir, env: cleanEnv({ KIRUNAK_HOME: w.home, GIT_EDITOR: editor(), KIRUNAK_TEST_LINES: lines, ...env }), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

async function accepted() {
  const w = await hooked();
  put(w.weather, `kirunak/tasks/${SLUG}/done.json`, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  return w;
}

const REFUSAL = `kirunak: this commit's message names ${ID}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${ID}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue, and what the workspace names as records) may still be committed naming it.`;

test('the message the commit keeps is checked: typed in the editor, or given with -m and edited, it may not name an accepted task beside code (accept-shared-repo AC-8, E-1)', async () => {
  const w = await accepted();
  const head = git(w.weather, ['rev-parse', 'HEAD']);
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  for (const [lines, extra] of [[`${SLUG}: one more line`, []], [`for ${ID}`, ['-m', 'one more line', '-e']]]) {
    const r = editAs(w, w.weather, lines, extra);
    assert.equal(r.status, 1, lines);
    assert.equal(r.stderr.trim(), REFUSAL);
    assert.equal(git(w.weather, ['rev-parse', 'HEAD']), head);
  }
  // git's status comments below the message list the task's records; what git leaves out names nothing.
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  assert.equal(editAs(w, w.weather, 'the cache, one more line').status, 0);
  assert.equal(said(w.weather).split('\n')[0], 'the cache, one more line');
  // Records alone pass through the editor too.
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n\nThe cache is done.\n');
  assert.equal(editAs(w, w.weather, `${ID}: the handoff`).status, 0);
  assert.equal(git(w.weather, ['status', '--porcelain']), '');
});

test('a line starting with # given with -m stays in the commit and is read; an amend that rewords a commit to name an accepted task is refused, through the editor or with -m (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  const hash = commitAs(w, w.weather, `#${SLUG} one more line`);
  assert.equal(hash.status, 1);
  assert.equal(hash.stderr.trim(), REFUSAL);

  // A commit made a while ago, so an amend keeps an author date older than now.
  const old = { GIT_AUTHOR_DATE: '@1700000000 +0000', GIT_COMMITTER_DATE: '@1700000000 +0000' };
  assert.equal(commitAs(w, w.weather, 'one more line', old).status, 0);
  const head = git(w.weather, ['rev-parse', 'HEAD']);
  const reword = commitAs(w, w.weather, `${SLUG}: one more line`, {}, ['--amend']);
  assert.equal(reword.status, 1);
  assert.equal(reword.stderr.trim(), REFUSAL);
  const edited = editAs(w, w.weather, `${SLUG}:`, ['--amend']);
  assert.equal(edited.status, 1);
  assert.equal(edited.stderr.trim(), REFUSAL);
  assert.equal(git(w.weather, ['rev-parse', 'HEAD']), head);
  // A new commit naming it with only records passes, though HEAD has code.
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  assert.equal(commitAs(w, w.weather, `${ID}: the handoff`).status, 0);
});

test('a merge after a commit under --no-verify, which leaves commit-msg\'s base unread, writes the base anew, its own commit-msg reads it, and it is let through (accept-shared-repo AC-8, E-4)', async () => {
  const w = await accepted();
  put(w.weather, 'src/a.ts', 'export {};\n');
  assert.equal(commitAs(w, w.weather, 'a line', {}, ['--no-verify']).status, 0);
  assert.ok(existsSync(join(w.weather, '.git', 'KIRUNAK_COMMIT_BASE')));
  git(w.weather, ['checkout', '-q', '-b', 'side']);
  put(w.weather, 'src/side.ts', 'export {};\n');
  assert.equal(commitAs(w, w.weather, 'a side line').status, 0);
  git(w.weather, ['checkout', '-q', 'master']);
  const merge = spawnSync('git', ['merge', '-q', '--no-ff', '-m', `${SLUG}'s side, merged`, 'side'], { cwd: w.weather, env: cleanEnv({ KIRUNAK_HOME: w.home }), encoding: 'utf8' });
  assert.equal(merge.status, 0, merge.stderr);
  assert.ok(!existsSync(join(w.weather, '.git', 'KIRUNAK_COMMIT_BASE')));
});

// A worktree of `dir` on a new branch made at `at`, and `dir` as its own origin with origin/HEAD at master: the
// shapes the accepted set is read through (accept-shared-repo AC-8; steps/S-11/design.md §1, §5).
function worktreeOf(dir, branch, at) {
  const wt = `${dir}-${branch}`;
  git(dir, ['branch', branch, at]);
  git(dir, ['worktree', 'add', '-q', wt, branch]);
  return wt;
}

function remoteOf(dir) {
  git(dir, ['remote', 'add', 'origin', dir]);
  git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['remote', 'set-head', 'origin', 'master']);
}

const DONE = `kirunak/tasks/${SLUG}/done.json`;

test('a worktree on a branch made before the accept refuses a commit naming it, with -m and in the editor, and lets its records through (accept-shared-repo AC-8, E-1)', async () => {
  const w = await accepted();
  const wt = worktreeOf(w.weather, 'old', git(w.weather, ['rev-parse', 'HEAD~']).trim());
  assert.ok(!existsSync(join(wt, DONE)));
  const head = git(wt, ['rev-parse', 'HEAD']);
  put(wt, 'src/more.ts', 'export const more = 1;\n');
  for (const r of [commitAs(w, wt, `${SLUG}: one more line`), editAs(w, wt, `${SLUG}:`)]) {
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), REFUSAL);
  }
  assert.equal(git(wt, ['rev-parse', 'HEAD']), head);
  git(wt, ['reset', '-q', '--hard']);
  put(wt, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  const records = commitAs(w, wt, `${ID}: the handoff`);
  assert.equal(records.status, 0, records.stderr);
  assert.match(said(wt), /\nSLAP: /, 'the hooks ran in the worktree');
  // The main checkout still refuses it.
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: one more line`).status, 1);
});

test('the main checkout on a branch made before the accept refuses a commit naming it, by the default branch, with origin/HEAD or without (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  git(w.weather, ['checkout', '-q', '-b', 'old', 'HEAD~']);
  assert.ok(!existsSync(join(w.weather, DONE)));
  // Without a git call: a top where none can run still finds the branch, once origin/HEAD's file is there.
  const away = { ...repoInfo(w.weather), top: join(w.weather, 'nowhere'), main: join(w.weather, 'nowhere') };
  assert.equal(defaultBranch(away), null);
  assert.equal(mainOnDefault(away, 'old'), true);
  for (const origin of [false, true]) {
    if (origin) remoteOf(w.weather);
    put(w.weather, 'src/more.ts', 'export const more = 1;\n');
    const r = commitAs(w, w.weather, `${SLUG}: one more line`);
    assert.equal(r.status, 1, `origin/HEAD: ${origin}`);
    assert.equal(r.stderr.trim(), REFUSAL);
    git(w.weather, ['reset', '-q', '--hard']);
    put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, `# Handoff, origin/HEAD: ${origin}\n`);
    const records = commitAs(w, w.weather, `${ID}: the handoff`);
    assert.equal(records.status, 0, records.stderr);
  }
  assert.equal(defaultBranch(away), 'master');
});

test('an accept committed on a side branch of the main checkout is known from a worktree, and let through once the main checkout leaves it unmerged (accept-shared-repo AC-8; approval.md §3)', async () => {
  const w = await hooked();
  const pre = git(w.weather, ['rev-parse', 'HEAD']).trim();
  git(w.weather, ['checkout', '-q', '-b', 'settings']);
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  const wt = worktreeOf(w.weather, 'wip', pre);
  put(wt, 'src/more.ts', 'export const more = 1;\n');
  const r = commitAs(w, wt, `${SLUG}: one more line`);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), REFUSAL);
  git(w.weather, ['checkout', '-q', 'master']);
  const lost = commitAs(w, wt, `${SLUG}: one more line`);
  assert.equal(lost.status, 0, lost.stderr);
});

test('an accept written and not yet committed counts from a worktree (accept-shared-repo AC-8)', async () => {
  const w = await hooked();
  const wt = worktreeOf(w.weather, 'wip', git(w.weather, ['rev-parse', 'HEAD']).trim());
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  put(wt, 'src/more.ts', 'export const more = 1;\n');
  const r = commitAs(w, wt, `${SLUG}: one more line`);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), REFUSAL);
});

test('under core.commentChar=; a # line typed in the editor is read, and git\'s ; status lines are not (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  git(w.weather, ['config', 'core.commentChar', ';']);
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  const tag = editAs(w, w.weather, `# tag ${SLUG}`);
  assert.equal(tag.status, 1);
  assert.equal(tag.stderr.trim(), REFUSAL);
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  const line = editAs(w, w.weather, 'a line');
  assert.equal(line.status, 0, line.stderr);
});

test('under commit.cleanup=whitespace a # line typed in the editor is read, and git\'s own status block too (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  git(w.weather, ['config', 'commit.cleanup', 'whitespace']);
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  assert.equal(editAs(w, w.weather, `# tag ${SLUG}`).stderr.trim(), REFUSAL);
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  assert.equal(editAs(w, w.weather, 'a line').stderr.trim(), REFUSAL, 'the status block kept names the handoff');
  git(w.weather, ['reset', '-q', '--hard']);
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  const records = editAs(w, w.weather, 'a line');
  assert.equal(records.status, 0, records.stderr);
});

test('under commit.cleanup=strip a # line given with -m is dropped by git and names nothing (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  git(w.weather, ['config', 'commit.cleanup', 'strip']);
  put(w.weather, 'src/more.ts', 'export const more = 1;\n');
  const r = commitAs(w, w.weather, `#${SLUG} tag`, {}, ['-m', 'one more line']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(said(w.weather), /^#/m);
});

test('under commit.verbose=true the diff below the scissors names nothing (accept-shared-repo AC-8)', async () => {
  const w = await accepted();
  git(w.weather, ['config', 'commit.verbose', 'true']);
  put(w.weather, 'src/more.ts', `// ${SLUG}\n`);
  const r = editAs(w, w.weather, 'a line');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(said(w.weather).split('\n')[0], 'a line');
});

// Inside a replay (accept-shared-repo AC-3, AC-8, E-3, E-4, E-5; steps/S-16/design.md): a commit made while git
// merges, picks, rebases or reverts is judged by the message it keeps and what it stages beyond git's own replay.

// A git command that may stop inside a replay, with no editor of its own: { status, stderr }, the state left as it is.
function replayOf(w, dir, args, env = {}) {
  const r = spawnSync('git', args, { cwd: dir, env: cleanEnv({ KIRUNAK_HOME: w.home, GIT_EDITOR: 'true', ...env }), encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

// An executable sh script of `body`, for an editor git runs.
function script(body) {
  const file = join(mkdtempSync(join(tmpdir(), 'kirunak-script-')), 'run.sh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

// An editor that replaces the whole message by KIRUNAK_TEST_LINES.
const replacer = () => script('printf "%s\\n" "$KIRUNAK_TEST_LINES" > "$1"');

// The accepted task's own commit `c` (code, its message naming the task), then the accept, on master.
async function acceptedWork() {
  const w = await hooked();
  put(w.weather, 'src/cache.ts', 'export const cache = 1;\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: the cache`).status, 0);
  const c = git(w.weather, ['rev-parse', 'HEAD']).trim();
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  return { ...w, c };
}

const staged = (dir) => git(dir, ['diff', '--cached', '--name-only']).trim();
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).trim();

test('after `git revert -n` of an accepted task\'s commit, a commit naming it is refused beside new code and passes with only its records (accept-shared-repo AC-8, E-1, E-3)', async () => {
  const w = await acceptedWork();
  const before = head(w.weather);
  assert.equal(replayOf(w, w.weather, ['revert', '-n', w.c]).status, 0);
  assert.ok(existsSync(join(w.weather, '.git', 'REVERT_HEAD')));
  put(w.weather, 'src/x.ts', 'export const x = 1;\n');
  const r = commitAs(w, w.weather, `${SLUG}: brand new`);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), REFUSAL);
  assert.equal(head(w.weather), before);
  // The same replay, its commit staging only the task's handoff (E-1).
  git(w.weather, ['restore', '-q', '--source', 'HEAD', '--staged', '--worktree', 'src/cache.ts']);
  git(w.weather, ['rm', '-q', '--cached', 'src/x.ts']);
  execFileSync('rm', [join(w.weather, 'src/x.ts')]);
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  assert.ok(existsSync(join(w.weather, '.git', 'REVERT_HEAD')));
  const records = commitAs(w, w.weather, `${SLUG}: the handoff`);
  assert.equal(records.status, 0, records.stderr);
});

test('after `git cherry-pick -n` of an accepted task\'s commit, a commit naming it is the user\'s: refused with -m beside new code, and through the editor keeping git\'s words (accept-shared-repo AC-8, E-3)', async () => {
  const w = await acceptedWork();
  git(w.weather, ['checkout', '-q', '-b', 'port', `${w.c}^`]);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '-n', w.c]).status, 0);
  assert.ok(!existsSync(join(w.weather, '.git', 'CHERRY_PICK_HEAD')));
  put(w.weather, 'src/x.ts', 'export const x = 1;\n');
  const m = commitAs(w, w.weather, `${SLUG}: new work via a pick`);
  assert.equal(m.status, 1);
  assert.equal(m.stderr.trim(), REFUSAL);
  git(w.weather, ['reset', '-q', '--hard']);
  execFileSync('rm', ['-f', join(w.weather, 'src/x.ts')]);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '-n', w.c]).status, 0);
  const kept = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(kept.status, 1);
  assert.equal(kept.stderr.trim(), REFUSAL);
});

test('git\'s own cherry-pick of an accepted task\'s commit passes and keeps its message as it was, with no Task: line in a step (accept-shared-repo AC-3, E-3)', async () => {
  const w = await acceptedWork();
  const original = git(w.weather, ['log', '-1', '--format=%B', w.c]).trim();
  git(w.weather, ['checkout', '-q', '-b', 'port', `${w.c}^`]);
  const r = replayOf(w, w.weather, ['cherry-pick', w.c], { KIRUNAK_TASK: 'weather/next-task' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(said(w.weather), original);
  git(w.weather, ['reset', '-q', '--hard', 'HEAD~']);
  const x = replayOf(w, w.weather, ['cherry-pick', '-x', w.c], { KIRUNAK_TASK: 'weather/next-task' });
  assert.equal(x.status, 0, x.stderr);
  assert.equal(said(w.weather), `${original}\n(cherry picked from commit ${w.c})`);
});

test('code staged at a pick\'s stop under git\'s message is the commit\'s own and refused; code staged while `cherry-pick -e` edits stays out of the pick (accept-shared-repo AC-8, E-3)', async () => {
  const w = await acceptedWork();
  // On master, which holds the commit already, the pick stops empty: git alone would stage nothing.
  assert.equal(replayOf(w, w.weather, ['cherry-pick', w.c]).status, 1);
  assert.ok(existsSync(join(w.weather, '.git', 'CHERRY_PICK_HEAD')));
  put(w.weather, 'src/extra.ts', 'export const extra = 1;\n');
  const extra = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(extra.status, 1);
  assert.equal(extra.stderr.trim(), REFUSAL);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '--abort']).status, 0);
  execFileSync('rm', ['-f', join(w.weather, 'src/extra.ts')]);
  // git writes the pick's tree before its editor runs, and runs no commit-msg after it (S-16 design §1.1, case 8).
  git(w.weather, ['checkout', '-q', '-b', 'port', `${w.c}^`]);
  const stage = script(`printf 'export {};\\n' > "${join(w.weather, 'src/extra.ts')}" && git -C "${w.weather}" add src/extra.ts`);
  const e = replayOf(w, w.weather, ['cherry-pick', '-e', w.c], { GIT_EDITOR: stage });
  assert.equal(e.status, 0, e.stderr);
  assert.equal(git(w.weather, ['show', '--name-only', '--format=', 'HEAD']).trim(), 'src/cache.ts');
  assert.equal(staged(w.weather), 'src/extra.ts');
});

test('a pick stopped on a conflict passes with git\'s words, by the editor, by --continue and under commit.cleanup=whitespace, and is refused committed with -m naming the task (accept-shared-repo AC-8, E-3)', async () => {
  const w = await acceptedWork();
  const conflicted = (branch) => {
    git(w.weather, ['checkout', '-q', '-b', branch, `${w.c}^`]);
    put(w.weather, 'src/cache.ts', 'export const cache = 0;\n');
    assert.equal(commitAs(w, w.weather, 'another cache').status, 0);
    assert.equal(replayOf(w, w.weather, ['cherry-pick', w.c]).status, 1);
    assert.ok(existsSync(join(w.weather, '.git', 'CHERRY_PICK_HEAD')));
    put(w.weather, 'src/cache.ts', 'export const cache = 2;\n');
    git(w.weather, ['add', 'src/cache.ts']);
  };
  conflicted('by-editor');
  const editor = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(editor.status, 0, editor.stderr);
  assert.equal(said(w.weather).split('\n')[0], `${SLUG}: the cache`);
  conflicted('by-continue');
  const cont = replayOf(w, w.weather, ['cherry-pick', '--continue']);
  assert.equal(cont.status, 0, cont.stderr);
  conflicted('by-m');
  const own = commitAs(w, w.weather, `${SLUG}: port`);
  assert.equal(own.status, 1);
  assert.equal(own.stderr.trim(), REFUSAL);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '--abort']).status, 0);
  // Kept in the commit, git's `# Conflicts:` lines and status block are still git's words.
  git(w.weather, ['config', 'commit.cleanup', 'whitespace']);
  conflicted('whitespace');
  const ws = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(ws.status, 0, ws.stderr);
  assert.match(said(w.weather), /^# Conflicts:$/m);
});

test('a rebase of an accepted task\'s branch passes and keeps its messages in a step; a fixup into its commits is refused (accept-shared-repo AC-3, E-3)', async () => {
  const w = await hooked();
  git(w.weather, ['checkout', '-q', '-b', 'feat']);
  put(w.weather, 'src/cache.ts', 'export const cache = 1;\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: the cache`).status, 0);
  put(w.weather, 'src/view.ts', 'export const view = 1;\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: the view`).status, 0);
  const feat = head(w.weather);
  const messages = () => git(w.weather, ['log', '--format=%B', 'master..HEAD']);
  const before = messages();
  git(w.weather, ['checkout', '-q', 'master']);
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  put(w.weather, 'README.md', 'weather, moved on\n');
  assert.equal(commitAs(w, w.weather, 'master moves on').status, 0);
  git(w.weather, ['checkout', '-q', 'feat']);
  const r = replayOf(w, w.weather, ['rebase', 'master'], { KIRUNAK_TASK: 'weather/next-task' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(w.weather, ['rev-parse', 'HEAD~2']).trim(), git(w.weather, ['rev-parse', 'master']).trim());
  assert.equal(messages(), before);
  git(w.weather, ['reset', '-q', '--hard', feat]);
  const fixup = script('awk \'NR==2{sub(/^pick/,"fixup")}1\' "$1" > "$1.new" && mv "$1.new" "$1"');
  const f = replayOf(w, w.weather, ['rebase', '-i', 'master'], { GIT_SEQUENCE_EDITOR: fixup });
  assert.notEqual(f.status, 0);
  assert.ok(f.stderr.includes(REFUSAL), f.stderr);
  assert.equal(replayOf(w, w.weather, ['rebase', '--abort']).status, 0);
  assert.equal(head(w.weather), feat);
});

test('a rebase stopped on a conflict passes with git\'s words, by --continue or committed through the editor (accept-shared-repo E-3)', async () => {
  const w = await hooked();
  put(w.weather, 'm.txt', 'one\n');
  assert.equal(commitAs(w, w.weather, 'm').status, 0);
  git(w.weather, ['checkout', '-q', '-b', 'feat']);
  put(w.weather, 'm.txt', 'feat\n');
  assert.equal(commitAs(w, w.weather, `${SLUG}: m`).status, 0);
  git(w.weather, ['checkout', '-q', 'master']);
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  put(w.weather, 'm.txt', 'master\n');
  assert.equal(commitAs(w, w.weather, 'master moves m').status, 0);
  for (const how of ['continue', 'editor']) {
    git(w.weather, ['checkout', '-q', '-B', `feat-${how}`, 'feat']);
    assert.equal(replayOf(w, w.weather, ['rebase', 'master']).status, 1);
    assert.ok(existsSync(join(w.weather, '.git', 'rebase-merge', 'stopped-sha')));
    put(w.weather, 'm.txt', 'both\n');
    git(w.weather, ['add', 'm.txt']);
    if (how === 'editor') {
      const r = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
      assert.equal(r.status, 0, r.stderr);
    }
    const cont = replayOf(w, w.weather, ['rebase', '--continue']);
    assert.equal(cont.status, 0, cont.stderr);
    assert.equal(said(w.weather).split('\n')[0], `${SLUG}: m`, how);
  }
});

test('git revert of an accepted task\'s commit is refused, its revert left staged for a commit in a new task\'s words; a revert of a commit naming no task passes (accept-shared-repo E-5)', async () => {
  const w = await acceptedWork();
  put(w.weather, 'src/other.ts', 'export const other = 1;\n');
  assert.equal(commitAs(w, w.weather, 'another line').status, 0);
  const other = head(w.weather);
  const r = replayOf(w, w.weather, ['revert', '--no-edit', w.c]);
  assert.equal(r.status, 128);
  assert.ok(r.stderr.includes(REFUSAL), r.stderr);
  assert.equal(head(w.weather), other);
  assert.equal(staged(w.weather), 'src/cache.ts');
  const undo = commitAs(w, w.weather, 'weather/undo-cache: undo the cache');
  assert.equal(undo.status, 0, undo.stderr);
  replayOf(w, w.weather, ['revert', '--quit']);
  const plain = replayOf(w, w.weather, ['revert', '--no-edit', other]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(said(w.weather).split('\n')[0], 'Revert "another line"');
});

test('a merge naming an accepted task passes when clean, by its -m or its branch\'s name, when stopped on a conflict, and as an octopus; with code of its own it is refused and with records alone it passes; a squash merge of its branch is refused (accept-shared-repo AC-8, E-4, E-5)', async () => {
  const w = await hooked();
  const branch = (name, path, from = 'master', message = `a line for ${path}`) => {
    git(w.weather, ['checkout', '-q', '-b', name, from]);
    put(w.weather, path, `${name}\n`);
    assert.equal(commitAs(w, w.weather, message).status, 0);
    git(w.weather, ['checkout', '-q', 'master']);
  };
  branch('squashed', 'src/squashed.ts', 'master', `${SLUG}: the squashed line`);
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  const merge = (args) => replayOf(w, w.weather, ['merge', '-q', ...args]);

  branch(SLUG, 'src/a.ts');
  const byName = merge(['--no-ff', '--no-edit', SLUG]);
  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(said(w.weather), `Merge branch '${SLUG}'`);
  branch('side-b', 'src/b.ts');
  const byM = merge(['--no-ff', '-m', `${SLUG}: join`, 'side-b']);
  assert.equal(byM.status, 0, byM.stderr);

  branch('side-c', 'src/c.ts');
  assert.equal(merge(['--no-ff', '--no-commit', 'side-c']).status, 0);
  put(w.weather, 'src/evil.ts', 'export const evil = 1;\n');
  const evil = commitAs(w, w.weather, `${SLUG}: join`);
  assert.equal(evil.status, 1);
  assert.equal(evil.stderr.trim(), REFUSAL);
  execFileSync('rm', [join(w.weather, 'src/evil.ts')]);
  put(w.weather, `kirunak/tasks/${SLUG}/handoff.md`, '# Handoff\n');
  const records = commitAs(w, w.weather, `${SLUG}: join`);
  assert.equal(records.status, 0, records.stderr);

  branch('side-e', 'README.md');
  put(w.weather, 'README.md', 'weather, master\n');
  assert.equal(commitAs(w, w.weather, 'master readme').status, 0);
  assert.equal(merge(['-m', `${SLUG}: join e`, 'side-e']).status, 1);
  put(w.weather, 'README.md', 'weather, both\n');
  const resolved = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(resolved.status, 0, resolved.stderr);

  branch('oct-1', 'src/o1.ts');
  branch('oct-2', 'src/o2.ts');
  const octopus = merge(['--no-ff', '-m', `${SLUG}: two at once`, 'oct-1', 'oct-2']);
  assert.equal(octopus.status, 0, octopus.stderr);
  assert.equal(git(w.weather, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ').length, 4);

  assert.equal(merge(['--squash', 'squashed']).status, 0);
  const squash = editAs(w, w.weather, '', [], { GIT_EDITOR: 'true' });
  assert.equal(squash.status, 1);
  assert.equal(squash.stderr.trim(), REFUSAL);
});

test('an octopus naming an accepted task is judged against the join git\'s octopus makes: refused with code of its own, passing with none, its heads\' changes to one file apart joined in turn, and passing when git stops it on a conflict (accept-merge-gaps AC-1, E-1)', async () => {
  const w = await hooked();
  put(w.weather, 'src/lines.ts', '1\n2\n3\n4\n5\n');
  assert.equal(commitAs(w, w.weather, 'five lines').status, 0);
  put(w.weather, DONE, JSON.stringify({ task: ID }) + '\n');
  assert.equal(commitAs(w, w.weather, `${ID}: accepted`).status, 0);
  const branch = (name, path, text) => {
    git(w.weather, ['checkout', '-q', '-b', name, 'master']);
    put(w.weather, path, text);
    assert.equal(commitAs(w, w.weather, `a line for ${path}`).status, 0);
    git(w.weather, ['checkout', '-q', 'master']);
  };
  const merge = (args) => replayOf(w, w.weather, ['merge', '-q', ...args]);
  const parents = () => git(w.weather, ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ').length - 1;

  branch('oct-1', 'src/o1.ts', 'o1\n');
  branch('oct-2', 'src/o2.ts', 'o2\n');
  assert.equal(merge(['--no-ff', '--no-commit', 'oct-1', 'oct-2']).status, 0);
  put(w.weather, 'src/evil.ts', 'export const evil = 1;\n');
  const evil = commitAs(w, w.weather, `${SLUG}: two at once`);
  assert.equal(evil.status, 1, 'code of its own beside the heads');
  assert.equal(evil.stderr.trim(), REFUSAL);
  execFileSync('rm', [join(w.weather, 'src/evil.ts')]);
  const clean = commitAs(w, w.weather, `${SLUG}: two at once`);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(parents(), 3);

  branch('oct-3', 'src/lines.ts', 'one\n2\n3\n4\n5\n');
  branch('oct-4', 'src/lines.ts', '1\n2\n3\n4\nfive\n');
  branch('oct-5', 'src/o5.ts', 'o5\n');
  const three = merge(['--no-ff', '-m', `${SLUG}: three at once`, 'oct-3', 'oct-4', 'oct-5']);
  assert.equal(three.status, 0, three.stderr);
  assert.equal(parents(), 4);
  assert.equal(readFileSync(join(w.weather, 'src/lines.ts'), 'utf8'), 'one\n2\n3\n4\nfive\n');

  branch('oct-6', 'src/lines.ts', 'one\n2\nthree\n4\nfive\n');
  branch('oct-7', 'src/lines.ts', 'one\n2\nTHREE\n4\nfive\n');
  assert.notEqual(merge(['--no-ff', '--no-commit', 'oct-6', 'oct-7']).status, 0, 'git stops the octopus on the conflict');
  put(w.weather, 'src/lines.ts', 'one\n2\nthree, THREE\n4\nfive\n');
  const stopped = commitAs(w, w.weather, `${SLUG}: the conflict resolved`);
  assert.equal(stopped.status, 0, stopped.stderr);
});

test('the editor turning git\'s words at a pick\'s stop into the user\'s, naming an accepted task, is refused by commit-msg; after `cherry-pick -e` git runs no commit-msg (accept-shared-repo AC-8, E-3)', async () => {
  const w = await acceptedWork();
  git(w.weather, ['checkout', '-q', '-b', 'port', `${w.c}^`]);
  put(w.weather, 'src/cache.ts', 'export const cache = 0;\n');
  assert.equal(commitAs(w, w.weather, 'another cache').status, 0);
  const port = head(w.weather);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', w.c]).status, 1);
  put(w.weather, 'src/cache.ts', 'export const cache = 2;\n');
  const r = editAs(w, w.weather, `${SLUG}: my own words`, [], { GIT_EDITOR: replacer() });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), REFUSAL);
  assert.equal(head(w.weather), port);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '--abort']).status, 0);
  // What it does not check (approval.md §3): prepare-commit-msg sees git's words, and no hook sees the editor's.
  git(w.weather, ['reset', '-q', '--hard', `${w.c}^`]);
  const e = replayOf(w, w.weather, ['cherry-pick', '-e', w.c], { GIT_EDITOR: replacer(), KIRUNAK_TEST_LINES: `${SLUG}: my own words` });
  assert.equal(e.status, 0, e.stderr);
  assert.equal(said(w.weather), `${SLUG}: my own words`);
});

test('in a step a merge and a commit after `cherry-pick -n` carry Task: <id> and no SLAP: line (accept-shared-repo AC-3)', async () => {
  const w = await acceptedWork();
  const step = { KIRUNAK_TASK: 'weather/next-task' };
  git(w.weather, ['checkout', '-q', '-b', 'side']);
  put(w.weather, 'src/side.ts', 'export {};\n');
  assert.equal(commitAs(w, w.weather, 'a side line').status, 0);
  git(w.weather, ['checkout', '-q', 'master']);
  const merge = replayOf(w, w.weather, ['merge', '-q', '--no-ff', '--no-edit', 'side'], step);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(said(w.weather), "Merge branch 'side'\n\nTask: weather/next-task");
  git(w.weather, ['checkout', '-q', '-b', 'port', `${w.c}^`]);
  assert.equal(replayOf(w, w.weather, ['cherry-pick', '-n', w.c]).status, 0);
  const n = commitAs(w, w.weather, 'other: words', step);
  assert.equal(n.status, 0, n.stderr);
  assert.equal(said(w.weather), 'other: words\n\nTask: weather/next-task');
});

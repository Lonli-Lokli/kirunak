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
    assert.equal(r.stderr.trim(), `kirunak: this commit's message names ${ID}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${ID}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue) may still be committed naming it.`);
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

test('the hook lets a merge through, and without a workspace refuses nothing for an accepted task but still writes Task: (accept-shared-repo AC-8)', async () => {
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

const REFUSAL = `kirunak: this commit's message names ${ID}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${ID}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue) may still be committed naming it.`;

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

test('a merge after a commit under --no-verify, which leaves commit-msg\'s base unread, is let through (accept-shared-repo AC-8)', async () => {
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

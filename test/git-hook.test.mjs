import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../hooks/git-pre-commit.mjs';
import { costMarkdown } from '../lib/cost-md.mjs';

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

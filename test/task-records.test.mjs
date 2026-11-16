import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIRUNAK, approvedWorkspace, k, sh } from './helpers.mjs';

// `k records <id> [<file>...] [--dry-run]` (gulnya/accept-leaves-task-files AC-1, AC-3, AC-5, E-1, E-2): every
// changed, new or deleted file of the task's folder, task.md, done.json, cost.md and ignored files aside, listed, then
// committed in one commit of exactly those paths under KIRUNAK_RECORDING=<id>.

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: all
inputs: task
outputs: steps/S-1/report.md
`;

const TASK = 'kirunak/tasks/offline-forecast';
const put = (w, rel, text = 'x\n') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};
const long = (n, tag) => Array.from({ length: n }, (_, i) => `- ${tag} line ${i}: what was found there`).join('\n') + '\n';

// kirunak's three git hooks in the repo, as k install writes them: the pre-commit guard, the SLAP gate and the
// accepted-task check on the message.
function hooks(repo) {
  for (const [name, file] of [['pre-commit', 'git-pre-commit.mjs'], ['prepare-commit-msg', 'git-prepare-commit-msg.mjs'], ['commit-msg', 'git-commit-msg.mjs']]) {
    writeFileSync(join(repo, '.git', 'hooks', name), `#!/bin/sh\nexec "${process.execPath}" "${join(KIRUNAK, 'hooks', file)}" "$@"\n`, { mode: 0o755 });
  }
}

// The invented task approved, its folder committed as a few steps left it, and the hooks installed.
async function workspace() {
  const w = await approvedWorkspace(PLAN);
  put(w, 'notes.md', '# Notes\n');
  put(w, 'old.md', 'an early note\n');
  sh(w.weather, 'git', ['add', '-A']);
  sh(w.weather, 'git', ['commit', '-q', '-m', 'the task folder']);
  hooks(w.weather);
  const git = (...args) => sh(w.weather, 'git', args).trim();
  const run = (args) => k(w.home, args, { CLAUDE_CODE_SESSION_ID: '' });
  return { ...w, git, run };
}

test('k records lists every changed, new or deleted file of the task folder, task.md, done.json, cost.md and ignored files aside, then commits exactly those in one commit, other staged files left staged (AC-1, E-1, E-2)', async () => {
  const w = await workspace();
  put(w, 'notes.md', long(600, 'note'));
  put(w, 'review.md', long(40, 'row'));
  put(w, 'evidence/S-1-sizes.tsv', 'days\tbytes\n3\t2048\n');
  put(w, 'evidence/S-1/screen.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]));
  rmSync(join(w.p.dir, 'old.md'));
  put(w, 'steps/S-1/.gitignore', '.gitignore\nrun.log\n');
  put(w, 'steps/S-1/run.log', 'ignored\n');
  put(w, 'done.json', '{}\n');
  put(w, 'cost.md', 'left by a refused accept\n');
  writeFileSync(join(w.p.dir, 'task.md'), readFileSync(join(w.p.dir, 'task.md'), 'utf8') + '\nedited\n');
  // Another session's work, staged in the same index (E-1).
  mkdirSync(join(w.weather, 'src'), { recursive: true });
  writeFileSync(join(w.weather, 'src', 'other.kt'), 'class Other\n');
  w.git('add', '--', 'src/other.kt');
  const head = w.git('rev-parse', 'HEAD');
  const want = [`${TASK}/evidence/S-1-sizes.tsv`, `${TASK}/evidence/S-1/screen.png`, `${TASK}/notes.md`, `${TASK}/old.md`, `${TASK}/review.md`];

  const dry = w.run(['records', w.id, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  for (const f of want) assert.ok(dry.stdout.includes(f), `the dry run names ${f}:\n${dry.stdout}`);
  assert.match(dry.stdout, /old\.md \(deleted\)/);
  for (const f of ['task.md', 'done.json', 'cost.md', 'run.log', '.gitignore', 'other.kt']) assert.ok(!dry.stdout.includes(f), `the dry run leaves ${f} aside:\n${dry.stdout}`);
  assert.equal(w.git('rev-parse', 'HEAD'), head, 'a dry run commits nothing');

  const r = w.run(['records', w.id]);
  assert.equal(r.status, 0, r.stderr);
  for (const f of want) assert.ok(r.stdout.includes(f), `the commit's list names ${f}:\n${r.stdout}`);
  assert.equal(w.git('log', '-1', '--format=%s'), `kirunak: ${w.id} records`);
  assert.deepEqual(w.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), want);
  assert.equal(w.git('rev-parse', 'HEAD~1'), head, 'one commit');
  assert.doesNotMatch(w.git('log', '-1', '--format=%B'), /SLAP:/, 'the 600-line notes.md is not measured (AC-5)');
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain', '--untracked-files=all']).trimEnd(),
    [` M ${TASK}/task.md`, `A  src/other.kt`, `?? ${TASK}/cost.md`, `?? ${TASK}/done.json`].join('\n'),
    'the other session\'s file stays staged, and what k records leaves aside stays as it was');

  const none = w.run(['records', w.id]);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /nothing to commit/);
  assert.equal(w.git('log', '-1', '--format=%s'), `kirunak: ${w.id} records`);
});

test('k records <id> handoff.md on an accepted task commits the handoff alone, past the SLAP gate however long, while another file of the folder is changed too (AC-3, AC-5)', async () => {
  const w = await workspace();
  // The task accepted, as k accept commits done.json.
  put(w, 'done.json', `${JSON.stringify({ task: w.id, accepted: '2026-11-15T20:00:00+01:00', by: 'owner' })}\n`);
  const env = { ...process.env, KIRUNAK_ACCEPTING: w.id };
  sh(w.weather, 'git', ['add', '--', `${TASK}/done.json`]);
  sh(w.weather, 'git', ['commit', '-q', '-m', `kirunak: accept ${w.id}`, '--', `${TASK}/done.json`], env);
  put(w, 'handoff.md', long(600, 'handoff'));
  put(w, 'notes.md', '# Notes\n\nchanged after the accept\n');
  const head = w.git('rev-parse', 'HEAD');

  const r = w.run(['records', w.id, 'handoff.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.git('rev-parse', 'HEAD~1'), head);
  assert.equal(w.git('log', '-1', '--format=%s'), `kirunak: ${w.id} records`);
  assert.equal(w.git('show', '--name-only', '--format=', 'HEAD'), `${TASK}/handoff.md`, 'the commit holds handoff.md only');
  assert.equal(sh(w.weather, 'git', ['status', '--porcelain', '--untracked-files=all', '--', TASK]).trimEnd(), ` M ${TASK}/notes.md`, 'notes.md is left as it was');
});

test("a git hook's refusal is printed whole and leaves the index and the files as they were", async () => {
  const w = await workspace();
  // An intake.md that is no append of the committed one: the pre-commit hook refuses it.
  writeFileSync(join(w.p.dir, 'intake.md'), 'rewritten\n');
  put(w, 'review.md', '# Review\n');
  w.git('add', '--', `${TASK}/review.md`);
  rmSync(join(w.p.dir, 'old.md'));
  const head = w.git('rev-parse', 'HEAD');
  const status = w.git('status', '--porcelain', '--untracked-files=all');
  const r = w.run(['records', w.id]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /intake\.md/, r.stderr);
  assert.equal(w.git('rev-parse', 'HEAD'), head);
  assert.equal(w.git('status', '--porcelain', '--untracked-files=all'), status, 'the index and the files as they were');
  assert.equal(readFileSync(join(w.p.dir, 'intake.md'), 'utf8'), 'rewritten\n');
  assert.equal(existsSync(join(w.p.dir, 'old.md')), false);
});

test('k records names an unknown task, and is no owner verb: the freeze hook lets it run', async () => {
  const w = await workspace();
  const r = w.run(['records', 'weather/no-such-task']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown task weather\/no-such-task/);
  const help = w.run(['help']);
  assert.match(help.stdout, /k records <id> \[<file>\.\.\.\] \[--dry-run\]/);
  const { decide } = await import('../hooks/kirunak-freeze.mjs');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: `k records ${w.id}` }, cwd: w.weather }), null);
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: `k accept ${w.id}` }, cwd: w.weather }) ?? '', /owner/, 'as k accept is refused');
});

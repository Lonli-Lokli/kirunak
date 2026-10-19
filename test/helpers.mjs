import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes } from '../lib/approval.mjs';
import { loadWorkspace } from '../lib/workspace.mjs';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const KIRUNAK = fileURLToPath(new URL('../', import.meta.url));

export const sh = (cwd, cmd, args, env) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });

export function gitInit(dir) {
  sh(dir, 'git', ['init', '-q', '-b', 'master']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  sh(dir, 'git', ['config', 'core.hooksPath', '.git/hooks']);
}

export function gitCommitAll(dir, message = 'fixture') {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', message]);
}

// A copy of the invented workspace (two git repos, a checklist, a queue, the finished task) in a temp
// folder, with its own $KIRUNAK_HOME and pointer. Options: { finished: false } leaves the task out.
export async function makeWorkspace({ finished = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kirunak-'));
  cpSync(join(FIXTURES, 'workspace'), root, { recursive: true });
  if (!finished) {
    execFileSync('rm', ['-rf', join(root, 'weather', 'kirunak')]);
  }
  for (const repo of ['weather', 'hub']) {
    gitInit(join(root, repo));
    gitCommitAll(join(root, repo));
  }
  const home = join(root, '.kirunak');
  mkdirSync(home, { recursive: true });
  const modulePath = join(root, 'hub', 'kirunak', 'workspace.mjs');
  writeFileSync(join(home, 'workspace'), modulePath + '\n');
  process.env.KIRUNAK_HOME = home;
  const ws = await loadWorkspace(join(home, 'workspace'));
  return { root, home, ws, weather: join(root, 'weather'), hub: join(root, 'hub'), modulePath };
}

// `k <args>` as the command, in a child with the given $KIRUNAK_HOME: { status, stdout, stderr }.
export const k = (home, args, env = {}) =>
  spawnSync(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home, ...env } });

export const RESULT = readFileSync(join(FIXTURES, 'run', 'result.json'), 'utf8');

// A fake `claude`: it records its argv, stdin, cwd and the step's variables, and prints the fixture result.
export function fakeClaude(result = RESULT) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-fake-claude-')));
  const bin = join(dir, 'claude');
  writeFileSync(join(dir, 'result.json'), result);
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const calls = fs.existsSync(${JSON.stringify(join(dir, 'calls.json'))}) ? JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'calls.json'))}, 'utf8')) : [];
calls.push({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), task: process.env.KIRUNAK_TASK, step: process.env.KIRUNAK_STEP });
fs.writeFileSync(${JSON.stringify(join(dir, 'calls.json'))}, JSON.stringify(calls));
process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'result.json'))}, 'utf8'));
`);
  chmodSync(bin, 0o755);
  return { dir, bin, calls: () => JSON.parse(readFileSync(join(dir, 'calls.json'), 'utf8')) };
}

// The invented workspace with its task approved (and so queued) and the given plan.md.
export async function approvedWorkspace(plan) {
  const w = await makeWorkspace();
  const { approve } = await import('../lib/approval.mjs');
  const { taskPaths } = await import('../lib/workspace.mjs');
  await approve({ ws: w.ws, id: 'weather/offline-forecast' });
  const p = taskPaths(w.ws, 'weather/offline-forecast');
  writeFileSync(join(p.dir, 'plan.md'), plan);
  return { ...w, p, id: 'weather/offline-forecast' };
}

// plan.md with a review step per file (S-2 writes the first, S-3 the second, ...) and progress.md where each one
// finished, with the hash of the file as it is now (none for a file not written yet): what makes a review in the
// grammar one that k accept, k checklist and the task's state take, until the file changes.
export function reviewsRan(taskDir, files = ['review.md']) {
  const steps = files.map((f, i) => `### S-${i + 2} Review [review]\nneeds: S-1\ncovers: all\ninputs: task, diff, evidence/\noutputs: ${f}\n`);
  writeFileSync(join(taskDir, 'plan.md'), ['### S-1 Build [agent]\ncovers: all\ninputs: task\noutputs: steps/S-1/report.md\n', ...steps].join('\n'));
  const hash = (f) => (existsSync(join(taskDir, f)) ? ` (${f} ${hashBytes(readFileSync(join(taskDir, f)))})` : '');
  writeFileSync(join(taskDir, 'progress.md'), files.map((f, i) => `2026-11-06 1${i}:00 S-${i + 2} finished${hash(f)}\n`).join(''));
}

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

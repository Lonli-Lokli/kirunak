import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../lib/checkout.mjs';
import { gitCommitAll, gitInit } from './helpers.mjs';

// A folder's short (8.3) name, as cmd's %~s gives it; the long name when its volume makes none.
const shortName = (p) =>
  spawnSync('cmd.exe', [`/d /s /c "for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();

test('a task folder named by its Windows short (8.3) name is still left out of the checkout fingerprint', (t) => {
  if (process.platform !== 'win32') return t.skip('short (8.3) names are Windows\'s');
  // Under the home folder: C:, where Windows makes short names; a runner's or this machine's temp may not.
  const base = mkdtempSync(join(homedir(), 'kirunak-short-name-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'checkout');
  mkdirSync(repo);
  gitInit(repo);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  gitCommitAll(repo);
  const task = join(repo, 'notes', 'task');
  mkdirSync(task, { recursive: true });
  const short = shortName(task);
  if (short.toLowerCase() === task.toLowerCase()) return t.skip('this volume makes no short (8.3) names');
  const before = fingerprint(`cd ${repo} && make`, repo, short);
  writeFileSync(join(task, 'report.md'), 'the task wrote its report\n');
  assert.deepEqual(fingerprint(`cd ${repo} && make`, repo, short), before, 'the task folder is left out under its short name too');
});

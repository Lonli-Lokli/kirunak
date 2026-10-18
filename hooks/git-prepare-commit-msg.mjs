#!/usr/bin/env node
// prepare-commit-msg: every commit is measured by SLAP (R21, R22, R23, design/change-size.md). A commit over M, one
// with a binary file `.slapignore` does not list, or one whose `.slapignore` the owner has not approved is refused;
// any other gets a `SLAP: <score> (<tier>)` line in its message. git runs this hook even under --no-verify.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_TREE, gate, line, parentOf, repoInfo } from '../lib/slap.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A rebase, cherry-pick or revert replays commits already measured when they were made. A revert leaves only
// MERGE_MSG behind (git 2.54), so that counts too.
function replaying(gitDir) {
  return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_MSG'].some((p) => existsSync(join(gitDir, p)));
}

export function main(argv = process.argv.slice(2)) {
  const [msgFile, source, sha] = argv;
  if (source === 'merge') return 0;
  const info = repoInfo(process.cwd());
  if (replaying(info.gitDir)) return 0;
  let head = null;
  try {
    head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    head = null;
  }
  // An amend passes `commit HEAD`: git 2.54 passes the word; githooks(5) says a commit object name, so a sha counts too.
  const amending = source === 'commit' && head && (sha === 'HEAD' || sha === head);
  const base = amending ? parentOf(process.cwd(), 'HEAD') : head || EMPTY_TREE;
  const { m, refusals } = gate(process.cwd(), base, undefined, info);
  if (refusals.length) {
    console.error(refusals.join('\n'));
    return 1;
  }
  execFileSync('git', ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', line(m), msgFile], { stdio: 'ignore' });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`kirunak: the SLAP hook failed: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// prepare-commit-msg: every commit is measured by SLAP (R21, R22, design/change-size.md). An XL commit is refused;
// any other gets a `SLAP: <score> (<tier>)` line in its message. git runs this hook even under --no-verify.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_TREE, XL, line, measureDiff, parentOf } from '../lib/slap.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A rebase, cherry-pick or revert replays commits already measured when they were made. A revert leaves only
// MERGE_MSG behind (git 2.54), so that counts too.
function replaying(gitDir) {
  return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_MSG'].some((p) => existsSync(join(gitDir, p)));
}

export function refusal(m) {
  const top = m.counted.length > 5 ? ` (the files: ${m.counted.slice(0, 5).join(', ')}, ...)` : ` (${m.counted.join(', ')})`;
  return `kirunak: this commit is XL, SLAP ${m.score}: ${m.L} lines of code in ${m.F} files${top}. ` +
    'XL commits are refused, with no override (R22). Split it into smaller commits: stage fewer files ' +
    '(git restore --staged <file>) or part of a file (git add -p), and commit each part. `k slap --staged` measures ' +
    'what is staged.';
}

export function main(argv = process.argv.slice(2)) {
  const [msgFile, source, sha] = argv;
  if (source === 'merge') return 0;
  const gitDir = resolve(git(['rev-parse', '--git-dir']));
  if (replaying(gitDir)) return 0;
  let head = null;
  try {
    head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    head = null;
  }
  // An amend passes `commit HEAD`: git 2.54 passes the word; githooks(5) says a commit object name, so a sha counts too.
  const amending = source === 'commit' && head && (sha === 'HEAD' || sha === head);
  const base = amending ? parentOf(process.cwd(), 'HEAD') : head || EMPTY_TREE;
  const m = measureDiff(process.cwd(), ['--cached', base]);
  if (m.score >= XL) {
    console.error(refusal(m));
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

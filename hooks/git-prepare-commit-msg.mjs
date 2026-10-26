#!/usr/bin/env node
// prepare-commit-msg: every commit is measured by SLAP (R21, R22, R23, design/change-size.md). A commit over M, one
// with a binary file `.slapignore` does not list, or one whose `.slapignore` the owner has not approved is refused;
// any other gets a `SLAP: <score> (<tier>)` line in its message. A commit made in a step `k run` started also gets
// `Task: <id>` (KIRUNAK_TASK), and one whose message names a task the owner accepted is refused unless it stages only
// kirunak's records (approval.md §3). git runs this hook even under --no-verify, before the editor: it checks a
// message given with -m or -F, and leaves the commit's base for commit-msg, which checks the message the commit keeps.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_FILE, doneNamed, doneRefusal } from '../lib/records.mjs';
import { EMPTY_TREE, gate, line, parentOf, repoInfo } from '../lib/slap.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A rebase, cherry-pick or revert replays commits already measured when they were made. A revert leaves only
// MERGE_MSG behind (git 2.54), so that counts too.
function replaying(gitDir) {
  return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_MSG'].some((p) => existsSync(join(gitDir, p)));
}

// Whether a commit given -m or -F amends HEAD, for AC-8: git passes such an amend `message` like any commit, but keeps
// HEAD's author date for it, and a new commit's is now. A date of HEAD's two seconds old or more counts.
function amendsHead(env, head) {
  const at = /^@(\d+) /.exec(env.GIT_AUTHOR_DATE || '');
  if (!at || !head || Number(at[1]) > Date.now() / 1000 - 2) return false;
  return `@${git(['log', '-1', '--format=%ad', '--date=raw', head])}` === env.GIT_AUTHOR_DATE;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [msgFile, source, sha] = argv;
  const info = repoInfo(process.cwd());
  const baseFile = join(info.gitDir, BASE_FILE);
  rmSync(baseFile, { force: true });
  if (source === 'merge' || replaying(info.gitDir)) return 0;
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
  const task = (env.KIRUNAK_TASK || '').trim();
  const trailers = [line(m), ...(task ? [`Task: ${task}`] : [])];
  const own = !amending && amendsHead(env, head) ? parentOf(process.cwd(), 'HEAD') : base;
  const done = await doneNamed(info, readFileSync(msgFile, 'utf8'), own, env, task ? `\nTask: ${task}\n` : '');
  if (done) {
    console.error(doneRefusal(done));
    return 1;
  }
  writeFileSync(baseFile, `${own}\n`);
  for (const t of trailers) execFileSync('git', ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', t, msgFile], { stdio: 'ignore' });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`kirunak: the SLAP hook failed: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

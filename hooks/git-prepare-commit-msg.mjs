#!/usr/bin/env node
// prepare-commit-msg: every commit is measured by SLAP (R21, R22, R23, design/change-size.md). A commit over M, one
// with a binary file `.slapignore` does not list, or one whose `.slapignore` the owner has not approved is refused;
// any other gets a `SLAP: <score> (<tier>)` line in its message. A commit made in a step `k run` started also gets
// `Task: <id>` (KIRUNAK_TASK), and one whose message names a task the owner accepted is refused unless it stages only
// kirunak's records (approval.md §3). git runs this hook even under --no-verify; a message typed in the editor comes
// after it, so only one given with -m or -F is checked.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doneTasks, isRecord, namesTask, recordPaths, said } from '../lib/records.mjs';
import { EMPTY_TREE, gate, line, parentOf, repoInfo } from '../lib/slap.mjs';
import { loadWorkspace, parseId } from '../lib/workspace.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A rebase, cherry-pick or revert replays commits already measured when they were made. A revert leaves only
// MERGE_MSG behind (git 2.54), so that counts too.
function replaying(gitDir) {
  return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_MSG'].some((p) => existsSync(join(gitDir, p)));
}

// The accepted task a commit's message names while it stages more than kirunak's records (AC-8, E-1), or null. Only a
// done task's slug in the message loads the workspace, for its repos and its queue file; a workspace that does not
// load refuses nothing, since the queue file cannot be told from code.
async function doneNamed(message, base) {
  const text = said(message);
  const maybe = doneTasks(process.cwd()).filter((id) => namesTask(text, id, { here: parseId(id).repo }));
  if (!maybe.length) return null;
  let ws;
  try {
    ws = await loadWorkspace();
  } catch {
    return null;
  }
  const repos = ws.repos.map((r) => r.name);
  const id = maybe.find((x) => namesTask(text, x, { here: parseId(x).repo, repos }));
  if (!id) return null;
  const records = recordPaths(ws);
  const staged = git(['diff', '--cached', '--name-only', '--no-renames', '-z', base]).split('\0').filter(Boolean);
  return staged.some((p) => !isRecord(p, records)) ? id : null;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
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
  const task = (env.KIRUNAK_TASK || '').trim();
  const trailers = [line(m), ...(task ? [`Task: ${task}`] : [])];
  const done = await doneNamed(readFileSync(msgFile, 'utf8') + (task ? `\nTask: ${task}\n` : ''), base);
  if (done) {
    console.error(`kirunak: this commit's message names ${done}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${done}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue) may still be committed naming it.`);
    return 1;
  }
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

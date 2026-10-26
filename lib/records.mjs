import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { refuse } from './errors.mjs';
import { commitsIn, git } from './git.mjs';
import { allTaskIds, parseId } from './workspace.mjs';

// What `k accept` and the git hook take as a task's work and as kirunak's own records (approval.md §3, §4; the task
// gulnya/kirunak-accept-shared-repo): a commit names a task in its message, a task's own change is the paths of the
// commits naming it, and records are never anyone's change.

// kirunak's own records in a repo (AC-5): every task folder, the drafts, the approvals, and the workspace's queue file
// at its path inside the repo that holds it. Paths are relative to a repo's root, so a worktree of the repo has the
// same; a folder ends with a slash.
export const RECORD_DIRS = ['kirunak/tasks/', 'kirunak/drafts/', 'kirunak/approvals/'];

export function recordPaths(ws) {
  const queue = new Set();
  for (const r of ws.repos) {
    const rel = relative(r.root, ws.queue);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) queue.add(rel.split(sep).join('/'));
  }
  return [...RECORD_DIRS, ...queue];
}

export const isRecord = (path, records) => records.some((x) => (x.endsWith('/') ? path.startsWith(x) : path === x));

const WORD = 'A-Za-z0-9_-';

// Whether a commit message of the repo `here` names the task `id` (D-1): its id anywhere; in the task's own repo also
// its slug as a whole word (a letter, digit, `-` or `_` on either side ends it), unless the word before its slash is
// another of the workspace's `repos` (`katyafm/settings` names katyafm's task, never gulnya's `settings`). A `Task:`
// trailer is part of the message, so it names its task too.
export function namesTask(message, id, { here, repos = [] }) {
  const { repo, slug } = parseId(id); // a slug is lower-case letters, digits and hyphens, nothing a pattern reads
  const re = new RegExp(`(?<![${WORD}])(?:([${WORD}]+)/)?${slug}(?![${WORD}])`, 'g');
  for (const m of message.matchAll(re)) {
    if (m[1] === repo) return true;
    if (repo === here && !(m[1] && repos.includes(m[1]))) return true;
  }
  return false;
}

// The id in a message's `Task:` trailer (AC-3), the last one; null with none.
export function trailerTask(message) {
  const all = [...message.matchAll(/^Task: *(\S+) *$/gm)];
  return all.length ? all.at(-1)[1] : null;
}

// The tasks a commit names for AC-6: its `Task:` trailer when it has one, else every task of `ids` its message names.
export function tasksNamed(message, ids, ctx) {
  const t = trailerTask(message);
  return t ? [t] : ids.filter((id) => namesTask(message, id, ctx));
}

// What a commit message says, as prepare-commit-msg's file holds it: its comment lines and everything after the
// scissors left out, so the status git writes for an editor (`kirunak/tasks/<slug>/...` among its files) names nothing.
export function said(message) {
  return message.split(/^# -+ >8 -+$/m)[0].split('\n').filter((l) => !l.startsWith('#')).join('\n');
}

// The tasks of the repo at `root` the owner accepted (AC-8): each task folder holding done.json, by its `task`.
export function doneTasks(root) {
  const dir = join(root, 'kirunak', 'tasks');
  if (!existsSync(dir)) return [];
  const ids = [];
  for (const slug of readdirSync(dir).sort()) {
    const file = join(dir, slug, 'done.json');
    if (!existsSync(file)) continue;
    try {
      const { task } = JSON.parse(readFileSync(file, 'utf8'));
      parseId(task);
      ids.push(task);
    } catch {
      // A done.json that does not say its task names none.
    }
  }
  return ids;
}

// The commit that first added the task's approval record: where its own change starts (D-1).
function firstApproval(p) {
  const adds = git(p.root, ['log', '--diff-filter=A', '--format=%h', '--', p.recordRel]).split('\n').filter(Boolean);
  if (!adds.length) throw refuse(`${p.id}: ${p.recordRel} was never committed, so its own change has no start`);
  return adds.at(-1);
}

// What a later commit blocks k accept with (AC-1, AC-6, AC-7): for each commit from the review's head to HEAD, oldest
// first, the paths besides records that are in the task's own change (D-1: the commits from its first approval to that
// head whose message names it), or all of them when the commit names the task itself. → [{ path, commit, task }],
// task being what the commit names (tasksNamed) or `no task`. A commit is judged by its own paths, so a file changed
// and changed back still blocks; a merge lists none of its own.
export function blocking(ws, p, head) {
  const records = recordPaths(ws);
  const ctx = { here: p.repo, repos: ws.repos.map((r) => r.name) };
  const own = new Set();
  for (const c of commitsIn(p.root, `${firstApproval(p)}..${head}`)) {
    if (namesTask(c.message, p.id, ctx)) for (const x of c.paths) if (!isRecord(x, records)) own.add(x);
  }
  const ids = allTaskIds(ws);
  const rows = [];
  for (const c of commitsIn(p.root, `${head}..HEAD`).reverse()) {
    const code = c.paths.filter((x) => !isRecord(x, records));
    const hit = namesTask(c.message, p.id, ctx) ? code : code.filter((x) => own.has(x));
    if (!hit.length) continue;
    const task = tasksNamed(c.message, ids, ctx).join(', ') || 'no task';
    for (const path of hit) rows.push({ path, commit: c.sha, task });
  }
  return rows;
}

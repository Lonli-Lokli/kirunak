import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { refuse } from './errors.mjs';
import { commitsIn, git } from './git.mjs';
import { allTaskIds, loadWorkspace, parseId } from './workspace.mjs';

// What `k accept` and the git hook take as a task's work and as kirunak's own records (approval.md §3, §4; the task
// gulnya/kirunak-accept-shared-repo): a commit names a task in its message, a task's own change is the paths of the
// commits naming it, and records are never anyone's change.

// kirunak's own records in a repo (AC-5): every task folder, the drafts, the approvals, the workspace's queue file, the
// drafts' order beside it, and each file or folder its `records` names, at its path inside the repo that holds it.
// Paths are relative to a repo's root, so a worktree of the repo has the same; a folder ends with a slash.
export const RECORD_DIRS = ['kirunak/tasks/', 'kirunak/drafts/', 'kirunak/approvals/'];

export function recordPaths(ws) {
  const named = new Set();
  for (const p of [ws.queue, ws.draftOrder, ...(ws.records ?? [])].filter(Boolean)) {
    for (const r of ws.repos) {
      const rel = relative(r.root, p);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) named.add(rel.split(sep).join('/') + (p.endsWith('/') ? '/' : ''));
    }
  }
  return [...RECORD_DIRS, ...named];
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

// The text git keeps of a commit message (AC-8; git-commit(1) --cleanup), `cfg` being commitConfig's: the comment
// string is core.commentChar's (`auto`, deprecated, read as `#`); `commit.cleanup` unset or `default` strips when an
// editor runs and keeps every line when none does, which git tells a hook by `GIT_EDITOR=:`. verbatim keeps all; every
// other mode cuts at the scissors line, and strip also leaves out the comment lines (git's status block among them,
// whose file list names a task's records).
export function kept(message, env, cfg = {}) {
  const comment = cfg.comment && cfg.comment !== 'auto' ? cfg.comment : '#';
  const mode = cfg.cleanup && cfg.cleanup !== 'default' ? cfg.cleanup : env.GIT_EDITOR === ':' ? 'whitespace' : 'strip';
  if (mode === 'verbatim') return message;
  const c = comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const above = message.split(new RegExp(`^${c} -+ >8 -+$`, 'm'))[0];
  return mode === 'strip' ? above.split('\n').filter((l) => !l.startsWith(comment)).join('\n') : above;
}

// The settings `kept` reads from git's config in the repo at `root`, in one call: { comment, cleanup }, either left out
// when not set (git exits 1 when none is).
export function commitConfig(root) {
  let out;
  try {
    out = git(root, ['config', '--get-regexp', '^(core\\.commentchar|core\\.commentstring|commit\\.cleanup)$']);
  } catch {
    return {};
  }
  const cfg = {};
  for (const [, key, value] of out.matchAll(/^(\S+) (.*)$/gm)) cfg[key === 'commit.cleanup' ? 'cleanup' : 'comment'] = value;
  return cfg;
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

// Where prepare-commit-msg leaves, in a worktree's git folder, the commit a new commit's paths are judged against, for
// commit-msg to read after the editor (AC-8).
export const BASE_FILE = 'KIRUNAK_COMMIT_BASE';

// The ref a symbolic-ref file at `file` points to, such as `refs/heads/master`; null when it is not there or not a
// symbolic ref (a detached HEAD, or reftable's stand-in `refs/heads/.invalid`).
function symref(file) {
  try {
    const ref = /^ref: (refs\/\S+)\s*$/.exec(readFileSync(file, 'utf8'))?.[1];
    return ref && !ref.endsWith('/.invalid') ? ref : null;
  } catch {
    return null;
  }
}

const ORIGIN = 'refs/remotes/origin/';

// The repo's default branch, as a name (`master`): origin/HEAD's target, read from its file in the common git folder
// with no git call; failing that, one for-each-ref: origin/HEAD's target, else `main`, else `master`; else null.
export function defaultBranch(info) {
  const origin = symref(join(info.common, 'refs', 'remotes', 'origin', 'HEAD'));
  if (origin?.startsWith(ORIGIN)) return origin.slice(ORIGIN.length);
  let out;
  try {
    out = git(info.top, ['for-each-ref', '--format=%(refname) %(symref)', `${ORIGIN}HEAD`, 'refs/heads/main', 'refs/heads/master']);
  } catch {
    return null;
  }
  const refs = new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ')));
  const target = refs.get(`${ORIGIN}HEAD`);
  if (target?.startsWith(ORIGIN)) return target.slice(ORIGIN.length);
  return refs.has('refs/heads/main') ? 'main' : refs.has('refs/heads/master') ? 'master' : null;
}

// Whether the main checkout is on `branch`: its HEAD file in the common git folder, else one symbolic-ref. A bare
// common folder has no main checkout, and a detached HEAD is on no branch.
export function mainOnDefault(info, branch) {
  if (!info.main) return false;
  const head = symref(join(info.common, 'HEAD'));
  if (head) return head === `refs/heads/${branch}`;
  try {
    return git(info.main, ['symbolic-ref', '-q', 'HEAD']).trim() === `refs/heads/${branch}`;
  } catch {
    return false;
  }
}

// The tasks whose done.json `branch` has committed, each read as doneTasks reads a file: one ls-tree, then one
// cat-file --batch for them all (its output, per file: `<oid> <type> <size>\n<size bytes>\n`).
export function doneOnBranch(root, branch) {
  const rev = `refs/heads/${branch}`;
  let out;
  try {
    const paths = git(root, ['ls-tree', '-r', '-z', '--name-only', rev, '--', 'kirunak/tasks']).split('\0').filter((p) => p.endsWith('/done.json'));
    if (!paths.length) return [];
    out = git(root, ['cat-file', '--batch'], { input: Buffer.from(paths.map((p) => `${rev}:${p}\n`).join('')), encoding: 'buffer' });
  } catch {
    return [];
  }
  const ids = [];
  for (let at = 0; at < out.length; ) {
    const nl = out.indexOf(10, at);
    const head = out.subarray(at, nl).toString();
    if (head.endsWith(' missing')) {
      at = nl + 1;
      continue;
    }
    const size = Number(head.split(' ').at(-1));
    try {
      const { task } = JSON.parse(out.subarray(nl + 1, nl + 1 + size).toString());
      parseId(task);
      ids.push(task);
    } catch {
      // A done.json that does not say its task names none.
    }
    at = nl + 1 + size + 1;
  }
  return ids;
}

// The tasks of a repo the owner accepted (AC-8), whichever of its working trees commits and whatever it has checked
// out: the done.json files of the main checkout's tree, an accept not yet committed among them, and, when the main
// checkout is not on the default branch, those committed there. `info` is repoInfo's.
export function acceptedTasks(info) {
  const ids = new Set(info.main ? doneTasks(info.main) : []);
  const branch = defaultBranch(info);
  if (branch && !mainOnDefault(info, branch)) for (const id of doneOnBranch(info.top, branch)) ids.add(id);
  return [...ids];
}

// The accepted task that a commit's message names while the commit stages more than kirunak's records, its paths taken
// against `base` in the committing working tree (AC-8, E-1); null for none. `raw` is the message file as the hook gets
// it, `extra` what the hook adds (the `Task:` trailer). Only a done task named in the raw text reads git's config, for
// the text git keeps, and loads the workspace, for its repos and its queue file; a workspace that does not load refuses
// nothing, since the queue file cannot be told from code. Inside a replay `base` is a function of git's config giving
// the tree or commit to judge against (replay.mjs ownBase), called only then; null from it means nothing is verifiable.
export async function doneNamed(info, raw, base, env, extra = '') {
  const named = (text, ids, repos) => ids.filter((id) => namesTask(text, id, { here: parseId(id).repo, repos }));
  let maybe = named(raw + extra, acceptedTasks(info));
  if (!maybe.length) return null;
  const cfg = commitConfig(info.top);
  const text = kept(raw, env, cfg) + extra;
  maybe = named(text, maybe);
  if (!maybe.length) return null;
  let ws;
  try {
    ws = await loadWorkspace();
  } catch {
    return null;
  }
  const id = named(text, maybe, ws.repos.map((r) => r.name))[0];
  if (!id) return null;
  const against = typeof base === 'function' ? base(cfg) : base;
  if (!against) return null;
  const records = recordPaths(ws);
  const staged = git(info.top, ['diff', '--cached', '--name-only', '--no-renames', '-z', against]).split('\0').filter(Boolean);
  return staged.some((p) => !isRecord(p, records)) ? id : null;
}

export const doneRefusal = (id) => `kirunak: this commit's message names ${id}, which the owner has accepted: new work on it is a new task. Reword the message so it does not name ${id}, or start a new task (/k-intake); only kirunak's records (task folders, drafts, approvals, the queue, and what the workspace names as records) may still be committed naming it.`;

// The commit that first added the task's approval record: where its own change starts (D-1), and a review's diff.
export function firstApproval(p) {
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

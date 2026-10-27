import { commitsIn, git, show } from './git.mjs';
import { firstApproval, isRecord, namesTask, recordPaths, trailerTask } from './records.mjs';
import { allTaskIds } from './workspace.mjs';

// What a review sees of a task's work in its own repo (review.md §1; the task gulnya/kirunak-review-base): its diff
// starts at the task's first approval whatever amendments came after (AC-1), and holds the task's own change (D-1),
// the files of the commits that name the task or name no task, each diffed once.

// The task's first approval and its last amendment's approval (AC-3): { first, amendment: { id, commit } | null }. An
// amendment's approval is a commit of the approval record whose history, as committed there, ends with that
// amendment; the newest such is the last.
export function approvals(p) {
  const first = firstApproval(p);
  for (const sha of git(p.root, ['log', '--format=%h', '--', p.recordRel]).split('\n').filter(Boolean)) {
    let last;
    try {
      last = JSON.parse(show(p.root, `${sha}:${p.recordRel}`)?.toString() ?? '').history?.at(-1);
    } catch {
      continue; // the commit that removed the record has none to read
    }
    if (last?.amendment) return { first, amendment: { id: last.amendment, commit: sha } };
  }
  return { first, amendment: null };
}

export const subjectOf = (message) => message.trim().split('\n')[0];

// Whose a commit of the repo `ctx.here` is (D-1, E-3): 'own' when its message names the task `id`, its `Task:` trailer
// included; 'other' when it names only other tasks of `ids`, or carries another task's trailer; 'none' when it names
// no task.
export function whose(message, id, ids, ctx) {
  if (namesTask(message, id, ctx)) return 'own';
  if (trailerTask(message)) return 'other';
  return ids.some((x) => namesTask(message, x, ctx)) ? 'other' : 'none';
}

// The task's own change in its own repo (AC-6, AC-7, D-1, E-2, E-4): the commits of `base..head` that name the task or
// name no task, and `extra`, the commits repos.md adds there, whoever they name; their paths besides kirunak's records.
// A merge has no paths of its own, and the commits it brings in are each in the log. → { files, unnamed }: the paths,
// sorted, and the commits naming no task, oldest first, as { sha, subject, files }.
export function ownChange(ws, p, base, head, extra = []) {
  const records = recordPaths(ws);
  const ctx = { here: p.repo, repos: ws.repos.map((r) => r.name) };
  const ids = allTaskIds(ws);
  const files = new Set();
  const unnamed = [];
  const seen = new Set();
  const listed = commitsIn(p.root, `${base}..${head}`).reverse().map((c) => ({ ...c, by: 'log' }));
  for (const c of [...listed, ...extra.map((x) => ({ ...x, by: 'hand' }))]) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    const code = c.paths.filter((x) => !isRecord(x, records));
    const w = whose(c.message, p.id, ids, ctx);
    if (!code.length || (w === 'other' && c.by === 'log')) continue;
    for (const x of code) files.add(x);
    if (w === 'none') unnamed.push({ sha: c.sha, subject: subjectOf(c.message), files: code });
  }
  return { files: [...files].sort(), unnamed };
}

// The patch of `files` from base to head, each file diffed once, its name taken literally; '' for no file.
export function filesDiff(root, base, head, files) {
  return files.length ? git(root, ['diff', base, head, '--', ...files.map((f) => `:(literal)${f}`)]) : '';
}

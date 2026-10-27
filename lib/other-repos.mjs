import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { subjectOf, whose } from './change.mjs';
import { commitsIn, git, isAncestor, isBranch } from './git.mjs';
import { defaultBranch, isRecord, namesTask, recordPaths } from './records.mjs';
import { handLines, real } from './repos-md.mjs';
import { EMPTY_TREE, repoInfo } from './slap.mjs';
import { allTaskIds } from './workspace.mjs';

// A task's change in the repos besides its own (review.md §1; the task gulnya/kirunak-review-base): the workspace's
// repos where kirunak finds it by itself (AC-8), and those the task's repos.md adds by hand (AC-9). In such a repo
// (D-2) the change is the commits naming the task, those on a branch named after it since it left the default branch,
// and repos.md's ranges; a commit there naming no task and in none of these is left out.

// The commit `branch`'s reflog says it was created from (its oldest entry); null without a reflog.
function createdFrom(root, branch) {
  try {
    return git(root, ['reflog', 'show', '--format=%h', `refs/heads/${branch}`]).trim().split('\n').filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

// The commits on `branch` since it left the default branch `def` (D-2): `def..branch` while it is not merged; once it
// is, those since the commit its reflog says it was created from; with neither, none.
function sinceLeft(root, branch, def) {
  if (!def || branch === def) return [];
  if (!isAncestor(root, `refs/heads/${branch}`, `refs/heads/${def}`)) return commitsIn(root, `refs/heads/${def}..refs/heads/${branch}`);
  const from = createdFrom(root, branch);
  return from ? commitsIn(root, `${from}..refs/heads/${branch}`) : [];
}

const branchesOf = (root, args = []) =>
  git(root, ['for-each-ref', ...args, '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean).map((x) => x.slice('refs/heads/'.length));

// The branches of `repo` named after the task (D-2): its id, or a name holding its slug as a whole word while the repo
// is not a workspace repo with a task of that slug.
function taskBranches(ws, p, repo) {
  const inWorkspace = ws.repos.some((r) => r.root === repo.root);
  const theirs = inWorkspace && allTaskIds(ws, repo.name).includes(`${repo.name}/${p.slug}`);
  const word = new RegExp(`(?<![A-Za-z0-9_-])${p.slug}(?![A-Za-z0-9_-])`);
  return branchesOf(repo.root).filter((b) => b === p.id || (!theirs && word.test(b)));
}

// The task's commits in `repo` (D-2): (a) on any local branch, committed since `since`, naming the task; (b) on a
// branch named after it, since it left the default branch; (c) repos.md's `lines` there. Merges are not judged (E-4).
// → { commits: Map sha → commit, def, named }
export function commitsOf(ws, p, repo, since, lines) {
  const commits = new Map();
  const add = (list) => list.filter((c) => c.parents.length < 2).forEach((c) => commits.set(c.sha, c));
  const ctx = { here: repo.name, repos: ws.repos.map((r) => r.name) };
  const def = defaultBranch(repoInfo(repo.root));
  add(commitsIn(repo.root, ['--branches', `--since=${since}`]).filter((c) => namesTask(c.message, p.id, ctx)));
  const named = taskBranches(ws, p, repo);
  for (const b of named) add(sinceLeft(repo.root, b, def));
  for (const l of lines) add(l.range ? commitsIn(repo.root, l.range) : sinceLeft(repo.root, l.branch, def));
  return { commits, def, named };
}

const endOf = (line) => line.branch ?? (/\.\.\.?(.*)$/.exec(line.range)[1] || 'HEAD');

// The tip the diff is read at: of the default branch, the branches named after the task, repos.md's ends and every
// other branch holding a commit, the one holding the most, the first in that order on a tie. → { ref, held, on }: the
// commits it holds, and the branches holding each commit.
function tipOf(root, commits, def, named, lines) {
  const on = new Map([...commits.keys()].map((sha) => [sha, branchesOf(root, ['--contains', sha])]));
  const tips = [...new Set([def, ...named, ...lines.map(endOf), ...[...new Set([...on.values()].flat())].sort()].filter(Boolean))];
  let best = null;
  for (const ref of tips) {
    const branch = isBranch(root, ref);
    const held = [...commits.keys()].filter((sha) => (branch ? on.get(sha).includes(ref) : isAncestor(root, sha, ref)));
    if (!best || held.length > best.held.length) best = { ref, held };
  }
  return { ...(best ?? { ref: null, held: [] }), on };
}

const short = (root, rev) => git(root, ['rev-parse', '--short', rev]).trim();

// The base of the commits held: the merge base of their parents, the empty tree when one is a root commit.
function baseOf(root, held) {
  if (held.some((c) => !c.parents.length)) return EMPTY_TREE;
  const parents = [...new Set(held.flatMap((c) => c.parents))];
  try {
    return short(root, parents.length === 1 ? parents[0] : git(root, ['merge-base', '--octopus', ...parents]).trim());
  } catch {
    return EMPTY_TREE;
  }
}

// One repo's part of the review: { name, root, file, ref, base, head, files, count, unnamed, notHeld }, or null when
// none of the task's commits there touches more than kirunak's records.
function partOf(ws, p, repo, found, lines) {
  if (!found.commits.size) return null;
  const records = recordPaths(ws);
  const { ref, held, on } = tipOf(repo.root, found.commits, found.def, found.named, lines);
  if (!ref) return null;
  const commits = held.map((sha) => found.commits.get(sha));
  const files = [...new Set(commits.flatMap((c) => c.paths.filter((x) => !isRecord(x, records))))].sort();
  if (!files.length) return null;
  const ctx = { here: repo.name, repos: ws.repos.map((r) => r.name) };
  const ids = allTaskIds(ws);
  const unnamed = commits.filter((c) => whose(c.message, p.id, ids, ctx) === 'none').reverse()
    .map((c) => ({ repo: repo.name, sha: c.sha, subject: subjectOf(c.message), files: c.paths.filter((x) => !isRecord(x, records)) }))
    .filter((c) => c.files.length);
  const notHeld = [...found.commits.values()].filter((c) => !held.includes(c.sha)).map((c) => ({ sha: c.sha, subject: subjectOf(c.message), on: on.get(c.sha) }));
  return { name: repo.name, root: repo.root, ref, base: baseOf(repo.root, commits), head: short(repo.root, ref), files, count: commits.length, unnamed, notHeld };
}

// The repos besides the task's own, the workspace's and those repos.md adds, and repos.md's lines. → { repos, lines }
export function reposOf(ws, p) {
  const lines = handLines(ws, p);
  const own = real(p.root);
  const repos = [];
  for (const r of [...ws.repos, ...lines.map((l) => l.repo)]) {
    const at = real(r.root);
    if (at && at !== own && !repos.some((x) => real(x.root) === at) && existsSync(join(at, '.git'))) repos.push(r);
  }
  return { repos, lines, linesOf: (repo) => lines.filter((l) => real(l.repo.root) === real(repo.root)) };
}

// When the task's first approval was committed: where (a) starts.
export const sinceOf = (p, first) => git(p.root, ['log', '-1', '--format=%cI', first]).trim();

// The task's change in every other repo, each with its patch's file name in in/repos/, and repos.md's commits in the
// task's own repo, for its own change. → { parts, own: [commit] }
export function otherRepos(ws, p, first) {
  const { repos, linesOf } = reposOf(ws, p);
  const since = sinceOf(p, first);
  const parts = [];
  for (const repo of repos) {
    const lines = linesOf(repo);
    const part = partOf(ws, p, repo, commitsOf(ws, p, repo, since, lines), lines);
    if (!part) continue;
    const taken = parts.filter((x) => x.name === part.name).length;
    parts.push({ ...part, file: taken ? `${part.name}-${taken + 1}` : part.name });
  }
  const def = defaultBranch(repoInfo(p.root));
  const own = linesOf({ root: p.root }).flatMap((l) => (l.range ? commitsIn(p.root, l.range) : sinceLeft(p.root, l.branch, def)));
  return { parts, own: own.filter((c) => c.parents.length < 2) };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { git, head, isBranch, show, succeeds, toplevel } from './git.mjs';
import { validDate } from './source.mjs';
import { parseId, taskPaths } from './workspace.mjs';
import {
  BUG_SECTIONS, FIX, FIX_COMMIT, RULES, TITLE_MAX, checkFront, checkSections, draftPaths, hasCommit, isTaskId, isTracked, items,
  moveDraft, notAccepted, oneLine, orderWithout, parseDraft,
} from './drafts.mjs';

// Bugs (gulnya/kirunak-bugs AC-1, AC-3, AC-10, E-4, E-5): a fault in something that exists, with a way to see it, in a
// list of its own, kirunak/bugs/<slug>.md in the repo its id <repo>/<slug> names; never among the drafts, which keep
// new work and the owner's choices. Its shape is a groomed draft's (lib/drafts.mjs: Who raised it, Why, What was found,
// Fix written when a fix exists, Questions, each with a `Proposed:` line), and its front matter may name the accepted
// task it came from, `bug-of: <task>` (AC-10), and the repo its fix branch is in when that is not its own,
// `fix-repo: <repo>`: a repo of the workspace, or `kirunak`, kirunak's own checkout, where every fix to kirunak is made.
// Its findings and records sit beside it in kirunak/bugs/<slug>/ (the reviews, review-<n>.md).
// Its fix is the branch bug/<slug> in its fix repo. Whether the fix is ready is worked out each time, never stored: the
// branch exists, holds commits master does not, and no review beside the bug refused the branch's head. Like a draft,
// a bug is no task: any session writes, moves and drops one (none of these is an owner verb).

const TEMPLATE = new URL('../templates/bug.md', import.meta.url);
// kirunak's own checkout: the folder above lib/ of the code that runs. `kirunakRoot` in the workspace puts it elsewhere
// (the tests point it at a scratch repo).
const SELF = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const KIRUNAK = 'kirunak';
const NO_STATE = 'a bug has no state field: whether its fix is ready is worked out each time, from its branch ' +
  'bug/<slug> and the reviews beside it';
const PROPOSED = /^\s+Proposed:\s*\S/;

export const branchOf = (slug) => `bug/${slug}`;
const draftBranch = (slug) => `draft/${slug}`;

const real = (p) => (existsSync(p) ? realpathSync(p) : p);
export const kirunakRoot = (ws) => real(ws.kirunakRoot ? resolve(ws.kirunakRoot) : SELF);

// Where a bug is. A repo the workspace does not know is refused, as for a draft: only the owner adds a repo.
export function bugPaths(ws, id) {
  let parsed;
  try {
    parsed = parseId(id);
  } catch (e) {
    throw usage(e.message.replace('not a task id', 'not a bug id'));
  }
  const { repo, slug } = parsed;
  const r = ws.repos.find((x) => x.name === repo);
  if (!r) {
    throw refuse(`unknown repo ${repo}: kirunak's workspace lists ${ws.repos.map((x) => x.name).join(', ')}. ` +
      `Ask the owner to add ${repo} to kirunak's workspace first (${ws.modulePath}), then write the bug`);
  }
  const rel = `kirunak/bugs/${slug}.md`;
  const dirRel = `kirunak/bugs/${slug}`;
  return { id, repo, slug, root: r.root, rel, path: join(r.root, rel), dirRel, dir: join(r.root, dirRel), branch: branchOf(slug) };
}

// The repo a fix branch can be in: a workspace repo by its name, else `kirunak` for kirunak's own checkout; null for
// any other name.
export function repoNamed(ws, name) {
  const r = ws.repos.find((x) => x.name === name);
  if (r) return { name, root: r.root };
  return name === KIRUNAK ? { name, root: kirunakRoot(ws) } : null;
}

const fixRepoHint = (ws) => `a repo of the workspace (${ws.repos.map((r) => r.name).join(', ')}) or ${KIRUNAK}, kirunak's own checkout`;

// Every repo a bug's branch can be in: the workspace's, then kirunak's own when it is none of them.
function allRepos(ws) {
  const out = ws.repos.map((r) => ({ name: r.name, root: r.root }));
  const self = kirunakRoot(ws);
  if (!out.some((r) => r.root === self)) out.push({ name: KIRUNAK, root: self });
  return out;
}

// `k bug new <id> --title "..." [--bug-of <task>] [--fix-repo <repo>]`: the skeleton, its placeholders refused by the
// check until filled. Commits nothing: the session that writes the bug commits it. An id that is already a bug, a draft
// or a task is refused; `bugOf` must be an accepted task, as a bug of a task has been since kirunak-spikes (E-1, E-2).
export function newBug({ ws, id, title, bugOf = null, fixRepo = null, session = null, now = new Date(), dryRun = false }) {
  const name = oneLine(title);
  if (!name) throw usage('a bug needs its title, a few words that name it in every list: --title "<title>"');
  if (name.length > TITLE_MAX) throw usage(`a bug's title is a few words, at most ${TITLE_MAX} characters: ${name}`);
  const p = bugPaths(ws, id);
  if (existsSync(p.path)) throw refuse(`${id} is already a bug: ${p.path}`);
  const d = draftPaths(ws, id);
  if (existsSync(d.path)) throw refuse(`${id} is already a draft: ${d.path}; \`k bug from ${id}\` moves it into kirunak/bugs/`);
  const t = taskPaths(ws, id);
  if (existsSync(t.dir) || existsSync(t.record)) throw refuse(`${id} is already a task: ${existsSync(t.dir) ? t.dir : t.record}`);
  const of = bugOf === null || bugOf === undefined ? null : oneLine(bugOf);
  if (of === '') throw usage('--bug-of names the accepted task the bug was found in: --bug-of <repo>/<slug>');
  if (of) {
    parseId(of);
    const why = notAccepted(ws, of);
    if (why) throw refuse(why);
  }
  const fx = fixRepo === null || fixRepo === undefined ? null : oneLine(fixRepo);
  if (fx === '') throw usage(`--fix-repo names the repo of the fix branch ${p.branch}: ${fixRepoHint(ws)}`);
  if (fx && !repoNamed(ws, fx)) throw refuse(`unknown fix repo ${fx}: name ${fixRepoHint(ws)}`);
  const out = { ...p, title: name, bugOf: of, fixRepo: fx && fx !== p.repo ? fx : null };
  if (dryRun) return out;
  writeFileSync(mkdirFor(p.path), skeleton({ id, slug: p.slug, title: name, written: localDate(now), session, bugOf: of, fixRepo: out.fixRepo }));
  return out;
}

function mkdirFor(path) {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

// The bug's skeleton, with no bug-of or fix-repo line when it names none.
function skeleton({ id, slug, title, written, session, bugOf, fixRepo }) {
  const fill = { id, slug, title, written, session: oneLine(session) || '<session id>', bugOf: bugOf ?? '', fixRepo: fixRepo ?? '' };
  return readFileSync(TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '').replace(/^(bug-of|fix-repo): \n/gm, '');
}

// The rules a bug holds beyond a draft's: under each question its `Proposed:` line (a groomed draft's, the k-draft skill).
const BUG_RULES = {
  ...RULES,
  Questions(s, add) {
    RULES.Questions(s, add);
    for (const q of items(s, /^(\d+)\.\s+\S/, () => {})) {
      if (!q.more.some((l) => PROPOSED.test(l.text))) {
        add(q.line, `question ${q.m[1]} has no "Proposed:" line: under it, indented, your answer and why, or what is missing when only the owner can answer`);
      }
    }
  },
};

// [{ line, problem }]: every way the bug misses its shape, a groomed draft's with Fix written when a fix exists. `id` is
// the id its place gives it. Only the shape: its task, its fix repo and its fix's commits are checkBug()'s.
export function checkBugText(text, id = null) {
  const d = parseDraft(text);
  const problems = [];
  const add = (line, problem) => problems.push({ line, problem });
  const f = d.front;
  checkFront(d, id, add, 'bug');
  if ('bug-of' in f && !isTaskId(f['bug-of'])) {
    const named = f['bug-of'] ? `bug-of ${f['bug-of']} is not a task id` : 'bug-of is empty';
    add(d.frontLine['bug-of'], `${named}: name the accepted task the bug was found in, <repo>/<slug>, or leave the line out`);
  }
  if ('fix-repo' in f && !f['fix-repo']) add(d.frontLine['fix-repo'], "fix-repo is empty: name the repo of the fix branch, or leave the line out when it is the bug's own");
  if ('state' in f) add(d.frontLine.state, NO_STATE);
  checkSections(d, BUG_SECTIONS, add, { rules: BUG_RULES });
  return problems.sort((a, b) => a.line - b.line);
}

// `k bug check <id>`: the bug's problems, an empty list when it holds its shape, its task (when it names one) is
// accepted, its fix repo is known, and every commit its Fix written names is in the fix repo, the bug's or the task's.
export function checkBug(ws, id) {
  const p = bugPaths(ws, id);
  if (!existsSync(p.path)) throw refuse(`no bug ${id}: ${p.path} does not exist (k bug new ${id} --title "...")`);
  const text = readFileSync(p.path, 'utf8');
  const problems = checkBugText(text, id);
  const add = (line, problem) => problems.push({ line, problem });
  const d = parseDraft(text);
  const task = d.front['bug-of'];
  let taskRepo = null;
  if (task && isTaskId(task)) {
    const why = notAccepted(ws, task);
    if (why) add(d.frontLine['bug-of'], `bug-of: ${why}`);
    taskRepo = ws.repos.find((r) => r.name === parseId(task).repo) ?? null;
  }
  const named = d.front['fix-repo'];
  const fix = named ? repoNamed(ws, named) : null;
  if (named && !fix) add(d.frontLine['fix-repo'], `fix-repo: unknown repo ${named}: name ${fixRepoHint(ws)}`);
  // The fix repo, the bug's own, then the task's: the repos its fix's commits can be in.
  const repos = [fix, { name: p.repo, root: p.root }, taskRepo].filter((r, i, all) => r && all.findIndex((x) => x?.root === r.root) === i);
  const names = repos.map((r) => r.name);
  const where = names.length === 1 ? `not found in ${names[0]}` : names.length === 2 ? `found in neither ${names[0]} nor ${names[1]}` : `found in none of ${names.join(', ')}`;
  for (const l of d.sections.find((s) => s.name === FIX)?.lines ?? []) {
    for (const [, sha] of l.text.matchAll(FIX_COMMIT)) {
      if (!repos.some((r) => hasCommit(r.root, sha))) add(l.line, `## ${FIX}: commit ${sha} is ${where}`);
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

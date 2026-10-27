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

// --- The review lock and the reviews (written by Review & merge, gulnya/kirunak-bugs S-2) ---

// The lock a Review & merge holds while it runs (E-3): $KIRUNAK_HOME/bugs/<repo>/<slug>.review.json, holding
// { pid, started }; it counts while its pid runs.
export function reviewLockPath(home, id) {
  const { repo, slug } = parseId(id);
  return join(home, 'bugs', repo, `${slug}.review.json`);
}

export function pidRuns(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// { pid, started } while a Review & merge of the bug runs; null with no lock, a lock that cannot be read, or one whose
// pid is gone.
export function reviewing(home, id) {
  const path = reviewLockPath(home, id);
  if (!existsSync(path)) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return lock && pidRuns(lock.pid) ? { pid: lock.pid, started: lock.started ?? null } : null;
}

// A review file's verdict, head and base: front-matter keys, or `key: value` lines in its text; null for one missing.
export function readReview(text) {
  const { front } = parseDraft(text);
  const pick = (k) => oneLine(front[k] ?? new RegExp(`^${k}:[ \\t]*(\\S.*)$`, 'm').exec(text)?.[1]) || null;
  return { verdict: pick('verdict'), head: pick('head'), base: pick('base') };
}

// The reviews beside a bug, review-1.md, review-2.md, ..., in their order: [{ file, n, verdict, head, base }].
export function reviewsOf(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => [f, /^review-(\d+)\.md$/.exec(f)]).filter(([, m]) => m)
    .map(([file, m]) => ({ file, n: Number(m[1]), ...readReview(readFileSync(join(dir, file), 'utf8')) }))
    .sort((a, b) => a.n - b.n);
}

// One sha the other's prefix, at least 7 characters: a review may write the head short.
export const sameSha = (a, b) => {
  if (!a || !b) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort((u, v) => u.length - v.length);
  return x.length >= 7 && y.startsWith(x);
};

// The repo's master, else main; null with neither.
function mainOf(root) {
  return ['master', 'main'].find((b) => isBranch(root, b)) ?? null;
}

// The fix branch: { head, ahead }, ahead the commits master does not hold; null when the branch is not there.
function fixOf(root, branch) {
  if (!existsSync(root) || !isBranch(root, branch)) return null;
  const sha = git(root, ['rev-parse', `refs/heads/${branch}`]).trim();
  const main = mainOf(root);
  const ahead = main ? Number(git(root, ['rev-list', '--count', `refs/heads/${main}..refs/heads/${branch}`]).trim()) : 0;
  return { head: sha, ahead };
}

// `k bugs`: every bug in every repo of the workspace, those whose fix is ready first, then by the date written (oldest
// first, an undated one last), then by id. A row:
// { id, repo, slug, title, written, bugOf, fixRepo, branch, head, ahead, fixReady, reviewing, review, path }:
// `fixRepo` the repo its fix branch is looked for in (its own when it names none); `branch` bug/<slug> when it exists
// there, with its `head` (the full sha) and `ahead`; `reviewing` { pid, started } while a Review & merge runs; `review`
// the latest review beside it, { file, verdict, head, atHead }, `atHead` when it reviewed the branch's head.
export function list(ws, { home = ws.home } = {}) {
  const rows = [];
  for (const r of ws.repos) {
    const dir = join(r.root, 'kirunak', 'bugs');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = /^([a-z0-9-]{1,40})\.md$/.exec(name);
      if (!m || !statSync(join(dir, name)).isFile()) continue;
      rows.push(row(ws, r, m[1], join(dir, name), home));
    }
  }
  const key = (x) => x.written ?? '9999-99-99';
  return rows.sort((a, b) => Number(b.fixReady) - Number(a.fixReady) || key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
}

function row(ws, r, slug, path, home) {
  const id = `${r.name}/${slug}`;
  const { front } = parseDraft(readFileSync(path, 'utf8'));
  const fixRepo = oneLine(front['fix-repo']) || r.name;
  const where = repoNamed(ws, fixRepo);
  const fix = where ? fixOf(where.root, branchOf(slug)) : null;
  const reviews = reviewsOf(join(r.root, 'kirunak', 'bugs', slug));
  const refused = !!fix && reviews.some((v) => v.verdict !== 'clean' && sameSha(v.head, fix.head));
  const last = reviews.at(-1);
  return {
    id,
    repo: r.name,
    slug,
    title: oneLine(front.title) || slug,
    written: validDate(front.written ?? '') ? front.written : null,
    bugOf: oneLine(front['bug-of']) || null,
    fixRepo,
    branch: fix ? branchOf(slug) : null,
    head: fix?.head ?? null,
    ahead: fix?.ahead ?? 0,
    fixReady: !!fix && fix.ahead > 0 && !refused,
    reviewing: reviewing(home, id),
    review: last ? { file: last.file, verdict: last.verdict, head: last.head, atHead: !!fix && sameSha(last.head, fix.head) } : null,
    path,
  };
}

// What a bug's fix is, in a few words: reviewing, fix ready, what a review found at its head, or no fix.
export function fixLine(r) {
  if (r.reviewing) return 'reviewing';
  if (r.fixReady) return 'fix ready';
  if (r.review?.atHead && r.review.verdict !== 'clean') return `fix not ready: ${r.review.file} found ${r.review.verdict ?? 'no verdict'}`;
  return r.branch && r.ahead > 0 ? 'fix not ready' : 'no fix';
}

// One line a bug: id, title, date written, its fix, and `bug of <task>` when it names one.
export function format(rows) {
  if (!rows.length) return 'no bugs';
  const wId = Math.max(...rows.map((r) => r.id.length));
  const wTitle = Math.min(48, Math.max(...rows.map((r) => r.title.length)));
  const cut = (s) => (s.length > wTitle ? s.slice(0, wTitle - 3) + '...' : s);
  const tail = (r) => [fixLine(r), r.bugOf && `bug of ${r.bugOf}`].filter(Boolean).join(', ');
  return rows.map((r) => `${r.id.padEnd(wId)}  ${cut(r.title).padEnd(wTitle)}  ${(r.written ?? 'no date').padEnd(10)}  ${tail(r)}`).join('\n');
}


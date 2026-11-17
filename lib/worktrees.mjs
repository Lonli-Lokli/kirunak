import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { list as listBugs, quadDamageRun, repoNamed } from './bugs.mjs';
import { kirunakHome } from './home.mjs';
import { fold, insidePath, inUse, processPaths, readerName } from './os.mjs';
import { STEP_ID } from './plan.mjs';
import { leasesOf, releaseAll, relock } from './worktree-lock.mjs';
import { allTaskIds, taskPaths } from './workspace.mjs';

// The worktrees an acceptance removes (approval.md §4). Found by looking, never from a record: every worktree of the
// workspace's repos and of the repos a `worktrees` plugin adds, whose branch is merged into its repo's main line, with
// no changes, named in no open task's written files, with no process working in it or running from it and no other
// checkout inside it. A detached one goes when a plugin offers it, or, offered by none, when its HEAD is on the main
// line or its upstream and it is over DETACHED_DAYS old; either way its HEAD is on a branch or tag. Nothing here
// throws once the acceptance is recorded: what cannot be told, fails or takes too long is kept, with why.

// Every call but the removal itself has a time limit: past it the call fails, and what it was to tell keeps the
// worktree. A removal cut short is what a later look finds and finishes (`cutShort`).
const LIMIT_MS = 120_000;
const run = (cwd, cmd, args, timeout = LIMIT_MS) => spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout });
const git = (cwd, args, timeout) => run(cwd, 'git', args, timeout);
const firstLine = (r) => (r.error?.message || r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;
// The path as the disk spells it: macOS volumes ignore case, and realpathSync.native gives the case on disk, as lsof
// prints it, where realpathSync keeps the case typed.
const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export const tilde = (p, home = homedir()) => (inside(p, home) ? '~' + p.slice(home.length) : p);

// `git worktree list --porcelain -z`: [{ path, head, branch, detached, bare, locked, prunable, main }], the main
// checkout first.
export function worktreesOf(root) {
  const r = git(root, ['worktree', 'list', '--porcelain', '-z']);
  if (r.status !== 0) throw new Error(`git worktree list failed in ${tilde(root)}: ${firstLine(r)}`);
  const list = [];
  let w = null;
  for (const field of r.stdout.split('\0')) {
    if (!field) {
      w = null;
      continue;
    }
    const [key, ...rest] = field.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') list.push((w = { path: value, main: list.length === 0 }));
    else if (!w) continue;
    else if (key === 'HEAD') w.head = value;
    else if (key === 'branch') w.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') w.detached = true;
    else if (key === 'bare') w.bare = true;
    else if (key === 'locked') w.locked = value || 'no reason given';
    else if (key === 'prunable') w.prunable = value || 'its folder is gone';
  }
  return list;
}

// The repo's main line: the branch origin's HEAD names, else main, else master, when there is a local branch of that
// name; null when there is none.
export function mainLine(root) {
  const r = git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  const origin = r.status === 0 ? r.stdout.trim() : '';
  const names = [origin && origin.slice(origin.indexOf('/') + 1), 'main', 'master'].filter(Boolean);
  return names.find((b) => git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0) ?? null;
}

// The main line's upstream, origin/<main>, when the repo has that remote branch; null when it has none.
export function upstreamOf(root, main) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${main}`]).status === 0 ? `origin/${main}` : null;
}

// How many of the branch's commits a line (a full ref: refs/heads/master, refs/remotes/origin/master) lacks: 0 when
// the branch is in it, or every change of it is (`git cherry` shows none left); { error } when git cannot tell.
export function commitsLeft(root, branch, line) {
  const a = git(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, line]);
  if (a.status === 0) return 0;
  if (a.status !== 1) return { error: firstLine(a) };
  const c = git(root, ['cherry', line, `refs/heads/${branch}`]);
  if (c.status !== 0) return { error: firstLine(c) };
  return c.stdout.split('\n').filter((l) => l.startsWith('+')).length;
}

// How many of the branch's commits the main line and its upstream (`up`, upstreamOf) lack, counted against the one
// that lacks fewest, the main line on a tie: { n, line }, line naming it (master, origin/master). A local main line
// behind origin/<main> still counts a branch merged there (gulnya/worktree-sweep-keeps-stale AC-5). { error } when
// git cannot tell.
export function leftIn(root, branch, main, up) {
  const local = commitsLeft(root, branch, `refs/heads/${main}`);
  if (typeof local === 'object') return local;
  if (local === 0 || !up) return { n: local, line: main };
  const remote = commitsLeft(root, branch, `refs/remotes/${up}`);
  if (typeof remote === 'object') return remote;
  return remote < local ? { n: remote, line: up } : { n: local, line: main };
}

// A detached worktree no plugin offers goes once it is over this many days old (gulnya/worktree-sweep-keeps-stale
// D-2): a baseline a live step still needs is younger, or locked, or named in its task's written files (E-1).
export const DETACHED_DAYS = 3;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ageText = (ms) => {
  const d = Math.floor(ms / DAY_MS);
  if (d >= 1) return `${d} day${d > 1 ? 's' : ''} old`;
  const h = Math.floor(ms / HOUR_MS);
  return h >= 1 ? `${h} hour${h > 1 ? 's' : ''} old` : 'under an hour old';
};

// A detached worktree's age (D-2): the time since its own git folder's HEAD file was written (`git rev-parse
// --git-path HEAD` in it), which git does when the worktree is made and when its HEAD moves; never the index, which
// `git status` rewrites. { ms } or { error }.
function ageOf(path, now) {
  const r = git(path, ['rev-parse', '--git-path', 'HEAD']);
  if (r.status !== 0) return { error: firstLine(r) };
  try {
    return { ms: now.getTime() - statSync(resolve(path, r.stdout.trim())).mtimeMs };
  } catch (e) {
    return { error: e.message };
  }
}

// The line a detached HEAD is on (gulnya/worktree-sweep-keeps-stale AC-3): the main line's name when the commit is
// in it, else the upstream's when it is in that; null when in neither; { error } when git cannot tell.
function lineHolding(root, head, main, up) {
  for (const [ref, name] of [[`refs/heads/${main}`, main], ...(up ? [[`refs/remotes/${up}`, up]] : [])]) {
    const r = git(root, ['merge-base', '--is-ancestor', head, ref]);
    if (r.status === 0) return name;
    if (r.status !== 1) return { error: firstLine(r) };
  }
  return null;
}

// Whether a branch the main line holds has commits of its own: false when its head is on the main line's first-parent
// line (cut from the main line and never committed to, so it only reads as merged), true when it sits off it (a fix
// merged with --no-ff or cherry-picked); { error } when git cannot tell.
export function ownCommits(root, branch, main) {
  const h = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  const m = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${main}^{commit}`]);
  if (h.status !== 0 || m.status !== 0) return { error: firstLine(h.status !== 0 ? h : m) };
  const head = h.stdout.trim();
  if (head === m.stdout.trim()) return false;
  const r = git(root, ['rev-list', '--first-parent', '--parents', `${head}..${m.stdout.trim()}`]);
  if (r.status !== 0) return { error: firstLine(r) };
  return r.stdout.trim().split('\n').at(-1).split(' ')[1] !== head;
}

// The fix branches bug/<slug> among the merged candidates that stay (asilak/kirunak-worktrees-lsof-windows E-1), as
// a Map of the worktree to why: the one whose bug the live Quad Damage run is on, whatever its commits, and one whose
// bug is still open while it has no commit of its own (a fresh one reads as merged). A merged fix with commits, or one
// whose bug is gone, goes as any branch. The bugs and the run are read once, and only when such a candidate exists.
// `only` is Review & merge's own removal of the branch it has just merged: the run on that bug is its own, so it
// keeps nothing there. What cannot be told keeps the worktree.
const BUG_BRANCH = /^bug\/([a-z0-9-]{1,40})$/;
function bugBranches(ws, candidates, main, { only, openBugs, quadDamage }) {
  const out = new Map();
  const ours = candidates.filter((c) => BUG_BRANCH.test(c.w.branch ?? ''));
  if (!ours.length) return out;
  let rows;
  try {
    rows = openBugs(ws);
  } catch (e) {
    for (const { w } of ours) out.set(w, `cannot tell whether its bug is open: ${firstLine({ error: e })}`);
    return out;
  }
  let run = null;
  if (!only) {
    try {
      run = quadDamage(ws);
    } catch {
      run = null;
    }
  }
  const roots = new Map();
  const rootOf = (name) => {
    if (!roots.has(name)) {
      const r = repoNamed(ws, name);
      roots.set(name, r ? real(r.root) : null);
    }
    return roots.get(name);
  };
  for (const { w } of ours) {
    const slug = BUG_BRANCH.exec(w.branch)[1];
    const bug = rows.find((b) => b.slug === slug && rootOf(b.fixRepo) === w.repo);
    if (!bug) continue;
    if (run?.bug === bug.id) {
      out.set(w, `Quad Damage is on the bug ${bug.id}`);
      continue;
    }
    const own = ownCommits(w.repo, w.branch, main(w.repo));
    if (typeof own === 'object') out.set(w, `cannot tell whether ${w.branch} has commits of its own: ${own.error}`);
    else if (!own) out.set(w, `the bug ${bug.id} is still open and ${w.branch} has no commit of its own`);
  }
  return out;
}

// A file's text, or null when it is over 4 MB, binary (a NUL byte in its first 8,000 bytes, git's own test; it is
// read no further) or cannot be read (gone since the walk, no permission).
const TEXT_MAX = 4 << 20;
const BINARY_PEEK = 8000;
function textOf(f) {
  let fd;
  try {
    const { size } = lstatSync(f);
    if (size > TEXT_MAX) return null;
    fd = openSync(f, 'r');
    const buf = Buffer.alloc(size);
    let n = readSync(fd, buf, 0, Math.min(size, BINARY_PEEK), 0);
    if (buf.subarray(0, n).includes(0)) return null;
    for (let r; n < size && (r = readSync(fd, buf, n, size - n, n)); n += r);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The files a task writes for people, the only ones that name a worktree (gulnya/worktree-sweep-keeps-stale D-1),
// matched by name: these in the task folder, and STEP_WRITTEN in a step's folder steps/<step id>/, the id as a plan
// reads it (lib/plan.mjs's STEP_ID: S-1, S-13a, S-14-M1; steps/notes/ is no step's). Nothing else counts,
// whatever its extension: a log, evidence, a brief, a diff, an amendment or a handoff is a tool's output or a copy,
// and a path in it (a build's log, a saved `k worktrees` run, the cache prune's "kept <sha>: locked by <path>") says
// nothing about whether the task still needs the worktree.
const TASK_WRITTEN = new Set(['task.md', 'plan.md', 'notes.md', 'progress.md', 'review.md']);
const STEP_WRITTEN = new Set(['report.md', 'needs.json']);
const STEP_FOLDER = new RegExp(`^${STEP_ID}$`);

// A task folder's written files, as [path, its name in the task folder with /]: regular files only, never through a
// link. A folder that cannot be read gives none.
function writtenFiles(dir) {
  const entries = (d, keep) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter(keep).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const out = entries(dir, (e) => e.isFile() && TASK_WRITTEN.has(e.name)).map((n) => [join(dir, n), n]);
  for (const step of entries(join(dir, 'steps'), (e) => e.isDirectory() && STEP_FOLDER.test(e.name))) {
    for (const n of entries(join(dir, 'steps', step), (e) => e.isFile() && STEP_WRITTEN.has(e.name))) out.push([join(dir, 'steps', step, n), `steps/${step}/${n}`]);
  }
  return out;
}

// For each worktree, the first written file (writtenFiles) of an open task (one with no done.json) but the closing
// one that names it: Map(w → { id, file }). The files are read one at a time, each dropped once matched against every
// worktree, so however much the open tasks hold, one file's text is in memory (gulnya/worktrees-read-oom).
function namedByOpenTasks(ws, closing, list, platform) {
  const named = new Map();
  for (const id of allTaskIds(ws)) {
    if (named.size === list.length) break;
    if (id === closing) continue;
    const { dir } = taskPaths(ws, id);
    if (existsSync(join(dir, 'done.json'))) continue;
    for (const [f, file] of writtenFiles(dir)) {
      if (named.size === list.length) break;
      const text = textOf(f);
      if (text === null) continue;
      for (const w of list) {
        if (!named.has(w) && (names(text, w.real, platform) || (w.path !== w.real && names(text, w.path, platform)))) named.set(w, { id, file });
      }
    }
  }
  return named;
}

// Whether the text holds the path (absolute, from ~ or from $HOME) as a whole name: the next character is not one a
// folder's name goes on with, so ~/sources/app never matches ~/sources/app-capture. Under the platform's fold: on
// macOS and Windows in any case, as the volume reads it, and on Windows with either slash.
function names(text, path, platform) {
  const body = fold(text, platform);
  const t = tilde(path);
  const forms = (t === path ? [path] : [path, t, '$HOME' + t.slice(1)]).map((f) => fold(f, platform));
  for (const f of forms) {
    for (let i = body.indexOf(f); i !== -1; i = body.indexOf(f, i + 1)) {
      if (!/[A-Za-z0-9_-]/.test(body[i + f.length] ?? '')) return true;
    }
  }
  return false;
}

// The most folders looked through for checkouts in one worktree; past it the worktree stays.
const MAX_FOLDERS = 50_000;

// The folders below `path` (at any depth, past build output, never through a link) that hold a .git of their own:
// another repo or worktree, which `git worktree remove` would delete with it. Null past MAX_FOLDERS.
function checkoutsInside(path, prune) {
  const found = [];
  let visited = 0;
  const walk = (dir) => {
    if (++visited > MAX_FOLDERS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== path && entries.some((e) => e.name === '.git')) return void found.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && !prune.has(e.name)) walk(join(dir, e.name));
    }
  };
  walk(path);
  return visited > MAX_FOLDERS ? null : found;
}

// The XY code of each path `git status --porcelain -z` lists (a rename's or copy's first path skipped with it).
function changesOf(out) {
  const fields = out.split('\0');
  const codes = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const xy = fields[i].slice(0, 2);
    codes.push(xy);
    if (/[RC]/.test(xy)) i++;
  }
  return codes;
}

// A removal cut short (killed, from the phone's ten minutes) leaves the worktree with tracked files deleted and
// nothing else changed: nothing of its own is in it, and only `--force` takes it.
const cutShort = (codes) => codes.length > 0 && codes.every((xy) => xy === ' D' || xy === 'D ');

// What the worktree holds that git ignores, besides build output: [{ folder, kb }], largest first. A folder git
// ignores whole is one entry; a file is counted in the folder it sits in, by the disk it takes as du counts. Any path
// with a build-output name in it is left out.
export function ignoredFolders(path, buildNames) {
  const r = git(path, ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=all']);
  if (r.status !== 0) return null;
  const sizes = new Map();
  const dirs = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry.startsWith('!! ')) continue;
    const rel = entry.slice(3);
    const parts = rel.replace(/\/$/, '').split('/');
    if (parts.some((s) => buildNames.has(s))) continue;
    if (rel.endsWith('/')) {
      dirs.push(rel);
      continue;
    }
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : './';
    let kb = 0;
    try {
      kb = Math.ceil((lstatSync(join(path, rel)).blocks * 512) / 1024);
    } catch {
      continue; // gone since git listed it
    }
    sizes.set(folder, (sizes.get(folder) || 0) + kb);
  }
  // du in batches, its options ended so a folder named like one is a folder; a folder du does not size is listed
  // with its size unknown, never dropped.
  for (let i = 0; i < dirs.length; i += 500) {
    const batch = dirs.slice(i, i + 500);
    const du = run(path, 'du', ['-sk', '--', ...batch]);
    const sized = new Set();
    for (const line of (du.stdout || '').split('\n')) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      const folder = m[2].endsWith('/') ? m[2] : m[2] + '/';
      sized.add(folder);
      sizes.set(folder, (sizes.get(folder) || 0) + Number(m[1]));
    }
    for (const d of batch) if (!sized.has(d)) sizes.set(d, null);
  }
  const known = (kb) => (kb === null ? -1 : kb);
  return [...sizes].map(([folder, kb]) => ({ folder, kb })).sort((a, b) => known(b.kb) - known(a.kb) || a.folder.localeCompare(b.folder));
}

export const human = (kb) =>
  kb < 1024 ? `${kb}K` : kb < 1024 ** 2 ? `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)}M` : `${(kb / 1024 ** 2).toFixed(kb < 10 * 1024 ** 2 ? 1 : 0)}G`;

// One short line of what a worktree holds besides build output: the five largest folders, then how many more.
export function holdsLine(folders) {
  if (folders === null) return 'git cannot list what it ignores';
  if (!folders.length) return 'nothing besides build output';
  const size = (kb) => (kb === null ? 'size unknown' : human(kb));
  const shown = folders.slice(0, 5).map((f) => `${f.folder} ${size(f.kb)}`);
  const rest = folders.slice(5);
  const unknown = rest.filter((f) => f.kb === null).length;
  if (rest.length) shown.push(`and ${rest.length} more, ${human(rest.reduce((n, f) => n + (f.kb || 0), 0))}${unknown ? ` and ${unknown} of unknown size` : ''}`);
  return shown.join(', ');
}

// What the plugins add: their repos, their offers and the names of build output. `offers(scanned, gone)` asks each
// plugin's `candidates`, with `gone` (the paths removed, or that would be in a dry run) when given: { offers: path →
// { remove, why } (a keep from any plugin wins), failed }. A plugin that fails adds nothing, sets `failed` and is named
// in `problems`.
async function fromPlugins(ws, problems) {
  const impls = ws.seams?.worktrees || [];
  const repos = [];
  const buildNames = new Set();
  for (const impl of impls) {
    try {
      repos.push(...((await impl.repos({ ws })) || []));
      for (const n of (await impl.buildOutput({ ws })) || []) buildNames.add(n);
    } catch (e) {
      problems.push(`a worktrees plugin failed: ${e.message}`);
    }
  }
  return {
    repos,
    buildNames,
    offers: async (scanned, gone) => {
      const offers = new Map();
      let failed = false;
      for (const impl of impls) {
        let list = [];
        try {
          list = (await impl.candidates({ ws, repos: scanned, ...(gone ? { gone: new Set(gone) } : {}) })) || [];
        } catch (e) {
          failed = true;
          problems.push(`a worktrees plugin failed: ${e.message}`);
        }
        for (const c of list) {
          const p = real(c.path);
          if (offers.get(p)?.remove === false) continue;
          offers.set(p, { remove: c.remove === true, why: c.why || (c.remove ? 'a plugin offers it' : 'a plugin keeps it') });
        }
      }
      return { offers, failed };
    },
  };
}

// The repos to look in, each once (by git's common dir), as its main checkout: [{ root }].
function reposOf(paths, problems) {
  const seen = new Map();
  for (const p of paths) {
    const r = git(p, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (r.status !== 0) {
      problems.push(`${tilde(p)} is not a git repo: ${firstLine(r)}`);
      continue;
    }
    const common = real(r.stdout.trim());
    if (!seen.has(common)) seen.set(common, p);
  }
  return [...seen.values()];
}

// The plugins' answer now, with no `gone`, as worktrees()'s first ask under `only` (`only.before`): Review & merge
// takes it before its merge, while the branch it merges still pins what it pinned. → { offers, failed, problems }.
// Never throws: a failure is `failed`, and keeps every worktree it would have freed.
export async function pluginsBefore({ ws, root }) {
  const problems = [];
  try {
    const plugins = await fromPlugins(ws, problems);
    return { ...(await plugins.offers(reposOf([root], problems))), problems };
  } catch (e) {
    return { offers: new Map(), failed: true, problems: [...problems, `a worktrees plugin failed: ${e.message}`] };
  }
}

// A lock of kirunak's, one lease per session (lib/worktree-lock.mjs): the leases that ended are taken out (only with
// `remove`: the lock rewritten with the live ones, or unlocked when none is left); any live one keeps the worktree,
// its line naming each; with none live the worktree goes on as an unlocked one, its line saying so: { keep } or
// { note }. Any other lock keeps.
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
function lockOf(w, remove, now) {
  const leases = leasesOf(w.locked);
  if (!leases) return { keep: `locked: ${w.locked}` };
  const live = leases.filter((l) => l.until > now);
  const ended = leases.filter((l) => l.until <= now);
  const failed = remove && ended.length ? relock(w.repo, w.real, live, git) : null;
  if (live.length) {
    const keep = live.map((l) => `locked: session ${l.session} works in it until ${hhmm(l.until)}`).join('; ');
    return { keep: failed ? `${keep}; ${failed}` : keep };
  }
  if (failed) return { keep: `locked: ${w.locked}; ${failed}` };
  const said = (l) => (remove ? `lock of session ${l.session} lifted: its lease ended ${l.text}` : `would lift the lock of session ${l.session}: its lease ended ${l.text}`);
  return { note: ended.map(said).join('; ') };
}

// worktrees({ ws, closing, remove, sizes }) → { removed: [w], kept: [w], problems: [string] }, w being
// { path, repo, branch, why, holds?, branchDeleted?, branchError? }. Without `remove` it only says what an acceptance
// would remove now (`removed` then reads "would remove"); `closing` is the task being accepted, which no longer counts
// as open; `sizes` adds `holds`, the folders it holds besides build output; `processes` is the look at processes
// (lib/os.mjs's processPaths), `platform` the system it reads as and `rename` the move inUse() tries, for tests;
// `only` { root, branch } looks at that repo's worktrees of that branch alone (a bug's, once Review & merge merged it);
// `now` is the clock a lock's lease and a detached worktree's age are read against; `openBugs` (lib/bugs.mjs's list)
// and `quadDamage` (the live run, lib/bugs.mjs's quadDamageRun) are read for a merged bug/<slug> alone
// (`bugBranches`); `session`, with `remove`, is the session running the removal (k accept's, Review & merge's): it is
// taken out of every lock of kirunak's in the repos first (lib/worktree-lock.mjs's releaseAll), under `only` too, so
// a worktree it alone held goes.
// Deepest first, so a worktree inside another goes before it. The detached worktrees a plugin offers are decided last,
// by the plugins' second answer, given `gone` (gulnya/worktree-sweep-keeps-stale D-3): the games-core cache worktree
// only a removed checkout pinned goes in the same sweep, and shows in the same dry run. Under `only` the one other
// worktree looked at is a detached one a plugin kept on the first ask and offers on the second, freed by this removal;
// `only.before` (pluginsBefore), when given, is that first ask, taken before Review & merge's merge.
export async function worktrees({ ws, closing = null, remove = false, sizes = false, processes = processPaths, platform = process.platform, rename, only = null, now = new Date(),
  openBugs = listBugs, quadDamage = (w) => quadDamageRun(w.home || kirunakHome()), session = null }) {
  const problems = [];
  const removed = [];
  const kept = [];
  try {
    const plugins = await fromPlugins(ws, problems);
    const release = remove && !!session;
    const every = !only || release ? reposOf([...ws.repos.map((r) => r.root), ...plugins.repos], only ? [] : problems) : [];
    if (release) problems.push(...(await releaseAll({ session, roots: every })).problems);
    const roots = only ? reposOf([only.root], problems) : every;
    const all = [];
    for (const root of roots) {
      try {
        const list = worktreesOf(root);
        const main = list[0] ? real(list[0].path) : root;
        for (const w of list) all.push({ ...w, real: real(w.path), repo: main });
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (only?.before) problems.push(...only.before.problems);
    const first = only?.before ?? (await plugins.offers(roots));
    const lines = new Map();
    const mainOf = (repo) => (lines.has(repo) ? lines.get(repo) : lines.set(repo, mainLine(repo)).get(repo));
    const ups = new Map();
    const upOf = (repo, main) => (ups.has(repo) ? ups.get(repo) : ups.set(repo, upstreamOf(repo, main)).get(repo));
    const noMain = (repo) => `${tilde(repo)} has no main line (origin's HEAD branch, main or master)`;
    // A lifted lock's line goes first in the worktree's reason, kept or removed.
    const said = (w, why) => (w.lifted ? `${w.lifted}; ${why}` : why);
    const keep = (w, why) => kept.push({ path: w.real, repo: w.repo, branch: w.branch ?? null, why: said(w, why) });
    // A detached worktree no plugin offers (gulnya/worktree-sweep-keeps-stale AC-3, AC-4): a candidate once its HEAD
    // is on the main line or its upstream and it is over DETACHED_DAYS old, { why }; else { keep }, naming the test
    // that kept it. While a plugin failed none is a candidate: it may be one the plugin would have kept.
    const detached = (w) => {
      if (first.failed) return { keep: 'detached, and a worktrees plugin failed, so whether one offers it cannot be told' };
      const main = mainOf(w.repo);
      if (!main) return { keep: `detached, and ${noMain(w.repo)}` };
      const up = upOf(w.repo, main);
      const on = w.head ? lineHolding(w.repo, w.head, main, up) : { error: 'git lists no HEAD for it' };
      if (on && typeof on === 'object') return { keep: `detached, and whether its HEAD is on ${main} cannot be told: ${on.error}` };
      if (!on) return { keep: `detached, its HEAD ${w.head.slice(0, 7)} is not on ${main}${up ? ` or ${up}` : ''}` };
      const age = ageOf(w.real, now);
      if (age.error) return { keep: `detached on ${on}, and its age cannot be read: ${age.error}` };
      if (age.ms <= DETACHED_DAYS * DAY_MS) return { keep: `detached on ${on}, ${ageText(age.ms)}, not over ${DETACHED_DAYS} days` };
      return { why: `detached on ${on}, ${ageText(age.ms)}` };
    };
    // A worktree's first checks: one whose folder is gone, or that a lock holds, stays (false); a lock of kirunak's
    // whose leases all ended is lifted, its line kept for the worktree's reason (true).
    const open = (w) => {
      if (w.prunable) {
        keep(w, `its folder is gone (${w.prunable}): git worktree prune forgets it`);
        return false;
      }
      if (w.locked) {
        const lock = lockOf(w, remove, now);
        if (lock.keep) {
          keep(w, lock.keep);
          return false;
        }
        w.lifted = lock.note;
      }
      return true;
    };
    const candidates = [];
    const offered = []; // the detached worktrees a plugin offers, decided by its second answer
    for (const w of all) {
      if (w.main || w.bare || (only && w.branch !== only.branch)) continue;
      const offer = first.offers.get(w.real);
      if (!open(w)) continue;
      if (w.detached || !w.branch) {
        if (offer) offered.push(w);
        else {
          const d = detached(w);
          if (d.keep) keep(w, d.keep);
          else candidates.push({ w, why: d.why });
        }
      } else if (offer && !offer.remove) keep(w, offer.why);
      else {
        const main = mainOf(w.repo);
        if (!main) keep(w, noMain(w.repo));
        else if (w.branch === main) keep(w, `it is ${main}, the main line`);
        else {
          const left = leftIn(w.repo, w.branch, main, upOf(w.repo, main));
          if (left.error) keep(w, `cannot tell whether ${w.branch} is merged: ${left.error}`);
          else if (left.n > 0) keep(w, `${w.branch} has ${left.n} commit${left.n > 1 ? 's' : ''} not in ${left.line}`);
          else candidates.push({ w, why: `${w.branch} merged into ${left.line}` });
        }
      }
    }
    // Under `only`, the worktrees a plugin kept on the first ask: the ones this removal may free.
    const pinned = only && !first.failed ? [...first.offers].filter(([, o]) => !o.remove).map(([p]) => p) : [];
    if (!candidates.length && !offered.length && !pinned.length) return { removed, kept: kept.sort((a, b) => a.path.localeCompare(b.path)), problems };
    const bugKeeps = bugBranches(ws, candidates, (repo) => lines.get(repo), { only, openBugs, quadDamage });
    const named = namedByOpenTasks(ws, closing, [...candidates.map((c) => c.w), ...offered], platform);
    const canon = new Map();
    const canonical = (p) => (canon.has(p) ? canon.get(p) : canon.set(p, real(p)).get(p));
    let running; // the look at processes, once a candidate gets that far
    const prune = new Set([...plugins.buildNames, 'node_modules']);
    const gone = new Set();
    // Why a candidate with no changes stays, or null: each check runs only when those before it let it through.
    const stays = (w) => {
      if (!w.branch) {
        const r = git(w.real, ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
        if (r.status !== 0) return `cannot tell whether its HEAD is on a branch or tag: ${firstLine(r)}`;
        if (!r.stdout.trim()) return `its HEAD ${(w.head || '').slice(0, 7)} is on no branch or tag`;
      }
      const by = named.get(w);
      if (by) return `the open task ${by.id} names it (${by.file})`;
      // On Windows the look is empty, asking nothing (asilak/kirunak-cross-platform AC-10): the session locks above and
      // the move aside at the removal tell a worktree in use there.
      if (running === undefined) running = processes({ platform })?.map((p) => ({ ...p, path: canonical(p.path) })) ?? null;
      if (!running) return `cannot tell whether a process works in it or runs from it (${readerName(platform)} gave no answer)`;
      const p = running.find((p) => insidePath(p.path, w.real, platform));
      if (p) return `${p.command || 'a process'} (pid ${p.pid}) ${p.kind === 'cwd' ? 'works in it' : 'runs from it'}`;
      const within = checkoutsInside(w.real, prune);
      if (!within) return `too many folders to look through for checkouts (over ${MAX_FOLDERS})`;
      const left = within.filter((c) => !gone.has(real(c)));
      return left.length ? `it holds the checkout ${tilde(left[0])}` : null;
    };
    const depth = (p) => p.split(sep).length;
    const deepestFirst = (list) => list.sort((a, b) => depth(b.w.real) - depth(a.w.real) || a.w.real.localeCompare(b.w.real));
    // A candidate's last checks, then its removal (or, in a dry run, its "would remove" line): gone holds it once it
    // goes, or would.
    const decide = (c) => {
      const { w } = c;
      if (bugKeeps.has(w)) {
        keep(w, bugKeeps.get(w));
        return;
      }
      const status = git(w.real, ['status', '--porcelain', '-z']);
      const codes = status.status === 0 ? changesOf(status.stdout) : null;
      const force = codes !== null && cutShort(codes);
      const n = codes?.length;
      const reason = codes === null ? `git status failed: ${firstLine(status)}` : n && !force ? `${n} uncommitted change${n > 1 ? 's' : ''}` : stays(w);
      if (reason) {
        keep(w, reason);
        return;
      }
      const why = said(w, force ? `${c.why}; its only changes are ${n} deleted tracked file${n > 1 ? 's' : ''}, as a removal cut short leaves, so it goes with --force` : c.why);
      if (!remove) {
        gone.add(w.real);
        removed.push({ path: w.real, repo: w.repo, branch: w.branch ?? null, why, ...(sizes ? { holds: holdsLine(ignoredFolders(w.real, plugins.buildNames)) } : {}) });
      } else {
        // Without --force but for a removal cut short: git refuses a worktree with changes or untracked files that
        // appeared since the look. No time limit: a removal stopped halfway is worse than a slow one. On Windows first
        // the move aside and back: a removal Windows refuses halfway leaves git without the worktree and its branch.
        const busy = inUse(w.real, { platform, ...(rename ? { rename } : {}) });
        if (busy) {
          keep(w, busy);
          return;
        }
        const r = git(w.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), w.real], 0);
        if (r.status !== 0) {
          keep(w, `git worktree remove failed: ${firstLine(r)}`);
          return;
        }
        gone.add(w.real);
        const done = { path: w.real, repo: w.repo, branch: w.branch ?? null, why };
        if (w.branch) {
          const b = git(w.repo, ['branch', '-D', w.branch]);
          done.branchDeleted = b.status === 0;
          if (b.status !== 0) done.branchError = firstLine(b);
        }
        removed.push(done);
      }
    };
    for (const c of deepestFirst(candidates)) decide(c);
    if (offered.length) {
      // The plugins asked again once the others are decided, with what went or would go: a cache worktree only a
      // removed checkout pinned is free now. Their second answer decides; a keep from any plugin wins, and while one
      // fails, or none offers it again, each stays.
      const second = await plugins.offers(roots, gone);
      const later = [];
      for (const w of offered) {
        const offer = second.offers.get(w.real);
        const before = first.offers.get(w.real).why;
        if (second.failed) keep(w, `a worktrees plugin failed when asked again (it first said: ${before})`);
        else if (!offer) keep(w, `no plugin offers it when asked again (one first said: ${before})`);
        else if (!offer.remove) keep(w, offer.why);
        else later.push({ w, why: offer.why });
      }
      for (const c of deepestFirst(later)) decide(c);
    }
    if (pinned.length) {
      // Review & merge's removal (`only`; gulnya/worktree-sweep-keeps-stale AC-6, the owner's ruling 2026-11-16,
      // "Remove it at Review & merge") takes with the branch's worktrees the detached worktrees it freed, and nothing
      // else: one a plugin kept on the first ask (taken before the merge, `only.before`, while the merged branch's
      // own lock still pinned; else at this call, when only a checkout's own file still pins) and offers for removal
      // when asked again with what this removal took (`gone`). One already free before it, and any other stale
      // worktree, wait for a full sweep. While a plugin fails on either ask, each stays, as does one a usual check
      // keeps (decide). They are looked for in the repos that hold them, wherever those are, and nowhere else.
      const second = await plugins.offers(roots, gone);
      const freed = new Set(second.failed ? [] : pinned.filter((p) => second.offers.get(p)?.remove === true));
      const later = [];
      for (const repo of freed.size ? reposOf([...freed], []) : []) {
        let list;
        try {
          list = worktreesOf(repo);
        } catch (e) {
          problems.push(e.message);
          continue;
        }
        const main = real(list[0].path);
        for (const x of list) {
          const w = { ...x, real: real(x.path), repo: main };
          if (w.main || w.bare || !(w.detached || !w.branch) || !freed.has(w.real) || !open(w)) continue;
          later.push({ w, why: second.offers.get(w.real).why });
        }
      }
      for (const [w, by] of namedByOpenTasks(ws, closing, later.map((c) => c.w), platform)) named.set(w, by);
      for (const c of deepestFirst(later)) decide(c);
    }
  } catch (e) {
    problems.push(`stopped looking: ${e.message}`);
  }
  kept.sort((a, b) => a.path.localeCompare(b.path));
  return { removed, kept, problems };
}

// The lines `k accept` and `k worktrees` print.
export function lines({ removed, kept, problems }, { dry = false } = {}) {
  const out = [];
  for (const w of removed) {
    const what = dry ? 'would remove' : 'removed';
    const branch = !w.branch || dry ? '' : w.branchDeleted ? ', branch deleted' : `, branch kept: ${w.branchError}`;
    out.push(`${what} ${tilde(w.path)} (${w.why}${branch})${w.holds ? `: ${w.holds}` : ''}`);
  }
  for (const w of kept) out.push(`${dry ? 'would keep' : 'kept'} ${tilde(w.path)}: ${w.why}`);
  for (const p of problems) out.push(`worktrees: ${p}`);
  return out;
}

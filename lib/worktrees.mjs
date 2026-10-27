import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { allTaskIds, taskPaths } from './workspace.mjs';

// The worktrees an acceptance removes (approval.md §4). Found by looking, never from a record: every worktree of the
// workspace's repos and of the repos a `worktrees` plugin adds, whose branch is merged into its repo's main line, with
// no changes, named by no open task, with no process working in it or running from it and no other checkout inside
// it. A detached one goes only when a plugin offers it and its HEAD is on a branch or tag. Nothing here throws once
// the acceptance is recorded: what cannot be told, fails or takes too long is kept, with why.

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

// How many of the branch's commits the main line lacks: 0 when the branch is in it, or every change of it is
// (`git cherry` shows none left); { error } when git cannot tell.
export function commitsLeft(root, branch, main) {
  const a = git(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${main}`]);
  if (a.status === 0) return 0;
  if (a.status !== 1) return { error: firstLine(a) };
  const c = git(root, ['cherry', `refs/heads/${main}`, `refs/heads/${branch}`]);
  if (c.status !== 0) return { error: firstLine(c) };
  return c.stdout.split('\n').filter((l) => l.startsWith('+')).length;
}

// The folder each process works in and the programs and libraries it runs from ([{ pid, command, kind: 'cwd' | 'txt',
// path }]), from lsof; null when lsof cannot tell within a minute. Files merely open are left out: Spotlight and the
// like open them for moments, which would keep worktrees at random.
export function processPaths() {
  const r = spawnSync('lsof', ['-w', '-d', 'cwd,txt', '-F', 'pcfn'], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000 });
  if (r.error || !r.stdout) return null;
  const list = [];
  let p = {};
  let kind = null;
  for (const line of r.stdout.split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') p = { pid: Number(value) };
    else if (line[0] === 'c') p.command = value;
    else if (line[0] === 'f') kind = value === 'cwd' ? 'cwd' : 'txt';
    else if (line[0] === 'n' && kind) list.push({ ...p, kind, path: value });
  }
  return list;
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

// For each worktree, the first file of an open task (one with no done.json) but the closing one that names it:
// Map(w → { id, file }). One walk reads one file at a time and drops it once matched against every worktree, so
// however much the open tasks hold, one file's text is in memory (gulnya/worktrees-read-oom).
function namedByOpenTasks(ws, closing, list) {
  const named = new Map();
  const walk = (id, dir, d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (named.size === list.length) return;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(id, dir, f);
      else if (e.isFile()) {
        const text = textOf(f);
        if (text === null) continue;
        for (const w of list) {
          if (!named.has(w) && (names(text, w.real) || (w.path !== w.real && names(text, w.path)))) named.set(w, { id, file: relative(dir, f) });
        }
      }
    }
  };
  for (const id of allTaskIds(ws)) {
    if (named.size === list.length) break;
    if (id === closing) continue;
    const { dir } = taskPaths(ws, id);
    if (!existsSync(join(dir, 'done.json'))) walk(id, dir, dir);
  }
  return named;
}

// Whether the text holds the path (absolute, from ~ or from $HOME) as a whole name: the next character is not one a
// folder's name goes on with, so ~/sources/app never matches ~/sources/app-capture. On macOS in any case, as the
// volume reads it.
function names(text, path) {
  const fold = process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
  const body = fold(text);
  const t = tilde(path);
  const forms = (t === path ? [path] : [path, t, '$HOME' + t.slice(1)]).map(fold);
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

// What the plugins add: their repos, their offers ({ path → { remove, why } }; a keep from any plugin wins) and the
// names of build output. A plugin that fails adds nothing and is named in `problems`.
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
    offers: async (scanned) => {
      const offers = new Map();
      for (const impl of impls) {
        let list = [];
        try {
          list = (await impl.candidates({ ws, repos: scanned })) || [];
        } catch (e) {
          problems.push(`a worktrees plugin failed: ${e.message}`);
        }
        for (const c of list) {
          const p = real(c.path);
          if (offers.get(p)?.remove === false) continue;
          offers.set(p, { remove: c.remove === true, why: c.why || (c.remove ? 'a plugin offers it' : 'a plugin keeps it') });
        }
      }
      return offers;
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

// worktrees({ ws, closing, remove, sizes }) → { removed: [w], kept: [w], problems: [string] }, w being
// { path, repo, branch, why, holds?, branchDeleted?, branchError? }. Without `remove` it only says what an acceptance
// would remove now (`removed` then reads "would remove"); `closing` is the task being accepted, which no longer counts
// as open; `sizes` adds `holds`, the folders it holds besides build output; `processes` is lsof's look, for tests.
// Deepest first, so a worktree inside another goes before it.
export async function worktrees({ ws, closing = null, remove = false, sizes = false, processes = processPaths }) {
  const problems = [];
  const removed = [];
  const kept = [];
  try {
    const plugins = await fromPlugins(ws, problems);
    const roots = reposOf([...ws.repos.map((r) => r.root), ...plugins.repos], problems);
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
    const offers = await plugins.offers(roots);
    const lines = new Map();
    const keep = (w, why) => kept.push({ path: w.real, repo: w.repo, branch: w.branch ?? null, why });
    const candidates = [];
    for (const w of all) {
      if (w.main || w.bare) continue;
      const offer = offers.get(w.real);
      if (w.prunable) keep(w, `its folder is gone (${w.prunable}): git worktree prune forgets it`);
      else if (w.locked) keep(w, `locked: ${w.locked}`);
      else if (offer && !offer.remove) keep(w, offer.why);
      else if (w.detached || !w.branch) {
        if (offer) candidates.push({ w, why: offer.why });
        else keep(w, 'detached (no branch), and no plugin offers it');
      } else {
        if (!lines.has(w.repo)) lines.set(w.repo, mainLine(w.repo));
        const main = lines.get(w.repo);
        if (!main) keep(w, `${tilde(w.repo)} has no main line (origin's HEAD branch, main or master)`);
        else if (w.branch === main) keep(w, `it is ${main}, the main line`);
        else {
          const n = commitsLeft(w.repo, w.branch, main);
          if (typeof n === 'object') keep(w, `cannot tell whether ${w.branch} is merged: ${n.error}`);
          else if (n > 0) keep(w, `${w.branch} has ${n} commit${n > 1 ? 's' : ''} not in ${main}`);
          else candidates.push({ w, why: `${w.branch} merged into ${main}` });
        }
      }
    }
    if (!candidates.length) return { removed, kept: kept.sort((a, b) => a.path.localeCompare(b.path)), problems };
    const named = namedByOpenTasks(ws, closing, candidates.map((c) => c.w));
    const fold = process.platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
    const canon = new Map();
    const canonical = (p) => (canon.has(p) ? canon.get(p) : canon.set(p, fold(real(p))).get(p));
    let running; // lsof's look, once a candidate gets that far
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
      if (running === undefined) running = processes()?.map((p) => ({ ...p, path: canonical(p.path) })) ?? null;
      if (!running) return 'lsof cannot tell whether a process works in it or runs from it';
      const p = running.find((p) => inside(p.path, fold(w.real)));
      if (p) return `${p.command || 'a process'} (pid ${p.pid}) ${p.kind === 'cwd' ? 'works in it' : 'runs from it'}`;
      const within = checkoutsInside(w.real, prune);
      if (!within) return `too many folders to look through for checkouts (over ${MAX_FOLDERS})`;
      const left = within.filter((c) => !gone.has(real(c)));
      return left.length ? `it holds the checkout ${tilde(left[0])}` : null;
    };
    const depth = (p) => p.split(sep).length;
    candidates.sort((a, b) => depth(b.w.real) - depth(a.w.real) || a.w.real.localeCompare(b.w.real));
    for (const c of candidates) {
      const { w } = c;
      const status = git(w.real, ['status', '--porcelain', '-z']);
      const codes = status.status === 0 ? changesOf(status.stdout) : null;
      const force = codes !== null && cutShort(codes);
      const n = codes?.length;
      const reason = codes === null ? `git status failed: ${firstLine(status)}` : n && !force ? `${n} uncommitted change${n > 1 ? 's' : ''}` : stays(w);
      if (reason) {
        keep(w, reason);
        continue;
      }
      const why = force ? `${c.why}; its only changes are ${n} deleted tracked file${n > 1 ? 's' : ''}, as a removal cut short leaves, so it goes with --force` : c.why;
      if (!remove) {
        gone.add(w.real);
        removed.push({ path: w.real, repo: w.repo, branch: w.branch ?? null, why, ...(sizes ? { holds: holdsLine(ignoredFolders(w.real, plugins.buildNames)) } : {}) });
      } else {
        // Without --force but for a removal cut short: git refuses a worktree with changes or untracked files that
        // appeared since the look. No time limit: a removal stopped halfway is worse than a slow one.
        const r = git(w.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), w.real], 0);
        if (r.status !== 0) {
          keep(w, `git worktree remove failed: ${firstLine(r)}`);
          continue;
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

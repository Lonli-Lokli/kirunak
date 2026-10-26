import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { allTaskIds, taskPaths } from './workspace.mjs';

// The worktrees an acceptance removes (approval.md §5). Found by looking, never from a record: every worktree of the
// workspace's repos and of the repos a `worktrees` plugin adds, whose branch is merged into its repo's main line, with
// no changes, named by no open task, with no process working in it and no other checkout inside it. A detached one
// goes only when a plugin offers it. Nothing here throws once the acceptance is recorded: what cannot be told or
// fails is kept, with why.

const run = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const git = (cwd, args) => run(cwd, 'git', args);
const firstLine = (r) => (r.error?.message || r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;
const real = (p) => {
  try {
    return realpathSync(p);
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

// The folder each process works in ([{ pid, command, cwd }]), from lsof; null when lsof cannot tell.
export function processCwds() {
  const r = spawnSync('lsof', ['-w', '-d', 'cwd', '-F', 'pcn'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || !r.stdout) return null;
  const list = [];
  let p = {};
  for (const line of r.stdout.split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') p = { pid: Number(value) };
    else if (line[0] === 'c') p.command = value;
    else if (line[0] === 'n') list.push({ ...p, cwd: value });
  }
  return list;
}

// The text of every file of each open task (one with no done.json) but the closing one: what names a worktree.
function openTaskTexts(ws, closing) {
  const out = [];
  for (const id of allTaskIds(ws)) {
    if (id === closing) continue;
    const { dir } = taskPaths(ws, id);
    if (existsSync(join(dir, 'done.json'))) continue;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.isFile() && lstatSync(f).size <= 4 << 20) out.push({ id, file: relative(dir, f), text: readFileSync(f, 'utf8') });
      }
    };
    walk(dir);
  }
  return out;
}

// Whether the text holds the path (absolute, from ~ or from $HOME) as a whole name: the next character is not one a
// folder's name goes on with, so ~/sources/app never matches ~/sources/app-capture.
function names(text, path) {
  const t = tilde(path);
  const forms = t === path ? [path] : [path, t, '$HOME' + t.slice(1)];
  for (const f of forms) {
    for (let i = text.indexOf(f); i !== -1; i = text.indexOf(f, i + 1)) {
      if (!/[A-Za-z0-9_-]/.test(text[i + f.length] ?? '')) return true;
    }
  }
  return false;
}

// The folders below `path` (four levels down, past build output) that hold a .git of their own: another repo or
// worktree, which `git worktree remove` would delete with it.
function checkoutsInside(path, prune) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== path && entries.some((e) => e.name === '.git')) return void found.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && depth < 4 && e.name !== '.git' && !prune.has(e.name)) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(path, 0);
  return found;
}

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
    sizes.set(folder, (sizes.get(folder) || 0) + Math.ceil((lstatSync(join(path, rel)).blocks * 512) / 1024));
  }
  if (dirs.length) {
    const du = run(path, 'du', ['-sk', ...dirs]);
    for (const line of du.stdout.split('\n')) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      const folder = m[2].endsWith('/') ? m[2] : m[2] + '/';
      sizes.set(folder, (sizes.get(folder) || 0) + Number(m[1]));
    }
  }
  return [...sizes].map(([folder, kb]) => ({ folder, kb })).sort((a, b) => b.kb - a.kb || a.folder.localeCompare(b.folder));
}

export const human = (kb) =>
  kb < 1024 ? `${kb}K` : kb < 1024 ** 2 ? `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)}M` : `${(kb / 1024 ** 2).toFixed(kb < 10 * 1024 ** 2 ? 1 : 0)}G`;

// One short line of what a worktree holds besides build output: the five largest folders, then how many more.
export function holdsLine(folders) {
  if (folders === null) return 'git cannot list what it ignores';
  if (!folders.length) return 'nothing besides build output';
  const shown = folders.slice(0, 5).map((f) => `${f.folder} ${human(f.kb)}`);
  const rest = folders.slice(5);
  if (rest.length) shown.push(`and ${rest.length} more, ${human(rest.reduce((n, f) => n + f.kb, 0))}`);
  return shown.join(', ');
}

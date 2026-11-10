import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { kirunakHome } from './home.mjs';
import { samePath } from './os.mjs';

// The lock a session holds on the worktree it works in (approval.md §4): `git worktree lock` with the reason
// `kirunak <session> <until>`, `<until>` the lease's end as an ISO time. The freeze hook takes it on every call let
// through (holdFor), the SessionEnd hook gives it back (releaseAll), and the acceptance's removal lifts a lease that has
// ended (lib/worktrees.mjs). Only node: modules and two small libs, since holdFor runs on every tool call: it reads the
// worktree's `.git` file and its `locked` file itself, and spawns git only to lock, renew or unlock.

export const LEASE_MS = 2 * 3600_000;
export const RENEW_MS = 3600_000;
const GIT_MS = 3000;
const SESSION = /^[A-Za-z0-9_-]+$/;
const REASON = /^kirunak ([A-Za-z0-9_-]+) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/;

const runGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_MS });
const firstLine = (r) => (r.error?.message || r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;

export const reasonOf = (session, until) => `kirunak ${session} ${until.toISOString()}`;

// { session, until: Date, text } from a reason kirunak wrote, else null (a hand-made lock, another tool's).
export function leaseOf(reason) {
  const m = REASON.exec(String(reason ?? '').trim());
  if (!m) return null;
  const until = new Date(m[2]);
  return Number.isNaN(until.getTime()) ? null : { session: m[1], until, text: m[2] };
}

// The workspace's repos as k install last wrote them into the escalation hook's config.json: [root], or null.
export function rootsFrom(home = kirunakHome()) {
  try {
    const repos = JSON.parse(readFileSync(join(home, 'escalate', 'config.json'), 'utf8'))?.repos;
    const roots = Object.values(repos ?? {}).filter((r) => typeof r === 'string' && r);
    return roots.length ? roots : null;
  } catch {
    return null;
  }
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

// The linked worktree `path` is in: { path, gitdir, common }, or null when the first checkout above it is a main one
// (a `.git` folder), a submodule's, or there is none. Read from the `.git` file, never through git.
export function worktreeOf(path) {
  for (let d = resolve(path); ; d = dirname(d)) {
    let text = null;
    try {
      text = readFileSync(join(d, '.git'), 'utf8');
    } catch (e) {
      if (e.code === 'EISDIR') return null;
    }
    if (text !== null) {
      const m = /^gitdir: (.+?)\s*$/m.exec(text);
      if (!m) return null;
      const gitdir = resolve(d, m[1]);
      if (!/[\\/]worktrees[\\/][^\\/]+$/.test(gitdir)) return null;
      return { path: d, gitdir, common: dirname(dirname(gitdir)) };
    }
    if (dirname(d) === d) return null;
  }
}

// Whether the worktree belongs to one of the roots' repos: its common git dir is a root's `.git` folder.
const ofRoots = (w, roots, platform) => {
  const common = real(w.common);
  return roots.some((r) => samePath(common, real(join(r, '.git')), platform));
};

// holdFor({ session, paths, now, roots }) → [{ path, did }], did being 'locked', 'renewed', 'held' (this session's,
// over an hour left), 'theirs' (another reason) or 'failed: <git's line>'. For each path, the linked worktree of the
// workspace's repos it is in: no lock, locked for two hours; this session's with under an hour left, unlocked and
// locked again; any other lock, left. Never throws: a call it cannot tell about is left as it is.
export function holdFor({ session, paths, now = new Date(), roots = rootsFrom(), platform = process.platform, git = runGit }) {
  const out = [];
  if (!SESSION.test(session ?? '') || !roots?.length) return out;
  const seen = new Set();
  for (const p of paths ?? []) {
    try {
      if (typeof p !== 'string' || !p) continue;
      const w = worktreeOf(p);
      if (!w || seen.has(w.gitdir)) continue;
      seen.add(w.gitdir);
      if (!ofRoots(w, roots, platform)) continue;
      let reason = null;
      try {
        reason = readFileSync(join(w.gitdir, 'locked'), 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') continue;
      }
      const lease = reason === null ? null : leaseOf(reason);
      if (reason !== null && lease?.session !== session) {
        out.push({ path: w.path, did: 'theirs' });
        continue;
      }
      if (lease && lease.until - now >= RENEW_MS) {
        out.push({ path: w.path, did: 'held' });
        continue;
      }
      if (lease) {
        const u = git(w.path, ['worktree', 'unlock', w.path]);
        if (u.status !== 0) {
          out.push({ path: w.path, did: `failed: ${firstLine(u)}` });
          continue;
        }
      }
      const r = git(w.path, ['worktree', 'lock', '--reason', reasonOf(session, new Date(now.getTime() + LEASE_MS)), w.path]);
      out.push({ path: w.path, did: r.status === 0 ? (lease ? 'renewed' : 'locked') : `failed: ${firstLine(r)}` });
    } catch {
      // fails open: the tool call goes on, nothing more locked
    }
  }
  return out;
}

// releaseAll({ session, roots }) → { unlocked: [path], problems: [string] }: every worktree of the roots' repos whose
// lock reason names this session is unlocked, whatever its lease. Never throws.
export async function releaseAll({ session, roots = rootsFrom(), git = runGit }) {
  const unlocked = [];
  const problems = [];
  if (!SESSION.test(session ?? '') || !roots?.length) return { unlocked, problems };
  const { worktreesOf } = await import('./worktrees.mjs');
  for (const root of roots) {
    try {
      for (const w of worktreesOf(root)) {
        if (w.main || !w.locked || leaseOf(w.locked)?.session !== session) continue;
        const r = git(root, ['worktree', 'unlock', w.path]);
        if (r.status === 0) unlocked.push(w.path);
        else problems.push(`${w.path}: git worktree unlock failed: ${firstLine(r)}`);
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { unlocked, problems };
}

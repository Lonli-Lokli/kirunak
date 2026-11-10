import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { kirunakHome } from './home.mjs';
import { samePath } from './os.mjs';

// The lock the sessions working in a worktree hold on it (approval.md §4): git keeps one `git worktree lock` per
// worktree, so its reason is `kirunak <session> <until> [<session> <until>]...`, one pair per session, `<until>` the
// end of that session's lease as an ISO time. The freeze hook adds this session on every call let through
// (holdFor), the SessionEnd hook takes it out (releaseAll), and the acceptance's removal takes out the leases that
// have ended (lib/worktrees.mjs). Only node: modules and two small libs, since holdFor runs on every tool call: it reads the
// worktree's `.git` file and its `locked` file itself, and spawns git only to lock, renew or unlock.

export const LEASE_MS = 2 * 3600_000;
export const RENEW_MS = 3600_000;
const GIT_MS = 3000;
const SESSION = /^[A-Za-z0-9_-]+$/;
const UNTIL = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

const runGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_MS });
const firstLine = (r) => (r.error?.message || r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;

// The reason for leases [{ session, until: Date }], in their order.
export const reasonOf = (leases) => `kirunak ${leases.map((l) => `${l.session} ${l.until.toISOString()}`).join(' ')}`;

// [{ session, until: Date, text }] from a reason kirunak wrote, one pair or more, else null (a hand-made lock, another
// tool's).
export function leasesOf(reason) {
  const [head, ...rest] = String(reason ?? '').trim().split(/\s+/);
  if (head !== 'kirunak' || !rest.length || rest.length % 2) return null;
  const out = [];
  for (let i = 0; i < rest.length; i += 2) {
    const [session, text] = [rest[i], rest[i + 1]];
    const until = new Date(text);
    if (!SESSION.test(session) || !UNTIL.test(text) || Number.isNaN(until.getTime())) return null;
    out.push({ session, until, text });
  }
  return out;
}

// The worktree at `path`, unlocked, locked with `leases`. → null, or what failed.
function lockWith(cwd, path, leases, git) {
  const r = git(cwd, ['worktree', 'lock', '--reason', reasonOf(leases), path]);
  return r.status === 0 ? null : `git worktree lock failed: ${firstLine(r)}`;
}

// The lock on the worktree at `path` rewritten to hold `leases`: unlocked, then locked again with them, or left
// unlocked when none is left. → null, or what failed.
export function relock(cwd, path, leases, git = runGit) {
  const u = git(cwd, ['worktree', 'unlock', path]);
  if (u.status !== 0) return `git worktree unlock failed: ${firstLine(u)}`;
  return leases.length ? lockWith(cwd, path, leases, git) : null;
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

// holdFor({ session, paths, now, roots }) → [{ path, did }], did being 'locked' (no lock was there), 'joined' (a lock
// of kirunak's without this session), 'renewed' (this session's lease, under an hour left), 'held' (this session's
// lease, over an hour left), 'theirs' (a lock kirunak did not write) or 'failed: <git's line>'. For each path, the
// linked worktree of the workspace's repos it is in: no lock, locked for this session for two hours; a lock of
// kirunak's without this session or with under an hour of its lease left, rewritten (unlock, lock) with this session's
// new lease and without every lease that has ended; any other lock, left. Never throws: a call it cannot tell about is
// left as it is.
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
      const leases = reason === null ? [] : leasesOf(reason);
      if (!leases) {
        out.push({ path: w.path, did: 'theirs' });
        continue;
      }
      const mine = leases.filter((l) => l.session === session);
      if (mine.some((l) => l.until - now >= RENEW_MS)) {
        out.push({ path: w.path, did: 'held' });
        continue;
      }
      const next = [...leases.filter((l) => l.session !== session && l.until > now), { session, until: new Date(now.getTime() + LEASE_MS) }];
      const failed = reason === null ? lockWith(w.path, w.path, next, git) : relock(w.path, w.path, next, git);
      out.push({ path: w.path, did: failed ? `failed: ${failed}` : reason === null ? 'locked' : mine.length ? 'renewed' : 'joined' });
    } catch {
      // fails open: the tool call goes on, nothing more locked
    }
  }
  return out;
}

// releaseAll({ session, roots }) → { unlocked: [path], rewritten: [path], problems: [string] }: this session taken out
// of every lock of kirunak's on a worktree of the roots' repos, whatever its lease: the lock rewritten with the other
// sessions' pairs as they were, or unlocked when none is left. Never throws.
export async function releaseAll({ session, roots = rootsFrom(), git = runGit }) {
  const unlocked = [];
  const rewritten = [];
  const problems = [];
  if (!SESSION.test(session ?? '') || !roots?.length) return { unlocked, rewritten, problems };
  const { worktreesOf } = await import('./worktrees.mjs');
  for (const root of roots) {
    try {
      for (const w of worktreesOf(root)) {
        const leases = w.main || !w.locked ? null : leasesOf(w.locked);
        if (!leases?.some((l) => l.session === session)) continue;
        const others = leases.filter((l) => l.session !== session);
        const failed = relock(root, w.path, others, git);
        if (failed) problems.push(`${w.path}: ${failed}`);
        else (others.length ? rewritten : unlocked).push(w.path);
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { unlocked, rewritten, problems };
}

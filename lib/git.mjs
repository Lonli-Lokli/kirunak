import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuse } from './errors.mjs';

// Every git call kirunak makes goes through here, with the repo root as cwd.
export function git(root, args, { env, input, encoding = 'utf8' } = {}) {
  return execFileSync('git', args, {
    cwd: root,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// `git show :path` (the index) or `git show HEAD:path`; null when the path is not there.
export function show(root, spec) {
  try {
    return git(root, ['show', spec], { encoding: 'buffer' });
  } catch {
    return null;
  }
}

// Stages exactly `paths` (added, changed or removed) and commits only them.
export function commit(root, paths, message, env) {
  try {
    git(root, ['add', '-A', '--', ...paths], { env });
    git(root, ['commit', '-q', '-m', message, '--', ...paths], { env });
  } catch (e) {
    throw refuse(`git commit in ${root} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  return head(root);
}

// What an owner's command writes and commits: `write()` writes the files at `paths` (relative to the root), then
// `commit` commits exactly them. When either fails, every path is put back as it was before, on disk and in the
// index, and the same error is thrown, so a refused command leaves nothing behind for the next try to trip on (bug
// gulnya/accept-refused-by-slap).
export function writeAndCommit(root, paths, write, message, env) {
  const disk = paths.map((rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null));
  const index = git(root, ['ls-files', '-s', '-z', '--', ...paths]);
  try {
    write();
    return commit(root, paths, message, env);
  } catch (e) {
    paths.forEach((rel, i) => (disk[i] == null ? rmSync(join(root, rel), { force: true }) : writeFileSync(join(root, rel), disk[i])));
    try {
      git(root, ['update-index', '--force-remove', '--', ...paths]);
      if (index) git(root, ['update-index', '-z', '--index-info'], { input: index });
    } catch {
      // The files are back; an index git would not take back is left for `git status` to show.
    }
    throw e;
  }
}

// Whether git exits 0 for `args` in the repo at `root`.
export function succeeds(root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

export const isBranch = (root, name) => succeeds(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
export const isAncestor = (root, a, b) => succeeds(root, ['merge-base', '--is-ancestor', a, b]);

export function head(root) {
  return git(root, ['rev-parse', '--short', 'HEAD']).trim();
}

export function log1(root, path) {
  try {
    return git(root, ['log', '-1', '--format=%h', '--', path]).trim();
  } catch {
    return '';
  }
}

// True when `path` is tracked and has no change in the index or the working tree.
export function isCommitted(root, path) {
  try {
    git(root, ['ls-files', '--error-unmatch', '--', path]);
  } catch {
    return false;
  }
  return git(root, ['status', '--porcelain', '--', path]).trim() === '';
}

export function toplevel(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
}

// The patch from base to headSha, leaving out the paths in `exclude` (relative to the root).
export function diff(root, base, headSha, exclude = []) {
  const spec = exclude.length ? ['--', '.', ...exclude.map((x) => `:(exclude)${x}`)] : [];
  return git(root, ['diff', base, headSha, ...spec]);
}

// The files under `path` that are new or changed against HEAD and still on disk: untracked ones git does not ignore,
// and staged or unstaged changes. Deletions are left out. Paths are relative to the root, as `commit` takes them.
export function changedUnder(root, path) {
  const z = (args) => git(root, args).split('\0').filter(Boolean);
  const changed = z(['diff', '-z', '--name-only', '--relative', '--no-renames', '--diff-filter=d', 'HEAD', '--', path]);
  const untracked = z(['ls-files', '-z', '--others', '--exclude-standard', '--', path]);
  return [...new Set([...changed, ...untracked])].sort();
}

// The files that differ between sha and HEAD, leaving out the paths in `exclude` (relative to the root), as `diff`.
export function changedSince(root, sha, exclude = []) {
  const spec = exclude.length ? ['--', '.', ...exclude.map((x) => `:(exclude)${x}`)] : [];
  return git(root, ['diff', '--name-only', sha, 'HEAD', ...spec]).split('\n').filter(Boolean);
}

// The commits of `range` (a range, or git log's arguments as a list) as `git log` lists them, newest first:
// { sha, parents, message, paths }, sha and parents short, paths each commit's own (a rename as a delete and an add),
// relative to the root. A merge's are, by --cc, the paths whose result differs from every parent: its own code, a
// conflict it resolved, a file both sides changed (gulnya/accept-merge-gaps); none for a clean merge of sides that
// changed different files. One git call for the range.
export function commitsIn(root, range) {
  const out = git(root, ['log', '-z', '--no-renames', '--name-only', '--cc', '--format=%x01%h%x02%p%x02%B%x02', ...[].concat(range)]);
  return out.split('\x01').filter(Boolean).map((chunk) => {
    const [sha, parents, message, rest = ''] = chunk.split('\x02');
    return { sha, parents: parents.split(' ').filter(Boolean), message, paths: rest.split('\0').map((x) => x.replace(/^\n/, '')).filter(Boolean) };
  });
}

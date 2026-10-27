import { execFileSync } from 'node:child_process';
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
// { sha, parents, message, paths }, sha and parents short, paths each commit's own (a rename as a delete and an add; a
// merge has none), relative to the root. One git call for the range.
export function commitsIn(root, range) {
  const out = git(root, ['log', '-z', '--no-renames', '--name-only', '--format=%x01%h%x02%p%x02%B%x02', ...[].concat(range)]);
  return out.split('\x01').filter(Boolean).map((chunk) => {
    const [sha, parents, message, rest = ''] = chunk.split('\x02');
    return { sha, parents: parents.split(' ').filter(Boolean), message, paths: rest.split('\0').map((x) => x.replace(/^\n/, '')).filter(Boolean) };
  });
}

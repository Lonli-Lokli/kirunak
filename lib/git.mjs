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

export function changedSince(root, sha) {
  return git(root, ['diff', '--name-only', sha, 'HEAD']).split('\n').filter(Boolean);
}

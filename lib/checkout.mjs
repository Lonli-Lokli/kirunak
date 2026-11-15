import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { git } from './git.mjs';

// The checkout a [heavy] step's command runs in, and its fingerprint (gulnya/heavy-retry-unchanged D-1, E-1): the
// folder of the command's first `cd <dir>` (`~` and `$HOME` expanded, quotes taken off, relative to `root`, the job's
// cwd), when that folder is in a git work tree; its fingerprint `{ dir, head, status }` is `git rev-parse HEAD` there
// and the sha256 of `git status --porcelain` there. No `cd`, a folder outside a work tree, or a git command that fails
// gives null: that step keeps the retry it always had.

// `cd` at the command's start or after `;`, `&`, `|`, `(` or a line break, then its folder: quoted, or up to the
// next blank or shell operator.
const CD = /(?:^|[;&|(\n])\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/;

// → the folder, absolute, or null when the command has no `cd <dir>`.
export function checkoutDir(command, root) {
  const m = CD.exec(String(command ?? ''));
  if (!m) return null;
  const quoted = m[1] ?? m[2];
  let dir = quoted ?? m[3];
  if (!dir || dir === '-') return null;
  // A quoted `~` stays a `~` in sh; `$HOME` expands inside double quotes and bare, never inside single ones.
  if (quoted === undefined && (dir === '~' || dir.startsWith('~/'))) dir = homedir() + dir.slice(1);
  if (m[2] === undefined) dir = dir.replace(/^\$(?:HOME\b|\{HOME\})/, homedir());
  return resolve(root, dir);
}

// → { dir, head, status } or null (see above).
export function fingerprint(command, root) {
  const dir = checkoutDir(command, root);
  if (!dir) return null;
  try {
    if (git(dir, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const status = createHash('sha256').update(git(dir, ['status', '--porcelain'])).digest('hex');
    return { dir, head, status };
  } catch {
    return null;
  }
}

// Whether two fingerprints name the same folder at the same head with the same status; none is never the same.
export const sameCheckout = (a, b) => !!a && !!b && a.dir === b.dir && a.head === b.head && a.status === b.status;

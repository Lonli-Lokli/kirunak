import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { git } from './git.mjs';

// The checkout a [heavy] step's command runs in, and its fingerprint (gulnya/heavy-retry-unchanged D-1, E-1): the
// folder of the command's first `cd <dir>` (`~` and `$HOME` expanded, quotes taken off, relative to `root`, the job's
// cwd), when that folder is in a git work tree; its fingerprint `{ dir, head, status }` is `git rev-parse HEAD` there
// and the sha256 of `git status --porcelain`, `git diff HEAD` and each untracked file's contents there (A-1: the
// status alone names files, not their contents, so a further edit to a modified file would read as unchanged), read
// from the work tree's top folder with kirunak's records left out. No `cd`, a folder outside a work tree, or a git
// command that fails gives null: that step keeps the retry it always had.

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

// kirunak's own records in a workspace repo, by the repo's top folder: a task's progress, plan and failure reports,
// a bug's, a draft, an approval. k run and other sessions write them between two jobs, which is no change to the code.
export const RECORDS = ['kirunak/tasks', 'kirunak/bugs', 'kirunak/drafts', 'kirunak/approvals'];

// → { dir, head, status } or null (see above). The whole work tree is read from its top folder, where git
// hash-object finds the paths ls-files gives, with RECORDS and `taskDir`, the task's own folder wherever it is, left
// out (each a literal pathspec, so a `*` or `[` in a path is no pattern).
export function fingerprint(command, root, taskDir = null) {
  const dir = checkoutDir(command, root);
  if (!dir) return null;
  try {
    if (git(dir, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return null;
    const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
    const head = git(top, ['rev-parse', 'HEAD']).trim();
    const left = [...RECORDS, ...(taskDir && existsSync(taskDir) ? [relative(realpathSync(top), realpathSync(taskDir))] : [])];
    const out = left.filter((f) => f && !f.startsWith('..') && !isAbsolute(f));
    const spec = out.length ? ['--', '.', ...out.map((f) => `:(exclude,literal)${f}`)] : [];
    const hash = createHash('sha256').update(git(top, ['status', '--porcelain', ...spec])).update('\0').update(git(top, ['diff', 'HEAD', '--binary', ...spec], { encoding: 'buffer' }));
    // Each untracked file (ignored ones aside) by git's own hash of its contents, beside its name.
    const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]).split('\0').filter(Boolean);
    if (untracked.length) hash.update('\0').update(git(top, ['hash-object', '--stdin-paths'], { input: untracked.join('\n') + '\n' }));
    const status = hash.digest('hex');
    return { dir, head, status };
  } catch {
    return null;
  }
}

// Whether two fingerprints name the same folder at the same head with the same status; none is never the same.
export const sameCheckout = (a, b) => !!a && !!b && a.dir === b.dir && a.head === b.head && a.status === b.status;

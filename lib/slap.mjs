import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { kirunakHome } from './home.mjs';
import { compile, ignored } from './ignore.mjs';

// SLAP, the size of a change (R21, R22, R23, design/change-size.md): √L × √F_adj over what the repo's `.slapignore`
// does not list. Imports only node: modules, home.mjs and ignore.mjs, because the git hook runs it on every commit.

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MOST = 35;
export const XL = 71;

export function score(L, F) {
  if (!L || !F) return 0;
  const perFile = L / F;
  const fAdj = F * Math.min(1, perFile / 5) + Math.log(1 + Math.max(0, perFile - 50));
  return Math.round(Math.sqrt(L) * Math.sqrt(fAdj));
}

export function tier(s) {
  if (s <= 10) return 'S';
  if (s <= MOST) return 'M';
  if (s < XL) return 'L';
  return 'XL';
}

// The most lines F files can change and stay at most M (the score grows with L).
export function limit(F) {
  let lo = 0;
  let hi = 1 << 20;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (score(mid, F) <= MOST) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// `git diff --raw --numstat --no-abbrev -z` output → [{ added, deleted, path, binary, status, moved }]. git prints
// every raw entry, then every numstat entry, in the same order. With -z a rename is "a\td\t\0old\0new\0" in numstat
// and ":modes shas R<n>\0old\0new\0" in raw; `moved` is a rename that kept the content.
export function parseDiff(out) {
  const parts = out.split('\0');
  const raw = [];
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      const [, , src, dst, status] = parts[i].slice(1).split(' ');
      raw.push({ status: status[0], moved: /^[RC]/.test(status) && src === dst });
      i += /^[RC]/.test(status) ? 2 : 1;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      path = parts[i + 2];
      i += 2;
    }
    const binary = m[1] === '-';
    files.push({ added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), path, binary });
  }
  return files.map((f, n) => ({ ...f, status: raw[n]?.status ?? 'M', moved: raw[n]?.moved ?? false }));
}

// { score, tier, L, F, counted: [path], skipped: [{ path, why }], binaries: [path] } for the diff's files and the
// `.slapignore` patterns. A file deleted whole is left out; a binary file not listed is one of `binaries`.
export function measure(files, patterns = []) {
  const counted = [];
  const skipped = [];
  const binaries = [];
  let L = 0;
  for (const f of files) {
    let why = null;
    if (f.status === 'D') why = 'deleted';
    else if (ignored(patterns, f.path)) why = 'in .slapignore';
    else if (f.binary) {
      why = f.moved ? 'moved' : 'binary';
      if (!f.moved) binaries.push(f.path);
    }
    if (why) skipped.push({ path: f.path, why });
    else if (f.added + f.deleted > 0) {
      counted.push(f.path);
      L += f.added + f.deleted;
    }
  }
  const s = score(L, counted.length);
  return { score: s, tier: tier(s), L, F: counted.length, counted, skipped, binaries };
}

const git = (root, args, encoding = 'utf8') =>
  execFileSync('git', args, { cwd: root, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

// A `.slapignore` in the index (rev null) or in a commit: its bytes, or null when there is none.
export function slapignoreAt(root, rev = null) {
  try {
    return git(root, ['show', `${rev ?? ''}:.slapignore`], 'buffer');
  } catch {
    return null;
  }
}

// Measures `git diff <args>` in a repo, the staged change (`['--cached', base]`) or a commit (`[parent, sha]`), with
// the `.slapignore` bytes that apply to it.
export function measureDiff(root, diffArgs, slapignore = null) {
  const out = git(root, ['diff', '--raw', '--numstat', '--no-abbrev', '--no-relative', '-z', '-M', ...diffArgs]);
  return measure(parseDiff(out), compile(slapignore ? slapignore.toString('utf8') : ''));
}

export function parentOf(root, rev) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', `${rev}^`]).trim();
  } catch {
    return EMPTY_TREE;
  }
}

export const line = (m) => `SLAP: ${m.score} (${m.tier})`;

// ---- The owner's approval of a `.slapignore` (R23) ----

export const hashBytes = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');
export const recordFile = (home = kirunakHome()) => join(home, 'slapignore.json');

// Every repo's record, by the repo's main folder: { hash, approved, by, via, history } (hash null: installed, never
// approved).
export function readRecords(home = kirunakHome()) {
  const file = recordFile(home);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).repos ?? {} : {};
}

// { gitDir, top, key }: key is the repo's main folder, the same from each of its worktrees.
export function repoInfo(cwd) {
  const [gitDir, common, top] = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
    .trim().split('\n');
  const c = realpathSync(common);
  return { gitDir, top, key: basename(c) === '.git' ? dirname(c) : c };
}

// ---- The gate (R22, R23): what the hook and `k slap --staged` refuse ----

// The pattern to name for a binary file: its extension, else the file itself.
export const patternFor = (path) => {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `*${name.slice(dot)}` : `/${path.replace(/([*?[\\])/g, '\\$1')}`;
};

const listed = (paths) => (paths.length > 5 ? `${paths.slice(0, 5).join(', ')}, ...` : paths.join(', '));

export function sizeRefusal(m) {
  const edges = [1, 5, 10, 20].map((f) => `${limit(f)} in ${f} file${f > 1 ? 's' : ''}`).join(', ');
  return `kirunak: this commit is ${m.tier}, SLAP ${m.score}: ${m.L} lines of code in ${m.F} files (${listed(m.counted)}). ` +
    `Commits are at most M (SLAP ${MOST}), with no override (R22): over ${m.F} files that is at most ` +
    `${limit(m.F)} lines (${edges}). Split it: stage fewer files (git restore --staged <file>) or part of a file ` +
    '(git add -p), and commit each part. `k slap --staged` measures what is staged.';
}

export function binaryRefusal(paths, key) {
  const patterns = [...new Set(paths.map(patternFor))];
  return `kirunak: ${paths.length > 1 ? 'binary files' : 'a binary file'} that .slapignore does not list: ${listed(paths)} ` +
    `(R22). Ask the owner to add ${patterns.map((p) => `\`${p}\``).join(', ')} to .slapignore and approve it ` +
    `(\`! k slapignore approve ${key}\`), or leave ${paths.length > 1 ? 'them' : 'it'} out of this commit ` +
    '(git restore --staged <file>).';
}

export function unapprovedRefusal(key, approved) {
  return `kirunak: ${approved ? "this .slapignore is not the one the owner approved" : 'no .slapignore is approved'} ` +
    `for ${key} (R23). Only the owner changes it: say which pattern to add or remove and why, and ask them to ` +
    `approve it (\`! k slapignore approve ${key}\`) or to put the approved one back.`;
}

// The gate on the staged change against `base`: { m, refusals: [reason], key }. A `.slapignore` in the index must be
// the approved one; with none, nothing is left out but whole deletions.
export function gate(root, base, home = kirunakHome(), info = repoInfo(root)) {
  const bytes = slapignoreAt(info.top);
  if (bytes) {
    const approved = readRecords(home)[info.key]?.hash ?? null;
    if (hashBytes(bytes) !== approved) return { m: null, refusals: [unapprovedRefusal(info.key, approved)], key: info.key };
  }
  const m = measureDiff(info.top, ['--cached', base], bytes);
  const refusals = [];
  if (m.binaries.length) refusals.push(binaryRefusal(m.binaries, info.key));
  if (m.score > MOST) refusals.push(sizeRefusal(m));
  return { m, refusals, key: info.key };
}

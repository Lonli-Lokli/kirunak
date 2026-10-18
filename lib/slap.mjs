import { execFileSync } from 'node:child_process';

// SLAP, the size of a change (R21, R22, design/change-size.md): √L × √F_adj over code only.

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const XL = 71;

export function score(L, F) {
  if (!L || !F) return 0;
  const perFile = L / F;
  const fAdj = F * Math.min(1, perFile / 5) + Math.log(1 + Math.max(0, perFile - 50));
  return Math.round(Math.sqrt(L) * Math.sqrt(fAdj));
}

export function tier(s) {
  if (s <= 10) return 'S';
  if (s <= 35) return 'M';
  if (s < XL) return 'L';
  return 'XL';
}

// What is not code (R21): lock files, build output, minified files and maps, prose and data.
const NOT_CODE = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Package\.resolved|gradle\.lockfile)$/,
  /\.lock$/,
  /(^|\/)(dist|build)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(md|mdx|markdown|txt|rst|adoc|tsv|csv)$/i,
];
const ATTRS = ['linguist-generated', 'linguist-vendored', 'linguist-documentation'];

export const isNotCode = (path) => NOT_CODE.some((re) => re.test(path));

// `git diff --numstat -z` output → [{ added, deleted, path, binary }]. With -z a rename is "a\td\t\0old\0new\0".
export function parseNumstat(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
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
  return files;
}

// `git check-attr -z` output → the set of paths with a generated, vendored or documentation attribute set.
export function parseAttrs(out) {
  const parts = out.split('\0');
  const marked = new Set();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === 'set' || parts[i + 2] === 'true') marked.add(parts[i]);
  }
  return marked;
}

// { score, tier, L, F, counted: [path], skipped: [{ path, why }] } for numstat rows and the marked paths.
export function measure(files, marked = new Set()) {
  const counted = [];
  const skipped = [];
  let L = 0;
  for (const f of files) {
    const why = f.binary ? 'binary' : isNotCode(f.path) ? 'not code' : marked.has(f.path) ? 'marked in .gitattributes' : null;
    if (why) skipped.push({ path: f.path, why });
    else if (f.added + f.deleted > 0) {
      counted.push(f.path);
      L += f.added + f.deleted;
    }
  }
  const s = score(L, counted.length);
  return { score: s, tier: tier(s), L, F: counted.length, counted, skipped };
}

const git = (root, args, input) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

// Measures `git diff <args>` in a repo: the staged change (`['--cached', base]`) or a commit (`[parent, sha]`).
export function measureDiff(root, diffArgs) {
  const files = parseNumstat(git(root, ['diff', '--numstat', '-z', '-M', ...diffArgs]));
  const paths = files.filter((f) => !f.binary && !isNotCode(f.path)).map((f) => f.path);
  const marked = paths.length ? parseAttrs(git(root, ['check-attr', '-z', '--stdin', ...ATTRS], paths.join('\0') + '\0')) : new Set();
  return measure(files, marked);
}

export function parentOf(root, rev) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', `${rev}^`]).trim();
  } catch {
    return EMPTY_TREE;
  }
}

export const line = (m) => `SLAP: ${m.score} (${m.tier})`;

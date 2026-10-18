import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isoLocal } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { expandHome, kirunakHome } from './home.mjs';
import { compile, ignored } from './ignore.mjs';
import { EMPTY_TREE, hashBytes, parseDiff, patternFor, readRecords, recordFile, repoInfo } from './slap.mjs';

// A repo's `.slapignore` (R21, R23, design/change-size.md §2, §4): the starter `k install --git` writes, the
// registry of repos with the hooks, and the owner's approval, all in $KIRUNAK_HOME/slapignore.json.

// What A-7's built-in list left out, as patterns. Nothing is left out unless a repo's `.slapignore` lists it.
export const STARTER = `# .slapignore: the files SLAP leaves out of a commit's size (kirunak R21). Patterns as in .gitignore, from
# this folder; a file deleted whole is always left out. Only the owner changes this file: they edit it and type
# \`k slapignore approve <repo>\` (R23).

# Lock files
*.lock
package-lock.json
npm-shrinkwrap.json
yarn.lock
pnpm-lock.yaml
Package.resolved
gradle.lockfile

# Build output
build/
dist/

# Minified files and source maps
*.min.js
*.min.css
*.map

# Prose
*.md
*.mdx
*.markdown
*.txt
*.rst
*.adoc

# Tables
*.tsv
*.csv
`;

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const LINGUIST = /^linguist-(generated|vendored|documentation)(=true)?$/;

// The patterns of the root `.gitattributes` with a generated, vendored or documentation mark set.
export function marked(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const [pattern, ...attrs] = l.split(/\s+/);
    if (attrs.some((a) => LINGUIST.test(a)) && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

// The starter for a repo: the list above, the case variants of its extensions the repo tracks (A-7 read those
// without regard to case), the binary types it tracks, and what its .gitattributes marks.
export function starter(top) {
  let head = null;
  try {
    head = git(top, ['rev-parse', '--verify', '-q', 'HEAD']).trim();
  } catch {}
  const files = head ? parseDiff(git(top, ['diff', '--raw', '--numstat', '--no-abbrev', '--no-relative', '-z', EMPTY_TREE, head])) : [];
  const base = compile(STARTER);
  const exts = new Set(STARTER.split('\n').filter((l) => /^\*\.\w+$/.test(l)).map((l) => l.slice(2)));
  const variants = new Set();
  const binaries = new Set();
  for (const f of files) {
    const dot = basename(f.path).lastIndexOf('.');
    const ext = dot > 0 ? basename(f.path).slice(dot + 1) : '';
    if (ext && exts.has(ext.toLowerCase()) && !exts.has(ext)) variants.add(`*.${ext}`);
    if (f.binary && !ignored(base, f.path)) binaries.add(patternFor(f.path));
  }
  const attrs = existsSync(join(top, '.gitattributes')) ? marked(readFileSync(join(top, '.gitattributes'), 'utf8')) : [];
  const section = (title, list) => (list.length ? `\n# ${title}\n${list.join('\n')}\n` : '');
  return STARTER +
    section('The same, in the other cases this repo uses', [...variants].sort()) +
    section('Binary types this repo tracks', [...binaries].sort()) +
    section('Marked generated, vendored or documentation in .gitattributes', attrs);
}

function writeRecords(home, repos) {
  mkdirSync(home, { recursive: true });
  writeFileSync(recordFile(home), JSON.stringify({ repos }, null, 2) + '\n');
}

// Adds a repo with the hooks to the registry, so `--all` finds it; true when it was not there.
export function register(home, repoPath) {
  const { key } = repoInfo(repoPath);
  const repos = readRecords(home);
  if (repos[key]) return false;
  repos[key] = { hash: null, history: [] };
  writeRecords(home, repos);
  return true;
}

// Each registered repo: approved, changed (approved before, differs now), unapproved, or none (no file).
export function status(home = kirunakHome()) {
  return Object.entries(readRecords(home)).map(([key, rec]) => {
    const file = join(key, '.slapignore');
    const hash = existsSync(file) ? hashBytes(readFileSync(file)) : null;
    const state = !hash ? 'none' : hash === rec.hash ? 'approved' : rec.hash ? 'changed' : 'unapproved';
    return { key, top: key, state, approved: rec.approved ?? null };
  });
}

// The repo an argument means: a folder in it, or the one registered repo of that name.
function resolveRepo(home, arg, cwd) {
  const path = resolve(cwd, expandHome(arg));
  if (existsSync(path)) {
    const info = repoInfo(path);
    return { key: info.key, top: info.top };
  }
  const named = Object.keys(readRecords(home)).filter((k) => basename(k) === arg);
  if (named.length === 1) return { key: named[0], top: named[0] };
  throw refuse(named.length > 1 ? `${arg} names ${named.length} repos (${named.join(', ')}): give its path`
    : `${arg} is neither a folder nor a registered repo (\`k slapignore status\` lists them)`);
}

// `k slapignore approve <repo>... | --all` (R23): records the hash of each repo's `.slapignore` as it is on disk.
// --all takes every registered repo whose file is unapproved or changed. Checked whole before anything is written.
export function approve({ home = kirunakHome(), repos = [], all = false, via = 'shell', cwd = process.cwd(), now = new Date(), dryRun = false }) {
  if (!all && !repos.length) throw usage('k slapignore approve <repo>... | --all');
  const targets = all
    ? status(home).filter((s) => s.state === 'unapproved' || s.state === 'changed')
    : repos.map((a) => resolveRepo(home, a, cwd));
  const records = readRecords(home);
  const rows = [];
  for (const { key, top } of targets) {
    const file = join(top, '.slapignore');
    if (!existsSync(file)) throw refuse(`${top} has no .slapignore to approve; nothing was recorded`);
    const bytes = readFileSync(file);
    const hash = hashBytes(bytes);
    const patterns = compile(bytes.toString('utf8')).length;
    const rec = records[key] ?? { hash: null, history: [] };
    if (rec.hash === hash) {
      rows.push({ key, hash, patterns, already: true });
      continue;
    }
    const approved = isoLocal(now);
    records[key] = { hash, approved, by: 'owner', via, history: [...(rec.history ?? []), { hash, approved }] };
    rows.push({ key, hash, patterns });
  }
  if (!dryRun && rows.some((r) => !r.already)) writeRecords(home, records);
  return rows;
}

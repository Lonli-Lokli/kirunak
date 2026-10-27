import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { refuse } from './errors.mjs';
import { isBranch, succeeds, toplevel } from './git.mjs';

// repos.md, the hand-written file in a task's folder that adds a repo kirunak did not find, with its branch or range,
// or a range in a repo it did (review.md §1; the task gulnya/kirunak-review-base, AC-9, E-6).

export const HAND = 'repos.md';

const expand = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path);

export const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// The repo a repos.md line names: a workspace repo by its name, or a path (`/…` or `~/…`) to a git repository's top, a
// workspace repo's root being that repo. → { name, root }, or null for a repo kirunak does not know (E-6).
function repoNamed(ws, word) {
  const named = ws.repos.find((r) => r.name === word);
  if (named) return named;
  if (!word.startsWith('/') && !word.startsWith('~/')) return null;
  const at = real(expand(word));
  if (!at) return null;
  const known = ws.repos.find((r) => real(r.root) === at);
  if (known) return known;
  const top = toplevel(at);
  return top && real(top) === at ? { name: basename(at), root: at } : null;
}

// repos.md's lines (AC-9, E-6): each line starting `- ` is `- <repo> <branch>` or `- <repo> <from>..<to>`, any other
// line prose. → [{ line, text, repo, branch } | { line, text, repo, range }]; a line naming a repo kirunak does not
// know, a branch or range git cannot read, or not those two words refuses, naming each such line.
export function handLines(ws, p) {
  const file = join(p.dir, HAND);
  if (!existsSync(file)) return [];
  const out = [];
  const bad = [];
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.startsWith('- ')) return;
    const text = raw.trim();
    const at = `line ${i + 1}, "${text}"`;
    const words = text.slice(2).trim().split(/\s+/);
    if (words.length !== 2) return bad.push(`${at}: a line is \`- <repo> <branch>\` or \`- <repo> <from>..<to>\``);
    const [word, what] = words;
    const repo = repoNamed(ws, word);
    if (!repo) return bad.push(`${at}: ${word} is neither a repo of the workspace nor a git repository`);
    if (what.includes('..')) {
      if (!succeeds(repo.root, ['rev-list', '--count', what, '--'])) return bad.push(`${at}: git cannot read the range ${what} in ${tilde(repo.root)}`);
      return out.push({ line: i + 1, text, repo, range: what });
    }
    if (!isBranch(repo.root, what)) return bad.push(`${at}: ${tilde(repo.root)} has no branch ${what}`);
    out.push({ line: i + 1, text, repo, branch: what });
  });
  if (bad.length) throw refuse(`${p.id}: ${p.rel(HAND)} names what kirunak cannot read, so the review cannot start:\n${bad.map((x) => `  ${x}`).join('\n')}`);
  return out;
}

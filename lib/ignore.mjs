// A repo's `.slapignore` (R21, design/change-size.md §2): gitignore patterns (gitignore(5)), read from the repo's
// root, matched case-sensitively against paths relative to it. Node only, so a hook can use it.

// One pattern line → { re, negated, dirOnly, source }, or null for a blank line or a comment.
function compileLine(raw) {
  let text = raw.replace(/\r$/, '');
  if (!text || text.startsWith('#')) return null;
  // Trailing spaces go unless escaped with a backslash.
  text = text.replace(/(?<!\\)\s+$/, '');
  if (!text) return null;
  let negated = false;
  if (text.startsWith('!')) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith('\\!') || text.startsWith('\\#')) {
    text = text.slice(1);
  }
  let dirOnly = false;
  if (text.endsWith('/') && !text.endsWith('\\/')) {
    dirOnly = true;
    text = text.slice(0, -1);
  }
  if (!text) return null;
  // A slash at the start or in the middle anchors the pattern at the root; otherwise it matches at any level.
  const anchored = text.includes('/');
  if (text.startsWith('/')) text = text.slice(1);
  const body = globToRegex(text);
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`);
  return { re, negated, dirOnly, source: raw };
}

const SPECIAL = /[.+^${}()|\\]/;

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const before = i === 0 || glob[i - 1] === '/';
      let j = i;
      while (glob[j] === '*') j++;
      const after = j === glob.length || glob[j] === '/';
      if (before && after) {
        if (j === glob.length) out += '.*'; // a trailing `**`: everything inside
        else {
          out += '(?:.*/)?'; // `**/` and `/**/`: zero or more folders
          j++;
        }
        i = j - 1;
        continue;
      }
      out += '[^/]*'; // other runs of asterisks are one
      i = j - 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = classEnd(glob, i);
      if (end < 0) out += '\\[';
      else {
        out += classToRegex(glob.slice(i + 1, end));
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      const n = glob[++i];
      out += SPECIAL.test(n) || '*?[]/'.includes(n) ? `\\${n}` : n;
    } else out += SPECIAL.test(c) ? `\\${c}` : c;
  }
  return out;
}

// The index of the `]` closing the class opened at `start`, or -1; a `]` first in the class is a member.
function classEnd(glob, start) {
  let i = start + 1;
  if (glob[i] === '!' || glob[i] === '^') i++;
  if (glob[i] === ']') i++;
  for (; i < glob.length; i++) {
    if (glob[i] === '\\') i++;
    else if (glob[i] === ']') return i;
  }
  return -1;
}

function classToRegex(inner) {
  let s = inner;
  let neg = '';
  if (s[0] === '!' || s[0] === '^') {
    neg = '^';
    s = s.slice(1);
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) out += `\\${s[++i]}`;
    else if (c === ']' || c === '[' || c === '^' || c === '\\') out += `\\${c}`;
    else out += c;
  }
  return `(?!/)[${neg}${out}]`;
}

// The patterns of a `.slapignore` text, in order.
export function compile(text) {
  return String(text ?? '').split('\n').map(compileLine).filter(Boolean);
}

// The last pattern that matches decides; a negated one re-includes.
function decide(patterns, path, isDir) {
  let out = false;
  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.re.test(path)) out = !p.negated;
  }
  return out;
}

// Whether `path` (relative to the root, `/`-separated) is left out. As in git, a file inside a folder that is left out
// cannot be re-included.
export function ignored(patterns, path) {
  if (!patterns.length) return false;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (decide(patterns, parts.slice(0, i).join('/'), true)) return true;
  }
  return decide(patterns, path, false);
}


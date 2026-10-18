// Source tags at the end of a task line (task-files.md §2 rule 1).

const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const KINDS = [
  { kind: 'owner', re: new RegExp(`^owner ${DATE} (Q-[1-9]\\d*)$`), make: (m) => ({ kind: 'owner', date: m[1], q: m[2] }) },
  { kind: 'research', re: /^research (\S.*)$/, make: (m) => ({ kind: 'research', ref: m[1].trim() }) },
  { kind: 'default', re: new RegExp(`^default ${DATE}$`), make: (m) => ({ kind: 'default', date: m[1] }) },
  { kind: 'from', re: /^from (\S.*)$/, make: (m) => ({ kind: 'from', ref: m[1].trim() }) },
];
const KEYWORD = /^(owner|research|default|from)\b/;
const TRAILING = /\s*\[([^[\]]*)\]\s*$/;

export function validDate(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

function parseOne(content) {
  for (const { re, make } of KINDS) {
    const m = re.exec(content);
    if (m) {
      const tag = make(m);
      if (tag.date && !validDate(tag.date)) return null;
      return tag;
    }
  }
  return null;
}

// Splits a line into its text and the tags that end it. A trailing bracket that starts like a tag but
// does not parse is reported in `bad`, so the checker can say what is wrong with it.
export function splitTags(line) {
  let text = line.trimEnd();
  const tags = [];
  const bad = [];
  for (;;) {
    const m = TRAILING.exec(text);
    if (!m) break;
    const tag = parseOne(m[1].trim());
    if (tag) {
      tags.unshift(tag);
    } else if (KEYWORD.test(m[1].trim())) {
      bad.unshift(`[${m[1]}]`);
    } else {
      break;
    }
    text = text.slice(0, m.index);
  }
  return { text: text.trimEnd(), tags, bad };
}

// [{ kind: 'owner'|'research'|'default'|'from', date?, ref?, q? }] or null when the line ends with no tag.
export function parseTags(line) {
  const { tags } = splitTags(line);
  return tags.length ? tags : null;
}

// A line is sourced when it carries at least one tag that is not background.
export function isSourced(tags) {
  return !!tags && tags.some((t) => t.kind !== 'from');
}

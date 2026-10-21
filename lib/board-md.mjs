import { snapshot } from './board.mjs';
import { facts, items, model } from './board-model.mjs';
import { rows } from './list.mjs';

// The board as markdown, for a chat answer read on a phone (`k board --markdown`, which the mod's /k-board prints as
// it is), pane-sized (the owner, 2026-10-21): the page's sections in the page's order, headings and bullet lists, no
// table, and no line longer than WIDTH characters except one holding a single word too long to break (an id, a path).
// A task sessions work on keeps its card with each AC and E on one line, cut with "…" as the mod's pane cuts
// (truncate-end); every other task is one bullet, its id, its title cut to fit and its verdicts counted in words.
// The page (`--html`) keeps every AC and E in full.

export const WIDTH = 70;

// Text taken from the task files, escaped so markdown shows it as written.
const md = (s) => String(s ?? '').replace(/[\\`*_<>[\]]/g, '\\$&');

// A word that would start a line as a list marker, a heading or a rule shows as itself.
const lead = (w) => (/^\d{1,9}[.)]$/.test(w) ? `${w.slice(0, -1)}\\${w.slice(-1)}` : /^[-=+#]+$/.test(w) ? `\\${w}` : w);

// `text` in lines of at most `width`, the first after `first` ('- ', '1. ' or ''), the rest indented under it.
export function wrap(text, first = '', width = WIDTH) {
  const rest = ' '.repeat(first.length);
  const out = [];
  let line = null;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line === null) line = first + lead(word);
    else if (line.length + 1 + word.length > width) {
      out.push(line);
      line = rest + lead(word);
    } else line += ` ${word}`;
  }
  out.push(line ?? first.trimEnd());
  return out;
}

// `head`, then `text` escaped, then `tail`, in at most `width` characters: when the text does not fit whole it is cut
// at a character and ends with "…", and it is cut before it is escaped, so a cut never splits an escape. `start`: the
// text begins the line, so its first word cannot read as a list marker, a heading or a rule.
export function cut(head, text, tail = '', width = WIDTH, start = false) {
  const show = (s) => (start ? md(s).replace(/^\S+/, lead) : md(s));
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  const fits = (s) => head.length + s.length + tail.length <= width;
  if (fits(show(chars.join('')))) return head + show(chars.join('')) + tail;
  let n = Math.min(chars.length, Math.max(0, width - head.length - tail.length - 1));
  while (n > 0 && !fits(`${show(chars.slice(0, n).join('').trimEnd())}…`)) n--;
  return `${head}${show(chars.slice(0, n).join('').trimEnd())}…${tail}`;
}

// The fewest characters of a title a bullet keeps on its id's line; with less room the title goes to a second line.
const ROOM = 12;

const VERDICTS = ['met', 'not met', 'needs device', 'needs owner', 'none'];

// A task's verdicts counted in words, as "3 met, 1 not met, 2 none"; a count of zero is left out, and a task with no
// AC or E has none ('').
export function counts(r) {
  const n = new Map();
  for (const x of items(r)) n.set(x.verdict, (n.get(x.verdict) ?? 0) + 1);
  const order = [...VERDICTS.filter((v) => n.has(v)), ...[...n.keys()].filter((v) => !VERDICTS.includes(v))];
  return order.map((v) => `${n.get(v)} ${md(v)}`).join(', ');
}

// A task that no session works on, as one bullet: its id, its title cut to fit and its counts. When the id leaves
// the title fewer than ROOM characters, the title and the counts go to a second line, so the counts are always kept.
export function bullet(r) {
  const c = counts(r);
  const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
  const tail = c ? ` (${c})` : '';
  const head = `- ${r.id}${title ? ': ' : ''}`;
  if (head.length + Math.min(md(title).length, ROOM) + tail.length <= WIDTH) return [cut(head, title, tail)];
  return [`- ${r.id}${title ? ':' : ''}`, cut('  ', title, title ? tail : tail.trimStart(), WIDTH, true)];
}

const cards = (list) =>
  list.flatMap((r) => [
    '',
    `### ${r.id}`,
    '',
    ...wrap(md(r.title)),
    '',
    ...facts(r).flatMap((f) => wrap(md(f), '- ')),
    '',
    'Verdicts:',
    '',
    ...items(r).map((x) => cut(`- ${x.id} ${md(x.verdict)}: `, x.text)),
  ]);

// renderMarkdown(rows, st, now) → the text; `st` is status() with `sessions` beside it, as for the page.
export function renderMarkdown(list, st, now = new Date()) {
  const m = model(list, st, now);
  const out = ['# kirunak board', '', `Made at ${m.made}.`, '', `## Working on now (${m.working.length})`];
  out.push(...(m.working.length ? cards(m.working) : ['', 'No session names a task and no step is running.']));
  for (const s of m.states) out.push('', `## ${s.title} (${s.rows.length})`, '', ...s.rows.flatMap(bullet));
  if (!m.states.length) out.push('', 'No other task.');
  out.push('', '## Lock, queue and running steps', '', ...wrap(md(m.lock)));
  for (const p of m.machine) {
    out.push('', `### ${p.title}`, '');
    if (!p.rows.length) out.push(p.empty);
    p.rows.forEach((x, i) => out.push(...wrap(md(x), p.ordered ? `${i + 1}. ` : '- ')));
  }
  return out.join('\n') + '\n';
}

// markdown(ws) → the board as it is now, for `k board --markdown`.
export async function markdown(ws, now = new Date()) {
  return renderMarkdown(await rows(ws, { all: true }), snapshot(ws), now);
}

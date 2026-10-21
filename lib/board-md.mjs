import { snapshot } from './board.mjs';
import { facts, items, model } from './board-model.mjs';
import { rows } from './list.mjs';

// The board as markdown, for a chat answer read on a phone (`k board --markdown`, which the mod's /k-board prints as
// it is): the page's sections in the page's order, headings and bullet lists, no table, and no line longer than
// WIDTH characters except one holding a single word too long to break (an id, a path).

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
    ...items(r).flatMap((x) => wrap(`${x.id} ${x.verdict}: ${md(x.text)}`, '- ')),
  ]);

// renderMarkdown(rows, st, now) → the text; `st` is status() with `sessions` beside it, as for the page.
export function renderMarkdown(list, st, now = new Date()) {
  const m = model(list, st, now);
  const out = ['# kirunak board', '', `Made at ${m.made}.`, '', `## Working on now (${m.working.length})`];
  out.push(...(m.working.length ? cards(m.working) : ['', 'No session names a task and no step is running.']));
  for (const s of m.states) out.push('', `## ${s.title} (${s.rows.length})`, ...cards(s.rows));
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

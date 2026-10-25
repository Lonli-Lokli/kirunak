import { existsSync } from 'node:fs';
import { snapshot } from './board.mjs';
import { draftDate, facts, items, model } from './board-model.mjs';
import { draftPaths } from './drafts.mjs';
import { refuse } from './errors.mjs';
import { rows } from './list.mjs';
import { taskPaths } from './workspace.mjs';

// The board as markdown, for a chat answer read on a phone (`k board --markdown`), pane-sized (the owner,
// 2026-10-21): the page's sections in the page's order, headings and bullet lists, no table. A task sessions work on
// keeps its card with each AC and E on one line, cut at CUT characters with "…" as the mod's pane cuts
// (truncate-end); every other task is one bullet, its id, its title cut to fit and its verdicts counted in words.
// No line is broken inside a paragraph or a list item (kirunak-phone S-10): the phone wraps lines itself, and a line
// broken at a fixed width broke again on a narrower screen, mid-sentence. `k board --card <id>` is one task's card
// alone, the answer to a task tapped in the mod's /k-board dialog. The page (`--html`) keeps every AC and E in full.

export const CUT = 70;

// Text taken from the task files, escaped so markdown shows it as written.
const md = (s) => String(s ?? '').replace(/[\\`*_<>[\]]/g, '\\$&');

// A word that would start a line as a list marker, a heading or a rule shows as itself.
const lead = (w) => (/^\d{1,9}[.)]$/.test(w) ? `${w.slice(0, -1)}\\${w.slice(-1)}` : /^[-=+#]+$/.test(w) ? `\\${w}` : w);

// `text` on one line after `first` ('- ', '1. ' or ''), its spaces and line breaks made one space each, its first
// word unable to read as a list marker, a heading or a rule.
export function one(text, first = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  return words.length ? first + [lead(words[0]), ...words.slice(1)].join(' ') : first.trimEnd();
}

// `head`, then `text` escaped, then `tail`, in at most `width` characters: when the text does not fit whole it is cut
// at a character and ends with "…", and it is cut before it is escaped, so a cut never splits an escape. `start`: the
// text begins the line, so its first word cannot read as a list marker, a heading or a rule.
export function cut(head, text, tail = '', width = CUT, start = false) {
  const show = (s) => (start ? md(s).replace(/^\S+/, lead) : md(s));
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  const fits = (s) => head.length + s.length + tail.length <= width;
  if (fits(show(chars.join('')))) return head + show(chars.join('')) + tail;
  let n = Math.min(chars.length, Math.max(0, width - head.length - tail.length - 1));
  while (n > 0 && !fits(`${show(chars.slice(0, n).join('').trimEnd())}…`)) n--;
  return `${head}${show(chars.slice(0, n).join('').trimEnd())}…${tail}`;
}

// The fewest characters of a title a bullet keeps, however long its id.
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

// A task that no session works on, as one bullet on one line: its id, its title cut to fit CUT characters (at least
// ROOM of it however long the id) and its counts, which are always kept.
export function bullet(r) {
  const c = counts(r);
  const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
  const tail = c ? ` (${c})` : '';
  const head = `- ${r.id}${title ? ': ' : ''}`;
  return [cut(head, title, tail, Math.max(CUT, head.length + ROOM + 1 + tail.length))];
}

// One task's card: its id as a heading, its title, its facts, the climbs and stops of its steps (an escalation k run
// carries on with shows only here, orchestrator.md §2, E-17), then every AC and E on one line with its verdict.
export const cardLines = (r) => [
  `### ${r.id}`,
  '',
  one(md(r.title)),
  '',
  ...facts(r).map((f) => one(md(f), '- ')),
  ...(r.climbs?.length ? ['', 'Climbs:', '', ...r.climbs.map((c) => one(md(c), '- '))] : []),
  '',
  'Verdicts:',
  '',
  ...items(r).map((x) => cut(`- ${x.id} ${md(x.verdict)}: `, x.text)),
];

const cards = (list) => list.flatMap((r) => ['', ...cardLines(r)]);

// A draft's card, the answer to a draft tapped in the Drafts group of the mod's /k-board: its id, its title, when it
// was written and where it is, and where the owner reads it whole and starts its intake (kirunak-drafts AC-9).
export const draftCardLines = (d) => [
  `### ${d.id}`,
  '',
  one(md(d.title)),
  '',
  one(md(`a draft, ${draftDate(d)}, waiting for the owner's intake`), '- '),
  one(md(`file: kirunak/drafts/${d.slug}.md in ${d.repo}`), '- '),
  '',
  '/k-drafts shows it whole, and starts its intake or drops it.',
];

// A draft that waits for the owner's intake, as one bullet on one line: its id, its title cut to fit as a task's is,
// and the date it was written, always kept.
export function draftBullet(d) {
  const head = `- ${d.id}: `;
  const tail = `, ${draftDate(d)}`;
  return cut(head, d.title, tail, Math.max(CUT, head.length + ROOM + 1 + tail.length));
}

// renderMarkdown(rows, st, now) → the text; `st` is status() with `sessions` beside it, as for the page.
export function renderMarkdown(list, st, now = new Date()) {
  const m = model(list, st, now);
  const out = ['# kirunak board', '', `Made at ${m.made}.`, '', `## Working on now (${m.working.length})`];
  out.push(...(m.working.length ? cards(m.working) : ['', 'No session names a task and no step is running.']));
  for (const s of m.states) out.push('', `## ${s.title} (${s.rows.length})`, '', ...s.rows.flatMap(bullet));
  if (!m.states.length) out.push('', 'No other task.');
  if (m.drafts.length) out.push('', `## Drafts (${m.drafts.length})`, '', ...m.drafts.map(draftBullet));
  out.push('', '## Lock, queue and running steps', '', one(md(m.lock)));
  for (const p of m.machine) {
    out.push('', `### ${p.title}`, '');
    if (!p.rows.length) out.push(p.empty);
    p.rows.forEach((x, i) => out.push(one(md(x), p.ordered ? `${i + 1}. ` : '- ')));
  }
  return out.join('\n') + '\n';
}

// renderCard(rows, st, id, now) → the card of the task `id` as the board draws it, with who works on it when a
// session or a step does, or the card of the draft `id`; null when there is no such task or draft. A task done long
// ago, off the board, still has its card.
export function renderCard(list, st, id, now = new Date()) {
  const m = model(list, st, now);
  const r = m.working.find((x) => x.id === id) ?? list.find((x) => x.id === id);
  if (r) return cardLines(r).join('\n') + '\n';
  const d = m.drafts.find((x) => x.id === id);
  return d ? draftCardLines(d).join('\n') + '\n' : null;
}

// card(ws, id) → the card as it is now, for `k board --card <id>`; an id that names no task and no draft is refused.
export async function card(ws, id, now = new Date()) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task) && !existsSync(draftPaths(ws, id).path)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  const text = renderCard(await rows(ws, { all: true }), snapshot(ws), id, now);
  if (!text) throw refuse(`unknown task ${id}`);
  return text;
}

// markdown(ws) → the board as it is now, for `k board --markdown`.
export async function markdown(ws, now = new Date()) {
  return renderMarkdown(await rows(ws, { all: true }), snapshot(ws), now);
}

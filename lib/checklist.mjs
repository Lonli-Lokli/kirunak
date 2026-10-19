import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuse } from './errors.mjs';
import { parseReview, reviewProblems } from './review.mjs';
import { latestReview } from './state.mjs';
import { parseTask } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// The owner's checklist (review.md §3, R15): one item per `needs device` and `needs owner` row of the latest
// review, written by `k checklist <id>`. Only the owner ticks it (the freeze hook refuses an agent's tick), and
// `k accept` refuses while an item is unticked.

const NEEDS = ['needs device', 'needs owner'];
const ITEM = /^\s*- \[([ xX])\] (.*)$/;

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

// `E-2 <the row's evidence> (review-2.md)` for each row the owner checks, in the table's order; a row with no
// evidence takes the task line's text.
export function itemsOf(review, task) {
  const lineOf = (id) => [...task.sections.ac, ...task.sections.e].find((x) => x.id === id)?.body;
  return parseReview(review.text).rows.filter((r) => NEEDS.includes(r.verdict)).map((r) => `${r.id} ${r.evidence || lineOf(r.id) || r.verdict} (${review.file})`);
}

// The owner's line for a generated item: one that begins with its text, so the owner's words after it are kept;
// a ticked one first.
const ownerLine = (items, text) => items.find((x) => x.ticked && x.text.startsWith(text)) ?? items.find((x) => x.text.startsWith(text));

// checklist.md's items: [{ text, ticked, line }].
export function readChecklist(text) {
  return (text || '').split('\n').flatMap((l, n) => {
    const m = ITEM.exec(l);
    return m ? [{ text: m[2].trim(), ticked: m[1] !== ' ', line: n + 1 }] : [];
  });
}

function loaded(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  return { p, task: parseTask(readFileSync(p.task, 'utf8')), review: latestReview(p.dir) };
}

// `k checklist <id>`: checklist.md from the latest review, which must pass the grammar and be a finished review
// step's output. An item whose line the owner kept (one that begins with the item's text) keeps the owner's tick and
// the owner's words after the text; every other item is unticked. Lines that are not items stay, after the items, in
// their order; item lines from an older review go.
export function generate(ws, id) {
  const { p, task, review } = loaded(ws, id);
  if (!review) throw refuse(`${id} has no review: ${p.rel('review.md')}`);
  const bad = reviewProblems(review, { task, id, p });
  if (bad.length) throw refuse(`${id}: ${review.file} is not a finished review; the checklist comes from one:\n${bad.map((x) => `  ${x}`).join('\n')}`);
  const file = join(p.dir, 'checklist.md');
  const before = read(file);
  const owned = readChecklist(before);
  const items = itemsOf(review, task).map((text) => {
    const had = ownerLine(owned, text);
    return had ? { text: had.text, ticked: had.ticked } : { text, ticked: false };
  });
  const lines = before.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const notes = lines.filter((l) => !ITEM.test(l));
  writeFileSync(file, [...items.map((x) => `- [${x.ticked ? 'x' : ' '}] ${x.text}`), ...notes].map((l) => `${l}\n`).join(''));
  return { path: file, review: review.file, items };
}

// What the owner has not ticked: checklist.md's unticked items, and the latest review's rows with no line that begins
// with their item (k checklist not run since that review). → { unticked: [text], missing: [text] }
export function openItems(p, review, task) {
  const items = readChecklist(read(join(p.dir, 'checklist.md')));
  const missing = review ? itemsOf(review, task).filter((t) => !ownerLine(items, t)) : [];
  return { unticked: items.filter((x) => !x.ticked).map((x) => x.text), missing };
}

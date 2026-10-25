// Every notice gulnya/enforced-escalation adds (S-2 design R7.1; AC-23..AC-25): the lines of k waiting and k board
// --brief about a step stopped for the owner, and the one line a push sends. At most 3 lines of at most 80 characters,
// so it fits a phone screen without scrolling; the first names what happened with the task's title and id, the last
// the one thing to do, or that nothing is needed; plain words, no markdown.

export const LINES = 3;
export const WIDTH = 80;
export const PUSH = 200;
// The fewest characters of the title the first line keeps, however long the id and what happened.
const TITLE_ROOM = 12;

// One line of plain words: no line break, no markdown mark, cut with "…" to `n` characters.
const plain = (x) => String(x ?? '').replace(/`|\*\*/g, '').replace(/\s+/g, ' ').trim();
export const cut = (x, n) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

// notice({ title, id, step, what, why, next, width }) → { lines, one }: `<title> (<id>): <step> <what>`, then `why:
// <why>` when there is one, then `next`, or `nothing is needed`. A title too long for that first line keeps the line
// to itself, whole where it fits, and what happened opens the second, before why: a title cut to a few letters would
// not name the task (AC-24). `one` is the lines joined by ". ", at most 200 characters, for a push. `width` is
// narrower where a caller indents the lines.
export function notice({ title, id, step = null, what, why = null, next = null, width = WIDTH }) {
  const [name, task] = [plain(title) || plain(id), ` (${plain(id)})`];
  const happened = [step, what].map(plain).filter(Boolean).join(' ');
  const first = `${name}${task}: ${happened}`;
  const lines = (first.length <= width
    ? [first, why ? `why: ${plain(why)}` : null]
    : [`${cut(name, Math.max(TITLE_ROOM, width - task.length))}${task}`, why ? `${happened}: ${plain(why)}` : happened]
  ).filter(Boolean).concat(plain(next) || 'nothing is needed').map((l) => cut(l, width));
  return { lines, one: cut(lines.join('. '), PUSH) };
}

// The failure reports a stop names, by file: one or two in full, more as the first … the last.
const reportsText = (reports) => {
  const names = reports.map((r) => r.split('/').at(-1));
  return names.length > 2 ? `${names[0]} … ${names.at(-1)}` : names.join(', ');
};

// A step stopped for the owner (R7.3, E-15), from a task row's title and id and one of steps.stopsOf's entries:
// `<title> (<id>): S-n stopped, failed on every rung` / `why: <the newest report's reason>` / `read <the step's
// folder> (failure-1.md … failure-4.md)`, the folder alone when that is too long; a question waiting for the owner
// names where the answer goes.
export function stopNotice(r, stop, width = WIDTH) {
  const named = `read ${stop.dir} (${reportsText(stop.reports)})`;
  const next = stop.kind === 'owner'
    ? 'answer in a session or in notes.md, then start k run again'
    : stop.reports.length && named.length <= width ? named : `read ${stop.dir}`;
  return notice({ title: r.title, id: r.id, step: stop.step, what: stop.what, why: stop.why, next, width });
}

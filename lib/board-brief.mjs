import { snapshot } from './board.mjs';
import { bugEntry, draftEntry, entry, machineLine, model } from './board-model.mjs';
import { rows } from './list.mjs';
import { stopNotice } from './notice.mjs';

// The brief board (`k board --brief`, kirunak-phone A-7, A-9): the text of the mod's /k-board dialogs, read on a phone.
// Plain text with no markdown mark, since the dialog draws none; one line per entry and no break inside one, since
// the phone wraps its lines itself. First, when a step k run stopped at waits for the owner, a group Stopped for you
// with each such step's notice, at most 3 lines of 80 characters naming the task's title and id, why and where to
// read (orchestrator.md §2, E-15). Then the model's order: the tasks sessions work on, then every other
// task by state, then the bugs that wait, a group Bugs when there is one, k waiting's line for them first and then a
// line a bug (gulnya/kirunak-bugs AC-7), then the drafts that wait for the owner's intake, a group Drafts when there
// is one (kirunak-drafts AC-9), a bug's line saying bug of <task> (kirunak-spikes AC-6), then one line for the lock,
// the heavy-job queue, the running steps and the device claims. `ids` lists the tasks, then the bugs, then the drafts,
// in the order the text does (a stopped task twice); `groups` are the text's paragraphs, each group's name, count, ids
// and entry lines, and `machine` its last line, for the dialog in steps (groups first, then a group's tasks, bugs or
// drafts).

const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// renderBrief(rows, st, now) → { made, text, ids, groups, machine }; `st` is status() with `sessions` beside it, as
// for the page. A group's name starts with a capital letter, never a digit: the phone numbers the choices itself.
export function renderBrief(list, st, now = new Date()) {
  const m = model(list, st, now);
  const groups = [{ name: 'Working on now', rows: m.working }, ...m.states.map((s) => ({ name: upper(s.title), rows: s.rows }))].map((g) => ({
    name: g.name,
    count: g.rows.length,
    ids: g.rows.map((r) => r.id),
    lines: g.rows.map(entry),
  }));
  const stopped = list.filter((r) => r.stops?.length && r.state !== 'done');
  if (stopped.length) groups.unshift({ name: 'Stopped for you', count: stopped.length, ids: stopped.map((r) => r.id), lines: stopped.flatMap((r) => r.stops.flatMap((s) => stopNotice(r, s).lines)) });
  if (m.bugs.length || m.quadDamageLine) groups.push({ name: 'Bugs', count: m.bugs.length, ids: m.bugs.map((b) => b.id), lines: [m.quadDamageLine, m.bugsLine, ...m.bugs.map(bugEntry)].filter(Boolean) });
  if (m.drafts.length) groups.push({ name: 'Drafts', count: m.drafts.length, ids: m.drafts.map((d) => d.id), lines: m.drafts.map(draftEntry) });
  const machine = machineLine(m);
  const text = [`Made at ${m.made}.`, ...groups.map((g) => [`${g.name} (${g.count})`, ...g.lines].join('\n')), machine].join('\n\n');
  return { made: m.made, text, ids: groups.flatMap((g) => g.ids), groups, machine };
}

// brief(ws) → the brief board as it is now.
export async function brief(ws, now = new Date()) {
  return renderBrief(await rows(ws, { all: true }), snapshot(ws), now);
}

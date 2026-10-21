import { snapshot } from './board.mjs';
import { entry, machineLine, model } from './board-model.mjs';
import { rows } from './list.mjs';

// The brief board (`k board --brief`, kirunak-phone A-7, A-9): the text of the mod's /k-board dialogs, read on a phone.
// Plain text with no markdown mark, since the dialog draws none; one line per entry and no break inside one, since
// the phone wraps its lines itself. The order is the model's: the tasks sessions work on, then every other task by
// state, then one line for the lock, the heavy-job queue, the running steps and the device claims. `ids` lists the
// tasks in the order the text does; `groups` are the text's paragraphs, each group's name, count, ids and entry lines,
// and `machine` its last line, for the dialog in steps (groups first, then a group's tasks).

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
  const machine = machineLine(m);
  const text = [`Made at ${m.made}.`, ...groups.map((g) => [`${g.name} (${g.count})`, ...g.lines].join('\n')), machine].join('\n\n');
  return { made: m.made, text, ids: groups.flatMap((g) => g.ids), groups, machine };
}

// brief(ws) → the brief board as it is now.
export async function brief(ws, now = new Date()) {
  return renderBrief(await rows(ws, { all: true }), snapshot(ws), now);
}

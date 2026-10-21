import { snapshot } from './board.mjs';
import { entry, machineLine, model } from './board-model.mjs';
import { rows } from './list.mjs';

// The brief board (`k board --brief`, kirunak-phone A-7): the text of the mod's /k-board dialog, read on a phone.
// Plain text with no markdown mark, since the dialog draws none; one line per entry and no break inside one, since
// the phone wraps its lines itself. The order is the model's: the tasks sessions work on, then every other task by
// state, then one line for the lock, the heavy-job queue, the running steps and the device claims. `ids` lists the
// tasks in the order the text does, for the dialog's choices.

const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// renderBrief(rows, st, now) → { made, text, ids }; `st` is status() with `sessions` beside it, as for the page.
export function renderBrief(list, st, now = new Date()) {
  const m = model(list, st, now);
  const groups = [{ title: 'Working on now', rows: m.working }, ...m.states.map((s) => ({ title: upper(s.title), rows: s.rows }))];
  const text = [
    `Made at ${m.made}.`,
    ...groups.map((g) => [`${g.title} (${g.rows.length})`, ...g.rows.map(entry)].join('\n')),
    machineLine(m),
  ].join('\n\n');
  return { made: m.made, text, ids: groups.flatMap((g) => g.rows.map((r) => r.id)) };
}

// brief(ws) → the brief board as it is now.
export async function brief(ws, now = new Date()) {
  return renderBrief(await rows(ws, { all: true }), snapshot(ws), now);
}

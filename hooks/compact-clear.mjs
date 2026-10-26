import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLEAR_S, expectPath, isId, logLine, PARTS_S, readJson, saveJson, updateRecord } from './compact-rules.mjs';

// /clear joined to the session it ended (design/orchestrator.md §5, R5.3): SessionEnd on `clear` under the old id
// writes cleared.json, and SessionStart `clear` under the new id takes the old id's task and chain from it. After
// k-done nothing is handed over (E-5). Used by hooks/compact-start.mjs and hooks/kirunak-compact.mjs.

export const clearedPath = (home) => join(home, 'compact', 'cleared.json');
export const sessionFile = (home, id) => join(home, 'sessions', `${id}.json`);
export const within = (at, seconds, now) => {
  const age = (now.getTime() - Date.parse(at)) / 1000;
  return Number.isFinite(age) && age <= seconds && age > -seconds;
};
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return typeof p === 'string' ? resolve(p) : null;
  }
};
export const remove = (path) => {
  try {
    unlinkSync(path);
  } catch {
    // gone already
  }
};
export const taskOf = (s) => (typeof s?.task === 'string' && s.task ? s.task : null);

// R5.3: SessionEnd on /clear, under the old id. With a task, cleared.json names it for the new id's SessionStart;
// without one (k-done's handoff released the session, E-5) any cleared.json goes, so nothing is put back.
export function onEnd(input, home, now = new Date()) {
  if (input.reason !== 'clear' || !isId(input.session_id)) return;
  const s = readJson(sessionFile(home, input.session_id));
  const task = taskOf(s);
  if (task) {
    saveJson(clearedPath(home), {
      from: input.session_id, task, step: s.step ?? null, since: s.since ?? null,
      previous: Array.isArray(s.previous) ? s.previous.filter(isId) : [], at: now.toISOString(), cwd: input.cwd ?? null,
      ppid: process.ppid,
    });
  } else remove(clearedPath(home));
  logLine(home, { ts: now.toISOString(), event: 'SessionEnd', session: input.session_id, reason: 'clear', task });
}

// R5.3: SessionStart `clear` under the new id joins the old one when cleared.json is recent and from the same folder.
// The parent process is compared and logged, never required: a shell between Claude Code and the hook changes it. The
// state part writes the new id's session file (the chain), marks the old one `clearedTo`, records `joined` and
// removes cleared.json.
export async function clearFire(home, input, part, now) {
  const id = input.session_id;
  const c = readJson(clearedPath(home));
  const path = expectPath(home, id);
  const rec = readJson(path) ?? {};
  const fresh = within(c?.at, CLEAR_S, now);
  const here = realOr(c?.cwd) === realOr(input.cwd);
  if (!c || !isId(c.from) || c.from === id || !taskOf(c) || !fresh || !here) {
    if (part !== 'state' && rec.joined && within(rec.joined.at, PARTS_S, now)) return { put: true, why: 'joined', ...rec.joined };
    if (part === 'state' && c && !fresh) remove(clearedPath(home));
    const why = !c ? 'nothing cleared' : !fresh ? 'cleared too long ago' : !here ? 'another folder' : 'not for this session';
    return { put: false, why };
  }
  const previous = [...(Array.isArray(c.previous) ? c.previous.filter(isId) : []), c.from];
  if (part === 'state') {
    const { readSession, updateSession } = await import('../lib/keeper.mjs');
    updateRecord(path, (r) => ({ ...r, joined: { at: now.toISOString(), from: c.from, task: c.task, previous } }));
    const patch = { task: c.task, step: c.step ?? null, since: c.since ?? null, previous };
    updateSession(home, id, patch);
    // The status line's tracker merges into the same file: a write it made from an older read is made good once.
    if (readSession(home, id)?.task !== c.task) updateSession(home, id, patch);
    if (existsSync(sessionFile(home, c.from))) updateSession(home, c.from, { clearedTo: id });
    remove(clearedPath(home));
  }
  const why = c.ppid == null || c.ppid === process.ppid ? 'joined' : 'joined, another parent process';
  return { put: true, why, from: c.from, task: c.task, previous };
}

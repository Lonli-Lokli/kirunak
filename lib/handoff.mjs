import { existsSync, readFileSync } from 'node:fs';
import { refuse, usage } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import { sessionPath, updateSession } from './keeper.mjs';
import { parseTask } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// Closing (review.md §4) and a session's current task (boards.md §4).

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSession(session, required) {
  if (session === undefined || session === null || session === '') {
    if (required) throw usage('a session id is needed: --session <id>');
    return;
  }
  if (!SESSION.test(session)) throw usage(`not a session id: ${session}`);
}

function knownTask(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  return p;
}

// The `task` every handoff implementation receives: the task's paths, with its title.
function taskOf(p) {
  const title = parseTask(readFileSync(p.task, 'utf8')).front.title || p.slug;
  return { ...p, title };
}

// handoff({ ws, id, session, cwd }) → { targets: [{ where, what }], released: [{ resource, line }] }.
// Every loaded `handoff` implementation in load order (the core's default first): all targets, then all releases.
export async function handoff({ ws, id, session, cwd = process.cwd() }) {
  checkSession(session, false);
  const task = taskOf(knownTask(ws, id));
  const impls = ws.seams?.handoff || [];
  const targets = [];
  const released = [];
  for (const impl of impls) targets.push(...((await impl.targets({ task, session, cwd })) || []));
  for (const impl of impls) released.push(...((await impl.release({ task, session, cwd })) || []));
  return { targets, released };
}

// start({ ws, id, session, now }) sets { task, step: null, since } in <home>/sessions/<session>.json, keeping what the
// status line's tracker wrote there (the cache keeper's fields).
export function start({ ws, id, session, now = new Date() }) {
  checkSession(session, true);
  knownTask(ws, id);
  const home = ws.home || kirunakHome();
  const record = { task: id, step: null, since: now.toISOString() };
  updateSession(home, session, record);
  return { path: sessionPath(home, session), ...record };
}

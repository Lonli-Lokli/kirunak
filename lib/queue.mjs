import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { refuse } from './errors.mjs';
import { commit, toplevel } from './git.mjs';
import { taskPaths } from './workspace.mjs';

// The one queue (task-files.md §6): one task id per line, in order; `#` lines are comments.

const isId = (line) => line.trim() !== '' && !line.trim().startsWith('#');

function lines(ws) {
  if (!existsSync(ws.queue)) throw refuse(`the queue file ${ws.queue} does not exist`);
  const text = readFileSync(ws.queue, 'utf8');
  return text.replace(/\n$/, '').split('\n');
}

export function read(ws) {
  return lines(ws).filter(isId).map((l) => l.trim());
}

// place: { first } | { last } | { before: id } | { after: id }; last by default.
function insert(all, id, place = {}) {
  const ids = all.map((l, i) => (isId(l) ? i : -1)).filter((i) => i >= 0);
  const at = (target) => {
    const i = all.findIndex((l) => isId(l) && l.trim() === target);
    if (i < 0) throw refuse(`${target} is not in the queue`);
    return i;
  };
  let index;
  if (place.before) index = at(place.before);
  else if (place.after) index = at(place.after) + 1;
  else if (place.first) index = ids.length ? ids[0] : all.length;
  else index = ids.length ? ids[ids.length - 1] + 1 : all.length;
  all.splice(index, 0, id);
  return all;
}

// The git repo that holds the queue, which every change of it is committed in, or null when there is none.
export const repoOf = (ws) => (existsSync(dirname(ws.queue)) ? toplevel(dirname(ws.queue)) : null);

// The queue's repo, refused when there is none: asked before anything is written, by a change of the queue and by
// the verbs that will make one (asilak/kirunak-approve-queue-not-git). → its top folder.
export function rootOf(ws) {
  const root = repoOf(ws);
  if (!root) throw refuse(`the queue ${ws.queue} is not in a git repo`);
  return root;
}

// The queue a verb will change, asked before it writes anything: refused when its file is missing or in no git repo,
// as the change itself would be (asilak/kirunak-approve-queue-not-git). → its ids.
export function writable(ws) {
  const ids = read(ws);
  rootOf(ws);
  return ids;
}

function save(ws, all, verb, id, env) {
  const root = rootOf(ws);
  writeFileSync(ws.queue, all.join('\n') + '\n');
  return commit(root, [relative(root, ws.queue)], `kirunak: queue ${verb} ${id}`, env);
}

export function add(ws, id, place = {}, env) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  const all = lines(ws);
  if (all.some((l) => isId(l) && l.trim() === id)) throw refuse(`${id} is already in the queue`);
  return save(ws, insert(all, id, place), 'add', id, env);
}

export function move(ws, id, place = {}, env) {
  const all = lines(ws);
  const i = all.findIndex((l) => isId(l) && l.trim() === id);
  if (i < 0) throw refuse(`${id} is not in the queue`);
  if (place.before === id || place.after === id) throw refuse(`${id} cannot move relative to itself`);
  all.splice(i, 1);
  return save(ws, insert(all, id, place), 'move', id, env);
}

export function remove(ws, id, env) {
  const all = lines(ws);
  const i = all.findIndex((l) => isId(l) && l.trim() === id);
  if (i < 0) throw refuse(`${id} is not in the queue`);
  all.splice(i, 1);
  return save(ws, all, 'remove', id, env);
}

// `k records <id> [<file>...] [--dry-run]` (gulnya/accept-leaves-task-files AC-1, AC-3, E-1, E-2): the task folder's
// records committed in one commit of their paths only. k-done runs it once the owner confirms the task done, the list
// shown first with --dry-run, and again after the accept for the handoff it writes (`k records <id> handoff.md`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuse } from './errors.mjs';
import { changedUnder, deletedUnder, writeAndCommit } from './git.mjs';
import { dropHold, heldMarks, heldText, holdOf, planText } from './held.mjs';
import { taskPaths } from './workspace.mjs';

// The files `k records` leaves aside: the frozen task.md, and done.json and cost.md, which only k accept writes.
const ASIDE = ['task.md', 'done.json', 'cost.md'];

// Every changed, new or deleted file of the task's folder that git does not ignore, ASIDE left out, as
// [{ path, deleted }] sorted by path, root-relative; `only` (paths relative to the folder, a file or a folder) narrows
// it to those.
export function folderRecords(p, only = []) {
  const aside = new Set(ASIDE.map((f) => p.rel(f)));
  const under = only.map((f) => p.rel(String(f).replace(/^\.\/|\/+$/g, '')));
  const wanted = (f) => !aside.has(f) && (!under.length || under.some((u) => f === u || f.startsWith(`${u}/`)));
  const changed = changedUnder(p.root, p.rel('')).map((path) => ({ path, deleted: false }));
  const deleted = deletedUnder(p.root, p.rel('')).map((path) => ({ path, deleted: true }));
  return [...changed, ...deleted].filter((x) => wanted(x.path)).sort((a, b) => a.path.localeCompare(b.path));
}

const line = (x) => `  ${x.path}${x.deleted ? ' (deleted)' : ''}`;

// Lists the records, then commits exactly their paths (`git commit -- <paths>`, so what other sessions staged stays
// out) under KIRUNAK_RECORDING=<id>, which the SLAP hook leaves unmeasured while every path is in this task's folder,
// task.md and the owner's records aside (change-size.md §3). With dryRun it only lists. Nothing to commit says so. A
// commit a git hook refuses throws its whole message, the files and the index put back as they were (writeAndCommit).
// An accepted task's folder is committed the same way: its handoff comes after the accept. With no files named, it
// also ends a release run's open hold (lib/held.mjs), as a run that will not finish needs: the held lines appended to
// progress.md and the held escalate marks put on plan.md in the same commit, then the hold dropped.
export function records({ ws, id, files = [], dryRun = false }) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}`);
  const hold = files.length ? null : holdOf(p.dir);
  const held = hold ? heldText(p.dir) : '';
  const marked = hold && heldMarks(p.dir) ? planText(p.dir) : null;
  const list = folderRecords(p, files);
  const add = (path) => list.some((x) => x.path === path) || list.push({ path, deleted: false });
  if (held) add(p.rel('progress.md'));
  if (marked != null) add(p.rel('plan.md'));
  list.sort((a, b) => a.path.localeCompare(b.path));
  const scope = files.length ? `${files.join(', ')} in ${id}'s folder` : `${id}'s folder`;
  const ends = hold ? `; the hold of the release run ${hold.run.join(', ')} ${dryRun ? 'would end' : 'ended'}, its lines in progress.md${marked == null ? '' : ', its [escalate] marks in plan.md'}` : '';
  if (!list.length) {
    if (hold && !dryRun) dropHold(p.dir);
    return { files: [], commit: null, text: `${id}: nothing to commit in ${scope}${ends}` };
  }
  const lines = list.map(line).join('\n');
  if (dryRun) return { files: list, commit: null, text: `${id}: k records would commit ${list.length} file(s) of ${scope}${ends}:\n${lines}` };
  const message = `kirunak: ${id} records`;
  const tree = join(p.dir, 'progress.md');
  const write = () => {
    if (marked != null) writeFileSync(join(p.dir, 'plan.md'), marked);
    if (!held) return;
    const was = existsSync(tree) ? readFileSync(tree, 'utf8') : '';
    writeFileSync(tree, `${was}${was === '' || was.endsWith('\n') ? '' : '\n'}${held}`);
  };
  const sha = writeAndCommit(p.root, list.map((x) => x.path), write, message, { KIRUNAK_RECORDING: id });
  if (hold) dropHold(p.dir);
  return { files: list, commit: sha, text: `${id}: committed ${list.length} file(s) of ${scope} in ${sha}, ${message}${ends}:\n${lines}` };
}

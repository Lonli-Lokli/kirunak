import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { kirunakHome } from './home.mjs';

// A release run's held records (orchestrator.md §2, "A release run keeps the tree clean"; the bug
// gulnya/step-records-void-release-receipts). A release's device gates and uploads count only for a tree with no
// tracked change, at one commit, so while a run of `clean-tree: yes` steps is open kirunak writes nothing into the
// task's repo that git tracks and commits nothing there: every progress line goes to the hold in the state folder,
// $KIRUNAK_HOME/held/<key>/progress.md, beside hold.json { task, dir, run, head, opened }, and the step folders' new
// records and evidence stay on disk, untracked, until the run's last step finishes and lib/steps.mjs commits them in
// one go. The key is the task folder's real path, hashed, so a reader that knows only the folder (a hook, k list)
// finds it, and a worktree's copy of the task holds apart. Nothing here imports more than node and home.mjs, so the
// compaction hooks read it for the cost of a file.

const real = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
};
const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// The hold's folder for a task folder, open or not.
export const heldDir = (taskDir, home = kirunakHome()) =>
  join(home, 'held', createHash('sha256').update(real(taskDir)).digest('hex').slice(0, 16));

// The open hold, { task, dir, run: [step ids], head, opened }, or null.
export function holdOf(taskDir, home = kirunakHome()) {
  const text = read(join(heldDir(taskDir, home), 'hold.json'));
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The held progress lines, '' when there are none.
export const heldText = (taskDir, home = kirunakHome()) => read(join(heldDir(taskDir, home), 'progress.md')) ?? '';

// progress.md as every reader takes it: the tree's file, then the held lines after it; null when neither exists.
export function progressText(taskDir, home = kirunakHome()) {
  const tree = read(join(taskDir, 'progress.md'));
  const held = read(join(heldDir(taskDir, home), 'progress.md'));
  if (held == null) return tree;
  if (tree == null) return held;
  return `${tree}${tree === '' || tree.endsWith('\n') ? '' : '\n'}${held}`;
}

// One line appended to progress.md, or to the hold while one is open.
export function appendProgress(taskDir, line, home = kirunakHome()) {
  const dir = heldDir(taskDir, home);
  const target = existsSync(join(dir, 'hold.json')) ? join(dir, 'progress.md') : join(taskDir, 'progress.md');
  appendFileSync(target, `${line}\n`);
}

// Opens the hold, or widens the open one by `run`: → the hold as written. hold.json is written whole through a
// rename, so a crash leaves the old one or the new one.
export function openHold(taskDir, { task, run, head, opened }, home = kirunakHome()) {
  const dir = heldDir(taskDir, home);
  const was = holdOf(taskDir, home);
  const hold = was ? { ...was, run: [...new Set([...was.run, ...run])] } : { task, dir: real(taskDir), run, head, opened };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hold.json.tmp'), `${JSON.stringify(hold, null, 2)}\n`);
  renameSync(join(dir, 'hold.json.tmp'), join(dir, 'hold.json'));
  return hold;
}

// The hold gone, once its lines are committed into progress.md.
export const dropHold = (taskDir, home = kirunakHome()) => rmSync(heldDir(taskDir, home), { recursive: true, force: true });

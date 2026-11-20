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
// one go. A step that stops for the owner meanwhile keeps its `[escalate]` mark there too (marks.json), and every
// reader of plan.md takes the tree's plan with the marks on it (planText). The key is the task folder's real path,
// hashed, so a reader that knows only the folder (a hook, k list) finds it, and a worktree's copy of the task holds
// apart. Nothing here imports more than node and home.mjs, so the
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

// An `[escalate]` stop on the step's header in plan.md's text, and its `failures:` field after the step's last field
// (in place of one an earlier stop wrote) when there are failures: the text with the mark. lib/steps.mjs's escalate and
// repeatStop write it, into the tree or, while a hold is open, as a held mark that every plan reader takes.
export function escalateText(text, step, failures = []) {
  const lines = text.split('\n');
  const head = new RegExp(`^###\\s+${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return text;
  if (!/\[escalate(?::[^\]]*)?\]\s*$/.test(lines[at])) lines[at] = `${lines[at].trimEnd()} [escalate]`;
  if (failures.length) {
    const next = lines.findIndex((l, i) => i > at && l.startsWith('### '));
    const end = next < 0 ? lines.length : next;
    const field = `failures: ${failures.join(', ')}`;
    const had = lines.slice(at + 1, end).findIndex((l) => l.startsWith('failures:'));
    let to = end;
    while (to > at + 1 && lines[to - 1].trim() === '') to--;
    if (had >= 0) lines[at + 1 + had] = field;
    else lines.splice(to, 0, field);
  }
  return lines.join('\n');
}

// The escalate marks a hold keeps out of the tree, { <step>: [failure paths] }, or null when none is held.
export function heldMarks(taskDir, home = kirunakHome()) {
  const text = read(join(heldDir(taskDir, home), 'marks.json'));
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// plan.md as every reader takes it: the tree's file with the held marks on it; null when there is no plan.
export function planText(taskDir, home = kirunakHome()) {
  const tree = read(join(taskDir, 'plan.md'));
  const marks = heldMarks(taskDir, home);
  if (tree == null || !marks) return tree;
  return Object.entries(marks).reduce((text, [step, failures]) => escalateText(text, step, failures), tree);
}

// `[escalate]` on a step, with its failures: into the hold while one is open (marks.json, written whole through a
// rename; a later mark of the step without failures keeps the ones held), else into the tree's plan.md. → true when
// held.
export function markEscalate(taskDir, step, failures = [], home = kirunakHome()) {
  const dir = heldDir(taskDir, home);
  if (!existsSync(join(dir, 'hold.json'))) {
    const file = join(taskDir, 'plan.md');
    writeFileSync(file, escalateText(readFileSync(file, 'utf8'), step, failures));
    return false;
  }
  const marks = heldMarks(taskDir, home) ?? {};
  marks[step] = failures.length ? failures : (marks[step] ?? []);
  writeFileSync(join(dir, 'marks.json.tmp'), `${JSON.stringify(marks, null, 2)}\n`);
  renameSync(join(dir, 'marks.json.tmp'), join(dir, 'marks.json'));
  return true;
}

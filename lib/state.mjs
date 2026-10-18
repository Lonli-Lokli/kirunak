import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes } from './approval.mjs';
import { parsePlan, unproduced } from './plan.mjs';
import { checkTask, intakeQuestions, isReady, parseTask, removedIds } from './task.mjs';

// The eleven states (task-files.md §4), derived from the records; there is no state field.
export const STATES = [
  'draft', 'proposed', 'ready', 'blocked', 'in progress', 'in review', 'reviewed', 'awaiting owner', 'done', 'on hold', 'stale',
];

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

// The latest review: review.md, then review-2.md, review-3.md, ... (review.md §2).
export function latestReview(taskDir) {
  if (!existsSync(taskDir)) return null;
  let best = null;
  let bestN = 0;
  for (const f of readdirSync(taskDir)) {
    const m = /^review(?:-(\d+))?\.md$/.exec(f);
    if (!m) continue;
    const n = m[1] ? Number(m[1]) : 1;
    if (n > bestN) [best, bestN] = [f, n];
  }
  return best ? { file: best, text: readFileSync(join(taskDir, best), 'utf8') } : null;
}

export function amendmentTexts(taskDir) {
  const dir = join(taskDir, 'amendments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^A-\d+\.md$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8'));
}

// The checks `k check` runs: the task's problems with the amendments and the intake log taken into account.
export function checkTaskDir(taskDir, aspectIds, id) {
  const text = read(join(taskDir, 'task.md'));
  if (text === null) return { parsed: null, problems: [{ line: 0, problem: 'no task.md' }], ready: false };
  const parsed = parseTask(text);
  const intake = read(join(taskDir, 'intake.md'));
  const opts = { removed: removedIds(amendmentTexts(taskDir)), intakeQs: intake === null ? null : intakeQuestions(intake), id };
  const problems = checkTask(parsed, aspectIds, opts);
  return { parsed, problems, ready: problems.length === 0 && isReady(parsed, aspectIds, opts) };
}

// The `blocked-by:` list in plan.md's front matter (orchestrator.md §1): task ids, or `owner Q-n`.
export function blockedBy(planText) {
  if (!planText) return [];
  const m = /^blocked-by:\s*\[?([^\]\n]*)\]?\s*$/m.exec(planText.split(/^---\s*$/m)[1] ?? planText);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// A step's run asked the owner a question in steps/<step>/needs.json (orchestrator.md §2).
export function asksOwner(taskDir) {
  const dir = join(taskDir, 'steps');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((s) => {
    try {
      return typeof JSON.parse(readFileSync(join(dir, s, 'needs.json'), 'utf8'))?.owner === 'string';
    } catch {
      return false;
    }
  });
}

export function stepStarted(progressText) {
  return !!progressText && /\bS-[\w-]+ started\b/.test(progressText);
}

// stateOf({ taskDir, record, aspectIds, isDone, id }) → one of STATES.
// `record` is the parsed approval record or null; `isDone(id)` says whether another task is done.
export function stateOf({ taskDir, record, aspectIds = [], isDone = () => false, id }) {
  if (existsSync(join(taskDir, 'done.json'))) return 'done';
  if (existsSync(join(taskDir, 'hold.md'))) return 'on hold';
  if (!record) return checkTaskDir(taskDir, aspectIds, id).ready ? 'proposed' : 'draft';
  const bytes = existsSync(join(taskDir, 'task.md')) ? readFileSync(join(taskDir, 'task.md')) : Buffer.alloc(0);
  if (record.hash !== hashBytes(bytes)) return 'stale';
  const review = latestReview(taskDir);
  if (review) {
    if (!/^verdict:/m.test(review.text)) return 'in review';
    const checklist = read(join(taskDir, 'checklist.md'));
    return checklist && /^- \[ \]/m.test(checklist) ? 'awaiting owner' : 'reviewed';
  }
  const planText = read(join(taskDir, 'plan.md'));
  const blockers = blockedBy(planText).filter((b) => b.startsWith('owner') || !isDone(b));
  // The task folder is <root>/kirunak/tasks/<slug>, so a step's input resolves against both.
  if (blockers.length || (planText && unproduced(parsePlan(planText), { dir: taskDir, root: join(taskDir, '..', '..', '..') }).length)) return 'blocked';
  if (!stepStarted(read(join(taskDir, 'progress.md')))) return 'ready';
  return asksOwner(taskDir) ? 'awaiting owner' : 'in progress';
}

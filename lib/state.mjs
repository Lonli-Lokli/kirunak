import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashBytes } from './approval.mjs';
import { parsePlan, unproduced } from './plan.mjs';
import { reviewProblems } from './review.mjs';
import { checkTask, intakeQuestions, isReady, parseTask, removedIds } from './task.mjs';

// The twelve states (task-files.md §4), derived from the records and the queue; there is no state field. An approved
// task with no step started is queued while it is in the queue and parked while it is not (kirunak-phone AC-15).
export const STATES = [
  'draft', 'proposed', 'queued', 'parked', 'blocked', 'in progress', 'in review', 'reviewed', 'awaiting owner', 'done', 'on hold',
  'stale',
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

// The texts of amendments/A-n.md; `instead` ({ 'A-2': text }) gives an amendment's text as it would be written.
export function amendmentTexts(taskDir, instead = {}) {
  const dir = join(taskDir, 'amendments');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^A-\d+\.md$/.test(f)).map((f) => instead[f.slice(0, -3)] ?? readFileSync(join(dir, f), 'utf8'));
}

// The checks `k check` runs: the task's problems with the amendments and the intake log taken into account. `asIf`
// ({ text, amendments }) checks task.md and amendments as they would be written, so k approve checks an amendment's
// result before it writes anything.
export function checkTaskDir(taskDir, aspectIds, id, asIf = {}) {
  const text = asIf.text ?? read(join(taskDir, 'task.md'));
  if (text === null) return { parsed: null, problems: [{ line: 0, problem: 'no task.md' }], ready: false };
  const parsed = parseTask(text);
  const intake = read(join(taskDir, 'intake.md'));
  const opts = { removed: removedIds(amendmentTexts(taskDir, asIf.amendments)), intakeQs: intake === null ? null : intakeQuestions(intake), id };
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

// stateOf({ taskDir, record, aspectIds, isDone, id, queued }) → one of STATES.
// `record` is the parsed approval record or null; `isDone(id)` says whether another task is done; `queued` whether the
// task is in the queue.
export function stateOf({ taskDir, record, aspectIds = [], isDone = () => false, id, queued = false }) {
  if (existsSync(join(taskDir, 'done.json'))) return 'done';
  if (existsSync(join(taskDir, 'hold.md'))) return 'on hold';
  if (!record) return checkTaskDir(taskDir, aspectIds, id).ready ? 'proposed' : 'draft';
  const bytes = existsSync(join(taskDir, 'task.md')) ? readFileSync(join(taskDir, 'task.md')) : Buffer.alloc(0);
  if (record.hash !== hashBytes(bytes)) return 'stale';
  const review = latestReview(taskDir);
  if (review) {
    // Reviewed only once the latest review passes the grammar (git aside: k list runs none) and its step finished.
    const task = parseTask(bytes.toString('utf8'));
    if (reviewProblems(review, { task, id, p: { dir: taskDir }, atHead: false }).length) return 'in review';
    const checklist = read(join(taskDir, 'checklist.md'));
    return checklist && /^- \[ \]/m.test(checklist) ? 'awaiting owner' : 'reviewed';
  }
  const planText = read(join(taskDir, 'plan.md'));
  const blockers = blockedBy(planText).filter((b) => b.startsWith('owner') || !isDone(b));
  // The task folder is <root>/kirunak/tasks/<slug>, so a step's input resolves against both. A plan with no review
  // step blocks too: no step may start (k plan check), as k accept takes only a review.
  const plan = planText && parsePlan(planText);
  const noReview = plan && plan.steps.length && !plan.steps.some((s) => s.kind === 'review');
  const stuck = plan && (unproduced(plan, { dir: taskDir, root: join(taskDir, '..', '..', '..') }).length || noReview);
  if (blockers.length || stuck) return 'blocked';
  if (!stepStarted(read(join(taskDir, 'progress.md')))) return queued ? 'queued' : 'parked';
  return asksOwner(taskDir) ? 'awaiting owner' : 'in progress';
}

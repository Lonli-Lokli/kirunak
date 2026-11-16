import { existsSync, readFileSync } from 'node:fs';
import * as approval from './approval.mjs';
import * as cost from './cost.mjs';
import { releaseOf } from './final.mjs';
import { taskPaths } from './workspace.mjs';
import * as worktrees from './worktrees.mjs';

const baselineOf = (ws) => (ws.baseline && existsSync(ws.baseline) ? JSON.parse(readFileSync(ws.baseline, 'utf8')) : null);

// The accept that closes a task (approval.md §4), the owner's `k accept` and the close after a release's last final
// step alike: the task's cost, read before the accept, which records it in done.json and commits cost.md rendered
// from it (a cost that cannot be read, the records or a baseline that does not parse, is recorded as why and never
// stops the accept); then, once the acceptance is committed, the merged worktrees go, the session that runs it first
// taken out of every worktree's lock; nothing there undoes or fails it. A release's accept that signs off instead
// (final.mjs) reads no cost and removes no worktree. → approval.accept's result, with worktrees when it closed.
export async function close({ ws, id, checklistOpen, via = 'shell', session = null, now }) {
  let taskCost;
  const rel = releaseOf(taskPaths(ws, id).dir);
  if (!rel.finals.length || rel.signed) {
    try {
      const c = await cost.costOf(ws, id);
      const b = baselineOf(ws);
      taskCost = cost.summary(c, b ? cost.compare(c, b) : []);
    } catch (e) {
      taskCost = { error: e.message };
    }
  }
  const r = approval.accept({ ws, id, checklistOpen, via, cost: taskCost, session, ...(now ? { now } : {}) });
  if (r.state !== 'done') return r;
  return { ...r, worktrees: await worktrees.worktrees({ ws, closing: id, remove: true, session }) };
}

// After a step finished: when it was a release's last final step to pass since the owner's sign-off, kirunak closes
// the task by the same code, with the session the sign-off names. → close's result, or null when it is not time.
export async function closeIfFinal({ ws, id, step, now }) {
  const rel = releaseOf(taskPaths(ws, id).dir);
  if (!rel.signed || rel.left.length || !rel.finals.some((s) => s.id === step)) return null;
  return close({ ws, id, via: 'sign-off', session: rel.signed.session, now });
}

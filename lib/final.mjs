import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from './plan.mjs';
import { progressText } from './held.mjs';

// A release's final steps and the owner's sign-off (orchestrator.md §1, approval.md §4). The owner's `k accept` on a
// release whose final steps are not finished signs off instead of closing: a line in progress.md, no step's event,
//   2026-11-15 18:02 signed off by the owner: final steps S-8, S-9 queued (session 7c1…[, checklist open: <why>])
// From it the final steps run as any other ready step; before it, and after a final step's failure has withdrawn it
//   2026-11-15 19:40 sign-off withdrawn: S-8 failed
// they wait for the owner. A final step's history counts only from the latest sign-off on, so the owner's next accept
// runs every final step again: the build may have changed.

const SIGNED = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) signed off by the owner: final steps (.+?) queued \(session (\S+?)(?:, checklist open: (.*))?\)$/;
const WITHDRAWN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) sign-off withdrawn: (S-[A-Za-z0-9-]+) failed$/;

// A release plan's final steps, in plan order; none outside a release (k plan check refuses `final: yes` there).
export const finalSteps = (plan) => (plan?.front?.release ? plan.steps.filter((s) => s.final) : []);

export function signedLine(stamp, ids, session, checklistOpen = null) {
  return `${stamp} signed off by the owner: final steps ${ids.join(', ')} queued (session ${session || 'none'}${checklistOpen ? `, checklist open: ${checklistOpen}` : ''})`;
}
export const withdrawnLine = (stamp, step) => `${stamp} sign-off withdrawn: ${step} failed`;

// The sign-off that stands: the latest `signed off` line with no `withdrawn` line after it. → { at, steps, session,
// checklistOpen, since } (since: progress.md's text after the line, the final steps' history) or null.
export function signOff(progressText) {
  const lines = (progressText || '').split('\n');
  let found = null;
  lines.forEach((l, i) => {
    const m = SIGNED.exec(l);
    if (m) found = { at: m[1], line: i, steps: m[2].split(',').map((x) => x.trim()), session: m[3] === 'none' ? null : m[3], checklistOpen: m[4] ?? null };
    else if (found && WITHDRAWN.test(l)) found = null;
  });
  if (!found) return null;
  const { line, ...rest } = found;
  return { ...rest, since: lines.slice(line + 1).join('\n') };
}

// A commit a final step made: its message names `(<id> S-n)`, or is that step's own record (`<id> S-n: ...`), for a
// final S-n. Such a commit never blocks the close as later work the review never saw.
export function byFinalStep(message, id, finals) {
  const ids = new Set(finals.map((s) => s.id ?? s));
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\(${esc} (S-[A-Za-z0-9-]+)\\)|^${esc} (S-[A-Za-z0-9-]+): `).exec(message || '');
  return !!m && ids.has(m[1] ?? m[2]);
}

// A step's last lifecycle verb in a stretch of progress.md, as steps.mjs historyOf reads it (started, finished,
// failed), or null.
export function lastOf(text, step) {
  let last = null;
  for (const l of (text || '').split('\n')) {
    const m = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (S-[A-Za-z0-9-]+) (started|resumed|finished|failed)\b/.exec(l);
    if (m && m[1] === step) last = m[2] === 'resumed' ? 'started' : m[2];
  }
  return last;
}

// The task's release as its records stand: { finals, signed, left } (left: the final steps not finished since the
// sign-off, every one when there is none), read from plan.md and progress.md in the task's folder.
export function releaseOf(taskDir) {
  const read = (f) => (existsSync(join(taskDir, f)) ? readFileSync(join(taskDir, f), 'utf8') : null);
  const planText = read('plan.md');
  const finals = planText ? finalSteps(parsePlan(planText)) : [];
  if (!finals.length) return { finals, signed: null, left: [] };
  const signed = signOff(progressText(taskDir));
  const left = finals.filter((s) => !signed || lastOf(signed.since, s.id) !== 'finished').map((s) => s.id);
  return { finals, signed, left };
}

// How k list and k board show a release (boards.md §1, §2): a task in the final state reads "final steps, 2 left",
// every other its state's name; `r` is a list row, whose `release` is { finals, left, signed } or null.
export const stateWord = (r) => (r.state === 'final' && r.release ? `final steps, ${r.release.left.length} left` : r.state);

// A step named in `text` (a progress line, "S-8 done", "S-8 running since ...") as a final step of `r`'s release:
// the word final before its id, "final S-8 done", so it reads apart on the phone with no emoji. Text naming no final
// step comes back as it is.
export function markFinal(r, text) {
  const finals = new Set(r?.release?.finals ?? []);
  if (!finals.size || !text) return text;
  return text.replace(/(^|[^\w-])(S-[A-Za-z0-9-]+)\b/g, (all, pre, id) => (finals.has(id) ? `${pre}final ${id}` : all));
}

// A card's line for a release: its final steps and where they are, "final steps S-8, S-9: wait for the owner's
// sign-off, k accept", "final steps S-8, S-9: 1 left, S-9", "final steps S-8, S-9: passed"; null outside a release.
export function releaseFact(r) {
  const rel = r?.release;
  if (!rel) return null;
  const head = `final steps ${rel.finals.join(', ')}`;
  if (r.state === 'done') return `${head}: passed`;
  if (!rel.signed) return `${head}: wait for the owner's sign-off, k accept`;
  return rel.left.length ? `${head}: ${rel.left.length} left, ${rel.left.join(', ')}` : `${head}: passed`;
}

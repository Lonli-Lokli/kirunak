import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAmendment } from './amend.mjs';
import * as approval from './approval.mjs';
import { KError } from './errors.mjs';
import { taskPaths } from './workspace.mjs';

// What `k waiting` adds for the mod's pick lists (kirunak-phone S-4): the amendments waiting for the owner, the accept
// rows' checklist, and the tasks k hold can take. Every "would refuse" comes from the verb's own dry run, never from a
// copy of its rules.

// A refusal as one line: its first line, then its listed problems joined by "; ".
export function oneLine(message) {
  const [first, ...rest] = String(message).split('\n').map((l) => l.trim()).filter(Boolean);
  return rest.length ? `${first} ${rest.join('; ')}` : first;
}

// What the verb's dry run refuses, in its words, or null when it would run.
async function refusal(dryRun) {
  try {
    await dryRun();
    return null;
  } catch (e) {
    if (!(e instanceof KError)) throw e;
    return e.message;
  }
}

// What `k approve <id> --amendment A-n` would refuse, as one line, or null.
export async function amendmentRefusal(ws, id, aid) {
  const why = await refusal(() => approval.approve({ ws, id, amendment: aid, dryRun: true }));
  return why === null ? null : oneLine(why);
}

const firstSentence = (text) => (/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).trim() || null;

// One row per amendment that is neither applied nor declined, of the given task rows (k list --all's order), A-n in
// order within a task.
export async function pendingAmendments(ws, rows) {
  const out = [];
  for (const r of rows) {
    const dir = join(taskPaths(ws, r.id).dir, 'amendments');
    if (!existsSync(dir)) continue;
    const ns = readdirSync(dir).map((f) => /^A-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
    for (const n of ns) {
      const am = readAmendment(ws, r.id, `A-${n}`);
      const { front, why, changes } = am.parsed;
      if (front.applied || front.declined) continue;
      out.push({
        id: r.id,
        amendment: am.aid,
        title: r.title,
        proposed: front.proposed || null,
        by: front.by || null,
        why: firstSentence(why),
        lines: changes.length,
        refuse: await amendmentRefusal(ws, r.id, am.aid),
      });
    }
  }
  return out;
}

// An accept row: what k accept would refuse (why, in its words, as before), the checklist items it would leave open,
// and onlyChecklist when those items are all that stops it, so `k accept <id> --checklist-open "<why>"` would run.
export async function acceptRow(ws, r) {
  let waived = null;
  const why = await refusal(() => approval.accept({ ws, id: r.id, dryRun: true }));
  const withOpen = await refusal(() => (waived = approval.accept({ ws, id: r.id, checklistOpen: 'left open', dryRun: true })));
  // A refusal before the checklist leaves no count from accept: k list's count of unticked lines then.
  const checklistOpen = withOpen === null ? waived.openItems.length : (r.checklist?.open ?? 0);
  return { id: r.id, title: r.title, review: r.review, why, checklistOpen, onlyChecklist: why !== null && withOpen === null };
}

// The tasks k hold would take, of the given rows.
export async function holdable(ws, rows) {
  const out = [];
  for (const r of rows) if ((await refusal(() => approval.hold({ ws, id: r.id, dryRun: true }))) === null) out.push(r);
  return out;
}

// One amendment's line in k waiting's text: at most about 60 characters after the task id.
export function amendmentLine(x, width = 60) {
  const head = ` ${x.amendment}  ${x.lines} line${x.lines === 1 ? '' : 's'}, `;
  let status = 'ready';
  if (x.refuse) {
    const own = x.refuse.startsWith(x.id) ? x.refuse.slice(x.id.length).replace(/^:?\s+/, '') : x.refuse;
    const reason = own.startsWith(`${x.amendment} `) ? own.slice(x.amendment.length + 1) : own;
    const room = width - head.length - 'not yet: '.length;
    status = `not yet: ${reason.length > room ? `${reason.slice(0, room - 1)}…` : reason}`;
  }
  return `  ${x.id}${head}${status}`;
}

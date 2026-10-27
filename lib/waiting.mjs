import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { amendmentName, readAmendment } from './amend.mjs';
import * as approval from './approval.mjs';
import { list as listBugs } from './bugs.mjs';
import { list as listDrafts } from './drafts.mjs';
import { KError } from './errors.mjs';
import { stopNotice, WIDTH } from './notice.mjs';
import { taskPaths } from './workspace.mjs';

// What `k waiting` adds for the mod's pick lists (kirunak-phone S-4): the amendments waiting for the owner, the accept
// rows' checklist, and the tasks k hold can take. Every "would refuse" comes from the verb's own dry run, never from a
// copy of its rules.

// A refusal as one line: its first line, then its listed problems joined by "; ".
export function oneLine(message) {
  const [first, ...rest] = String(message).split('\n').map((l) => l.trim()).filter(Boolean);
  return rest.length ? `${first} ${rest.join('; ')}` : first;
}

// The verb's dry run's refusal, the error itself, or null when it would run.
async function refused(dryRun) {
  try {
    await dryRun();
    return null;
  } catch (e) {
    if (!(e instanceof KError)) throw e;
    return e;
  }
}

// What the verb's dry run refuses, in its words, or null when it would run.
async function refusal(dryRun) {
  return (await refused(dryRun))?.message ?? null;
}

// What `k approve <id> --amendment A-n` would refuse, as one line, or null.
export async function amendmentRefusal(ws, id, aid) {
  const why = await refusal(() => approval.approve({ ws, id, amendment: aid, dryRun: true }));
  return why === null ? null : oneLine(why);
}

const firstSentence = (text) => (/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).trim() || null;

// One row per amendment that is neither applied nor declined, of the given task rows (k list --all's order), A-n in
// order within a task; `title` is the task's, `name` the amendment's own title or, with none, the lines it changes
// (kirunak-phone A-8); `file` is the amendment's absolute path, which the mod's `/k-amendments <n>` reads whole.
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
        name: amendmentName(am.parsed),
        proposed: front.proposed || null,
        by: front.by || null,
        why: firstSentence(why),
        lines: changes.length,
        refuse: await amendmentRefusal(ws, r.id, am.aid),
        file: am.path,
      });
    }
  }
  return out;
}

// An accept row: what k accept would refuse (why, in its words, as before), the checklist items it would leave open,
// and onlyChecklist when those items are all that stops it, so `k accept <id> --checklist-open "<why>"` would run.
// blocking is the files a commit after the review changed, each with that commit and the task it names, as k accept's
// refusal lists them (AC-6), and empty when that is not what stops it.
export async function acceptRow(ws, r) {
  let waived = null;
  const e = await refused(() => approval.accept({ ws, id: r.id, dryRun: true }));
  const why = e?.message ?? null;
  const withOpen = await refusal(() => (waived = approval.accept({ ws, id: r.id, checklistOpen: 'left open', dryRun: true })));
  // A refusal before the checklist leaves no count from accept: k list's count of unticked lines then.
  const checklistOpen = withOpen === null ? waived.openItems.length : (r.checklist?.open ?? 0);
  const blocking = e?.blocking ?? [];
  return { id: r.id, title: r.title, state: r.state, review: r.review, why, blocking, checklistOpen, onlyChecklist: why !== null && withOpen === null };
}

// An accept row's lines under it in k waiting's text: each blocking file, its commit and its task.
export const blockingLines = (x) => (x.blocking ?? []).map((b) => `    ${approval.blockingLine(b)}`);

// The tasks k hold would take, of the given rows.
export async function holdable(ws, rows) {
  const out = [];
  for (const r of rows) if ((await refusal(() => approval.hold({ ws, id: r.id, dryRun: true }))) === null) out.push(r);
  return out;
}

// The bugs that wait (gulnya/kirunak-bugs AC-7), of k bugs' rows, in their order: how many, how many with a fix ready,
// and their ids.
export const bugCounts = (rows) => ({ count: rows.length, ready: rows.filter((r) => r.fixReady).length, ids: rows.map((r) => r.id) });

// The bugs that wait, every repo's, in k bugs' order (a fix ready first).
export const waitingBugs = (ws) => bugCounts(listBugs(ws));

// The one line that names them, first in k waiting, on the board and at a new session's start, naming /k-bugs, where
// the owner reads them and starts one; '' when no bug waits, since then nothing is said at all.
export function bugsLine({ count, ready }) {
  if (!count) return '';
  return `${count} bug${count === 1 ? ' waits' : 's wait'}, ${ready} with a fix ready: /k-bugs`;
}

// The drafts that wait for the owner's intake (kirunak-drafts AC-8), every repo's, in k drafts' order.
export function waitingDrafts(ws) {
  const ids = listDrafts(ws).map((d) => d.id);
  return { count: ids.length, ids };
}

// k waiting's one line for them, naming /k-drafts, where the owner reads and starts them; a zero line as the other
// groups have when nothing waits.
export function draftsLine({ count }) {
  if (!count) return "no draft waits for the owner's intake";
  return `${count} draft${count === 1 ? ' waits' : 's wait'} for the owner's intake: /k-drafts`;
}

// One amendment's line in k waiting's text, `<id> A-n: <name>` then its size and status: at most about 60 characters
// after the task id besides the name.
export function amendmentLine(x, width = 60) {
  const size = `${x.lines} line${x.lines === 1 ? '' : 's'}`;
  const head = ` ${x.amendment}  ${size}, `;
  let status = 'can approve';
  if (x.refuse) {
    const own = x.refuse.startsWith(x.id) ? x.refuse.slice(x.id.length).replace(/^:?\s+/, '') : x.refuse;
    const reason = own.startsWith(`${x.amendment} `) ? own.slice(x.amendment.length + 1) : own;
    const room = width - head.length - 'not yet: '.length;
    status = `not yet: ${reason.length > room ? `${reason.slice(0, room - 1)}…` : reason}`;
  }
  return `  ${x.id} ${x.amendment}: ${x.name}  ${size}, ${status}`;
}

// The group Stopped for you (orchestrator.md §2, E-15): per step k run stopped at for the owner, of the
// given task rows (not done), its notice with the lines indented two spaces, so each stays within 80 characters.
// → [{ id, title, step, kind, lines, one }]
export function stoppedFor(rows) {
  return rows.filter((r) => r.state !== 'done').flatMap((r) => (r.stops ?? []).map((s) => ({ id: r.id, title: r.title, step: s.step, kind: s.kind, ...stopNotice(r, s, WIDTH - 2) })));
}

export function stoppedText(stopped) {
  return ['stopped for you:', ...stopped.flatMap((x) => x.lines.map((l) => `  ${l}`))].join('\n');
}

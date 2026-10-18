import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyAmendment, checkAmendment, readAmendment, refuseIfStamped, stamp } from './amend.mjs';
import { openItems } from './checklist.mjs';
import { refuse, usage } from './errors.mjs';
import { commit, head, isCommitted, log1 } from './git.mjs';
import { kirunakHome } from './home.mjs';
import * as queue from './queue.mjs';
import { amendmentTexts, checkTaskDir, latestReview } from './state.mjs';
import { finalVerdict } from './review.mjs';
import { parseTask, removedIds } from './task.mjs';
import { aspectsOf, taskPaths } from './workspace.mjs';

// The approval record (approval.md §1). The hash is over the exact bytes of task.md.
export function hashBytes(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

export function readRecord(repoRoot, slug) {
  const p = join(repoRoot, 'kirunak', 'approvals', `${slug}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// 'ok' when the record's hash matches task.md, 'stale' when it does not, 'none' with no record.
export function verify(ws, id) {
  const p = taskPaths(ws, id);
  const record = readRecord(p.root, p.slug);
  if (!record) return 'none';
  if (!existsSync(p.task)) return 'stale';
  return record.hash === hashBytes(readFileSync(p.task)) ? 'ok' : 'stale';
}

const pad = (n) => String(n).padStart(2, '0');

// The local date, YYYY-MM-DD: dates in tags and stamps.
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The local time with its offset, 2026-11-05T09:12:00+01:00: times in records.
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${localDate(d)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// One line in $KIRUNAK_HOME/events.jsonl, which the front ends turn into toasts.
export function logEvent(ws, event) {
  const home = ws.home || kirunakHome();
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'events.jsonl'), JSON.stringify(event) + '\n');
}

function existing(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  return p;
}

const listProblems = (problems) => problems.map((x) => `  line ${x.line}: ${x.problem}`).join('\n');

function queuePlaceOf(ws, id) {
  if (!existsSync(ws.queue)) return null;
  const i = queue.read(ws).indexOf(id);
  return i < 0 ? null : i + 1;
}

// `k approve <id> [--amendment A-n]` (approval.md §4): the owner freezes a task, or applies an amendment to it.
export async function approve({ ws, id, amendment, via = 'shell', queuePlace, noQueue, now = new Date() }) {
  const p = existing(ws, id);
  const before = readFileSync(p.task);
  const aspectIds = (await aspectsOf(ws, { id, text: before.toString('utf8') })).map((a) => a.id);
  const record = readRecord(p.root, p.slug);

  const mustBeCommitted = () => {
    if (!isCommitted(p.root, p.rel('task.md'))) {
      throw refuse(`${id}: task.md is not committed; commit the intake first (kirunak: intake ${id})`);
    }
  };

  // Checked before anything is written, so a bad place refuses with nothing changed.
  const willQueue = !noQueue && queuePlaceOf(ws, id) === null;
  const target = queuePlace?.before || queuePlace?.after;
  if (willQueue && target && !queue.read(ws).includes(target)) throw refuse(`${target} is not in the queue`);

  let am = null;
  if (amendment) {
    if (!record) throw refuse(`${id} has no approval yet: approve it first, an amendment changes an approved task`);
    mustBeCommitted();
    if (record.hash !== hashBytes(before)) throw refuse(`${id}: task.md does not match its approval (stale)`);
    am = readAmendment(ws, id, amendment);
    refuseIfStamped(id, am);
    const removed = removedIds(amendmentTexts(p.dir));
    const problems = checkAmendment(before.toString('utf8'), am.text, { removed });
    if (problems.length) throw refuse(`${id} ${am.aid} does not apply:\n${listProblems(problems)}`);
    writeFileSync(p.task, applyAmendment(before.toString('utf8'), am.parsed));
    writeFileSync(am.path, stamp(am.text, `applied: ${localDate(now)}`));
    const after = checkTaskDir(p.dir, aspectIds, id);
    if (after.problems.length) {
      writeFileSync(p.task, before);
      writeFileSync(am.path, am.text);
      throw refuse(`${id} with ${am.aid} applied fails k check:\n${listProblems(after.problems)}`);
    }
  } else {
    if (record) {
      const why = record.hash === hashBytes(before) ? `already approved on ${record.approved}` : 'task.md changed after approval';
      throw refuse(`${id}: ${why}; a change goes through an amendment (k approve ${id} --amendment A-n)`);
    }
    const { parsed, problems } = checkTaskDir(p.dir, aspectIds, id);
    const open = parsed ? parsed.sections.q.filter((x) => x.id) : [];
    if (open.length) {
      const names = open.map((x) => x.id).join(', ');
      throw refuse(`${id}: ${names} ${open.length > 1 ? 'are' : 'is'} open; a task with an open question cannot be approved`);
    }
    if (problems.length) throw refuse(`${id} fails k check:\n${listProblems(problems)}`);
    mustBeCommitted();
  }

  const hash = hashBytes(readFileSync(p.task));
  const approved = isoLocal(now);
  const entry = { hash, approved, amendment: am ? am.aid : null };
  const next = {
    task: id,
    hash,
    approved,
    by: 'owner',
    via,
    commit: log1(p.root, p.rel('task.md')),
    history: [...(record?.history || []), entry],
  };
  mkdirSync(dirname(p.record), { recursive: true });
  writeFileSync(p.record, JSON.stringify(next, null, 2) + '\n');
  const paths = [p.rel('task.md'), p.recordRel, ...(am ? [am.rel] : [])];
  const message = `kirunak: approve ${id}${am ? ` amendment ${am.aid}` : ''}`;
  const sha = commit(p.root, paths, message, { KIRUNAK_APPROVING: id });

  if (willQueue) queue.add(ws, id, queuePlace || {});
  logEvent(ws, { time: approved, kind: 'approved', task: id, amendment: entry.amendment });
  return { hash, commit: sha, state: 'ready', queuePlace: queuePlaceOf(ws, id) };
}

// `k accept <id>` (approval.md §4, review.md §3): the owner's acceptance record. It refuses without the latest
// review's verdict, and while an item the owner checks is unticked (in checklist.md, or a row of that review with
// no item yet) unless the owner passes checklistOpen, the reason done.json records.
export function accept({ ws, id, checklistOpen, via = 'shell', now = new Date() }) {
  const p = existing(ws, id);
  const done = join(p.dir, 'done.json');
  if (existsSync(done)) throw refuse(`${id} is already accepted`);
  const v = verify(ws, id);
  if (v === 'none') throw refuse(`${id} was never approved: k approve ${id} first`);
  if (v === 'stale') throw refuse(`${id}: task.md does not match its approval (stale)`);
  const open = checklistOpen == null ? '' : String(checklistOpen).replace(/\s+/g, ' ').trim();
  if (checklistOpen != null && !open) throw usage('--checklist-open needs its reason');
  const review = latestReview(p.dir);
  if (!review) throw refuse(`${id} has no review verdict: the plan's review step writes ${p.rel('review.md')}`);
  if (!finalVerdict(review.text)) throw refuse(`${id} has no review verdict: the last line of ${p.rel(review.file)} is not verdict: met, not met (<ids>) or needs owner (<ids>)`);
  if (!open) {
    const left = openItems(p, review, parseTask(readFileSync(p.task, 'utf8')));
    const lines = [...left.unticked, ...left.missing].map((t) => `  - [ ] ${t}`).join('\n');
    if (left.missing.length) {
      throw refuse(`${id}: ${left.unticked.length + left.missing.length} unticked item(s), ${left.missing.length} not in checklist.md yet (k checklist ${id} writes them from ${review.file}):\n${lines}`);
    }
    if (left.unticked.length) throw refuse(`${id}: checklist.md has ${left.unticked.length} unticked item(s):\n${lines}`);
  }
  const accepted = isoLocal(now);
  const record = { task: id, accepted, by: 'owner', via, commit: head(p.root), ...(open ? { checklistOpen: open } : {}) };
  writeFileSync(done, JSON.stringify(record, null, 2) + '\n');
  const sha = commit(p.root, [p.rel('done.json')], `kirunak: accept ${id}`, { KIRUNAK_ACCEPTING: id });
  if (queuePlaceOf(ws, id) !== null) queue.remove(ws, id);
  logEvent(ws, { time: accepted, kind: 'accepted', task: id });
  return { commit: sha, state: 'done' };
}

// `k hold <id> --why "<why>"`: hold.md says why and since when; the task keeps its queue place.
export function hold({ ws, id, why, now = new Date() }) {
  const p = existing(ws, id);
  const reason = String(why ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) throw usage('a hold needs its reason: --why "<why>"');
  if (existsSync(join(p.dir, 'done.json'))) throw refuse(`${id} is done`);
  const file = join(p.dir, 'hold.md');
  if (existsSync(file)) throw refuse(`${id} is already on hold`);
  writeFileSync(file, `# On hold: ${id}\n\nHeld ${localDate(now)}: ${reason}\n`);
  const sha = commit(p.root, [p.rel('hold.md')], `kirunak: hold ${id}`, { KIRUNAK_HOLDING: id });
  return { commit: sha, state: 'on hold' };
}

// `k resume <id>`: deletes hold.md.
export function resume({ ws, id }) {
  const p = existing(ws, id);
  const file = join(p.dir, 'hold.md');
  if (!existsSync(file)) throw refuse(`${id} is not on hold`);
  rmSync(file);
  const sha = commit(p.root, [p.rel('hold.md')], `kirunak: resume ${id}`, { KIRUNAK_HOLDING: id });
  return { commit: sha };
}

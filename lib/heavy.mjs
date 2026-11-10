import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from './plan.mjs';
import { events } from './steps.mjs';
import { readSession } from './keeper.mjs';
import { kirunakHome } from './home.mjs';
import { taskPaths } from './workspace.mjs';

// `k heavy`: the heavy queue at a glance (gulnya/k-queue). The rows are built from the resourceGuard seam's queue()
// (plugins.md §2) as it gives them: `waiting` is already in the order the guard will serve it, and nothing here ranks,
// drops or reorders a job (AC-10). The clock is queue()'s `now`, so a fixed object gives fixed rows.
//
// rows(q, { ws, home }) → { now: 'HH:MM', clear: 'HH:MM' | null, held: row | null, waiting: [row] }
//   row: { task, id, session, what, length, left?, over?, ends, step } (left/over on the held row only; the cells as
//   the tables show them, so --json and the tables are the same rows)

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const pad = (x) => String(x).padStart(2, '0');
export const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 40m, 1h, 1h20m: whole minutes, a length above nothing at least 1m.
export const span = (minutes) => {
  const m = minutes > 0 ? Math.max(1, Math.round(minutes)) : 0;
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`;
};

// AC-5: the stated length bare, else the guard's usual with ≈, else the max with ≤; with none, unknown.
export function lengthOf(job) {
  if (job.expectMinutes > 0) return { minutes: job.expectMinutes, mark: '' };
  if (job.usualMinutes > 0) return { minutes: job.usualMinutes, mark: '≈' };
  if (job.maxMinutes > 0) return { minutes: job.maxMinutes, mark: '≤' };
  return { minutes: null, mark: '' };
}
const shown = (l) => (l.minutes == null ? '?' : `${l.mark}${span(l.minutes)}`);

const STEP = /^(S-[A-Za-z0-9-]+):/;
const NAME_MAX = 28;
const short = (what) => {
  const w = String(what ?? '').replace(/\s+/g, ' ').trim() || 'a job';
  return w.length > NAME_MAX ? `${w.slice(0, NAME_MAX - 1).trimEnd()}…` : w;
};

// The task a job is for, and the step it names: a `kirunak:<id>` session is k run's (its what starts `S-n:`), a
// Claude session maps through the record `k start --session` writes; with neither, no task (E-4).
function taskOf(job, home) {
  const k = /^kirunak:(.+)$/.exec(job.session ?? '');
  if (k) return { id: k[1], step: STEP.exec(job.what ?? '')?.[1] ?? null };
  let rec = null;
  try {
    rec = readSession(home, job.session);
  } catch {}
  return rec?.task ? { id: rec.task, step: rec.step ?? null } : null;
}

// Start to finish of each finished run of a step: from its last `started` before each `finished`.
function durations(evs) {
  const started = new Map();
  const out = new Map();
  for (const e of evs) {
    const at = new Date(`${e.date}T${e.time}`).getTime();
    if (e.verb === 'started') started.set(e.step, at);
    else if (e.verb === 'finished' && started.has(e.step)) {
      out.set(e.step, [...(out.get(e.step) || []), (at - started.get(e.step)) / 60000]);
      started.delete(e.step);
    }
  }
  return out;
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// AC-7, AC-8, E-5: `<n>/<all> (<time>)`. all is every step of plan.md once ([owner] steps too); n the job's step's
// place; the time adds each later unfinished step but the owner's, at the median of the task's own finished steps of
// its kind, and is `?` when a kind has none.
export function stepCell(ws, id, named) {
  let p;
  try {
    p = taskPaths(ws, id);
  } catch {
    return '?';
  }
  const planText = read(join(p.dir, 'plan.md'));
  if (planText === null) return '?';
  const steps = [];
  for (const s of parsePlan(planText).steps) if (!steps.some((x) => x.id === s.id)) steps.push(s);
  const evs = events(read(join(p.dir, 'progress.md')) ?? '');
  const last = new Map();
  for (const e of evs) if (e.verb === 'started' || e.verb === 'finished') last.set(e.step, e.verb);
  const finished = (sid) => last.get(sid) === 'finished';
  const step = named ?? [...evs].reverse().find((e) => e.verb === 'started' && !finished(e.step))?.step ?? null;
  const at = steps.findIndex((s) => s.id === step);
  if (at < 0) return `?/${steps.length} (?)`;
  const took = durations(evs);
  const byKind = new Map();
  for (const s of steps) for (const m of took.get(s.id) || []) byKind.set(s.kind, [...(byKind.get(s.kind) || []), m]);
  let minutes = 0;
  for (const s of steps.slice(at + 1)) {
    if (s.kind === 'owner' || finished(s.id)) continue;
    const like = byKind.get(s.kind);
    if (!like?.length) return `${at + 1}/${steps.length} (?)`;
    minutes += median(like);
  }
  return `${at + 1}/${steps.length} (${minutes > 0 ? `≈${span(minutes)}` : '0m'})`;
}

export function rows(q, { ws, home = ws?.home || kirunakHome() } = {}) {
  const now = Number.isFinite(Date.parse(q?.now)) ? Date.parse(q.now) : Date.now();
  const base = (job) => {
    const t = taskOf(job, home);
    const length = lengthOf(job);
    return {
      task: t ? t.id.replace(/^[^/]*\//, '') : short(job.what),
      id: t?.id ?? null,
      session: job.session ?? null,
      what: job.what ?? null,
      length: shown(length),
      minutes: length.minutes,
      mark: length.mark,
      step: t ? stepCell(ws, t.id, t.step) : '–',
    };
  };
  let end = now;
  let known = true;
  let held = null;
  if (q?.held) {
    held = base(q.held);
    const since = Number.isFinite(Date.parse(q.held.since)) ? Date.parse(q.held.since) : now;
    if (held.minutes == null) {
      known = false;
      held.left = '?';
    } else {
      const due = since + held.minutes * 60000;
      // E-1: past its length the job shows how far over, and its end becomes now, moving every job after it.
      if (due < now) held.left = `${span((now - due) / 60000)} over`;
      else held.left = `${held.mark}${span((due - now) / 60000)}`;
      end = Math.max(due, now);
    }
    held.ends = known ? clock(end) : '?';
  }
  const waiting = (q?.waiting || []).map((job) => {
    const r = base(job);
    if (r.minutes == null) known = false;
    else end += r.minutes * 60000;
    r.ends = known ? clock(end) : '?';
    return r;
  });
  const tidy = ({ minutes, mark, ...r }) => r;
  return {
    now: clock(now),
    clear: q?.held || waiting.length ? (known ? clock(end) : null) : clock(now),
    held: held && tidy(held),
    waiting: waiting.map(tidy),
  };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const table = (head, lines) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...lines.map((l) => `| ${l.map(cell).join(' | ')} |`)].join('\n');

// AC-1 to AC-4, E-2, E-3: the first line, the Now table, the Next table; no percent, status, place number or emoji.
export function text(r) {
  if (!r.held && !r.waiting.length) return 'Heavy queue free';
  const out = [`${r.now} now, the queue clear ${r.clear ? `by ${r.clear}` : 'at a time not known'}`];
  if (r.held) out.push('', '**Now**', '', table(['Task', 'Left', 'Ends', 'Step'], [[r.held.task, r.held.left, r.held.ends, r.held.step]]));
  if (r.waiting.length) out.push('', '**Next**', '', table(['Task', 'Takes', 'Ends', 'Step'], r.waiting.map((w) => [w.task, w.length, w.ends, w.step])));
  return out.join('\n');
}

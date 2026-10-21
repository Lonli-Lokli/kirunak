import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kirunakHome } from './home.mjs';
import { STATES } from './state.mjs';

// What the board shows, in the order every surface shows it (boards.md §2, §3): the page (lib/board.mjs) and the
// chat's markdown (lib/board-md.mjs) only lay it out.

const WEEK = 7 * 24 * 3600 * 1000;
const STATE_TITLE = { done: 'done this week' };
export const STALE = 'stale: task.md does not match its approval';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// The sessions whose record names a task (`k start` writes { task, step, since } into sessions/<id>.json, the record
// `k status --session` reads), for the board's first section.
export function sessions(ws) {
  const dir = join(ws.home || kirunakHome(), 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ ...readJson(join(dir, f)), id: f.slice(0, -'.json'.length) }))
    .filter((s) => typeof s.task === 'string' && s.task)
    .map((s) => ({ id: s.id, task: s.task, step: s.step ?? null, since: s.since ?? null }));
}

const p2 = (n) => String(n).padStart(2, '0');
export const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const when = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? stamp(new Date(iso)) : String(iso ?? '?'));

// A queued guard job: a JSON line { session, what } in the guard's queue file, or the line as it is.
function guardJob(line) {
  try {
    const j = JSON.parse(line);
    if (j && typeof j === 'object') return `${j.what ?? 'a job'} (session ${j.session ?? '?'})`;
  } catch {}
  return line;
}

// The board in the order every surface shows it (AC-5): the tasks sessions are working on (named by a session's
// record or a running step), then every other task by state in lib/state.mjs's order (done ones for a week after
// their acceptance), then the lock, its queue and the running steps. `st` is status() with `sessions` beside it.
export function model(list, st, now = new Date()) {
  const who = new Map();
  const add = (task, line) => task && (who.get(task) ?? who.set(task, []).get(task)).push(line);
  for (const s of st?.sessions ?? []) add(s.task, `session ${s.id}${s.since ? ` since ${when(s.since)}` : ''}`);
  for (const r of st?.running ?? []) add(r.task, `step ${r.step ?? '?'} running${r.since ? ` since ${when(r.since)}` : ''}`);
  const shown = list.filter((r) => !(r.state === 'done' && r.accepted && now - Date.parse(r.accepted) > WEEK));
  const working = shown.filter((r) => who.has(r.id) && r.state !== 'done').map((r) => ({ ...r, who: who.get(r.id) }));
  const rest = shown.filter((r) => !working.some((w) => w.id === r.id));
  const states = STATES.map((state) => ({ title: STATE_TITLE[state] ?? state, rows: rest.filter((r) => r.state === state) }));
  const running = st?.running ?? [];
  return {
    made: stamp(now),
    working,
    states: states.filter((s) => s.rows.length),
    lock: st?.lock ? `lock: ${st.lock.what ?? 'a job'} (session ${st.lock.session ?? '?'}, since ${when(st.lock.since)})` : 'no lock',
    machine: [
      { title: 'Heavy-job queue', ordered: true, rows: (st?.queue ?? []).map(guardJob), empty: 'empty' },
      {
        title: `Running steps: ${running.length} of ${st?.maxAgents ?? 2}`,
        rows: running.map((s) => `${s.task ?? '?'} ${s.step ?? '?'}${s.session ? `, session ${s.session}` : ''}${s.since ? `, since ${when(s.since)}` : ''}`),
        empty: 'none',
      },
      { title: 'Device claims', rows: (st?.claims ?? []).map((c) => `${c.resource} by ${c.by}${c.why ? ` (${c.why})` : ''}`), empty: 'none' },
      { title: 'Task queue', ordered: true, rows: list.filter((r) => r.queue).sort((a, b) => a.queue - b.queue).map((r) => `${r.id} (${r.state})`), empty: 'empty' },
    ],
  };
}

// A card's lines under its id and title, as text: the state first, then where the task is.
export function facts(r) {
  return [
    `state: ${r.state}${r.queue ? `, queue place ${r.queue}` : ''}`,
    r.state === 'stale' ? STALE : null,
    r.step ? `step: ${r.step.replace(/ sha256:[0-9a-f]{64}/, '')}` : null,
    r.who?.length ? `worked on by ${r.who.join('; ')}` : null,
    r.lock && r.state === 'in progress' ? `lock: ${r.lock}` : null,
    r.review ? `review: ${r.review.file}, ${r.review.verdict ? `verdict: ${r.review.verdict}` : 'no verdict yet'}` : null,
    r.checklist ? `checklist: ${r.checklist.open} open, ${r.checklist.ticked} ticked` : null,
    r.approved ? `approved ${String(r.approved).slice(0, 10)}` : null,
    r.accepted ? `accepted ${String(r.accepted).slice(0, 10)}` : null,
  ].filter(Boolean);
}

// Every AC and E with its latest verdict in words: met, not met, needs device, needs owner, or none.
export const items = (r) => [...(r.ac || []), ...(r.e || [])].map((x) => ({ id: x.id, verdict: x.verdict || 'none', text: x.text }));

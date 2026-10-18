import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecord } from './approval.mjs';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import { read as readQueue } from './queue.mjs';
import { latestReview, stateOf } from './state.mjs';
import { parseTask } from './task.mjs';
import { allTaskIds, aspectsOf, parseId, taskPaths } from './workspace.mjs';

// The list (boards.md §1): one row per task, queued tasks in queue order first, then the rest by id.
// Reads a few files per task and runs no git command.

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const readJson = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};

// The last `S-n started|finished|failed` line of progress.md.
export function lastStep(progressText) {
  if (!progressText) return null;
  const hits = progressText.split('\n').filter((l) => /\bS-[\w-]+ (started|finished|failed)\b/.test(l));
  return hits.length ? hits[hits.length - 1].trim() : null;
}

// { AC-1: 'met', E-2: 'needs device', ... } from a review's table rows.
export function verdictsOf(reviewText) {
  const out = {};
  for (const line of (reviewText || '').split('\n')) {
    const m = /^\|\s*((?:AC|E)-\d+)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function checklistCounts(text) {
  if (text === null) return null;
  return { open: (text.match(/^\s*- \[ \]/gm) || []).length, ticked: (text.match(/^\s*- \[[xX]\]/gm) || []).length };
}

function row(ws, id, aspectIds, place, lock) {
  const p = taskPaths(ws, id);
  const text = readFileSync(p.task, 'utf8');
  const parsed = parseTask(text);
  const record = readRecord(p.root, p.slug);
  const isDone = (other) => {
    try {
      return existsSync(join(taskPaths(ws, other).dir, 'done.json'));
    } catch {
      return false;
    }
  };
  const state = stateOf({ taskDir: p.dir, record, aspectIds, isDone, id });
  const review = latestReview(p.dir);
  const verdictLine = review && /^verdict:\s*(.*)$/m.exec(review.text);
  const verdicts = verdictsOf(review?.text);
  const items = (key) => parsed.sections[key].filter((x) => x.id).map((x) => ({ id: x.id, text: x.body ?? x.text, verdict: verdicts[x.id] ?? null }));
  const done = state === 'done' ? readJson(join(p.dir, 'done.json')) : null;
  return {
    id,
    repo: p.repo,
    title: parsed.front.title || p.slug,
    state,
    queue: place,
    step: lastStep(read(join(p.dir, 'progress.md'))),
    lock,
    approved: record?.approved ?? null,
    review: review ? { file: review.file, verdict: verdictLine ? verdictLine[1].trim() : null } : null,
    checklist: checklistCounts(read(join(p.dir, 'checklist.md'))),
    accepted: done?.accepted ?? null,
    paths: {
      task: p.task,
      plan: join(p.dir, 'plan.md'),
      review: join(p.dir, review ? review.file : 'review.md'),
      checklist: join(p.dir, 'checklist.md'),
    },
    ac: items('ac'),
    e: items('e'),
  };
}

const exists = (ws, id) => {
  try {
    parseId(id);
    return existsSync(taskPaths(ws, id).task);
  } catch {
    return false;
  }
};

// rows(ws, { repo, all }) → [{ id, title, state, queue, step, lock, approved, review, checklist, accepted, repo, paths, ac, e }]
export async function rows(ws, { repo = null, all = false } = {}) {
  if (repo && !ws.repos.some((r) => r.name === repo)) {
    throw refuse(`unknown repo ${repo}: the workspace lists ${ws.repos.map((r) => r.name).join(', ')}`);
  }
  const aspectIds = (await aspectsOf(ws)).map((a) => a.id);
  const queue = existsSync(ws.queue) ? readQueue(ws) : [];
  const lock = readJson(join(ws.home || kirunakHome(), 'guard', 'lock', 'owner.json'))?.what ?? null;
  const queued = queue.filter((id, i) => exists(ws, id) && queue.indexOf(id) === i);
  const rest = allTaskIds(ws).filter((id) => !queued.includes(id)).sort();
  const out = [];
  for (const id of [...queued, ...rest]) {
    if (repo && parseId(id).repo !== repo) continue;
    const place = queue.indexOf(id);
    const r = row(ws, id, aspectIds, place < 0 ? null : place + 1, lock);
    if (!all && (r.state === 'done' || r.state === 'on hold')) continue;
    out.push(r);
  }
  return out;
}

function detail(r) {
  const parts = [];
  if (r.state === 'done') return r.accepted ? String(r.accepted).slice(0, 10) : '';
  if (r.step) parts.push(r.step.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, ''));
  if (r.lock && (r.state === 'in progress' || r.state === 'blocked')) parts.push(`lock: ${r.lock}`);
  if (r.review?.verdict) parts.push(`verdict: ${r.review.verdict}`);
  if (r.checklist?.open) parts.push(`checklist ${r.checklist.open} open`);
  if (r.state === 'stale') parts.push('task.md does not match its approval');
  return parts.join(', ');
}

// The terminal text of boards.md §1: place, state, id, title, then where the task is.
export function format(list) {
  if (!list.length) return 'no tasks';
  const width = (f) => Math.max(...list.map(f).map((s) => s.length));
  const wState = width((r) => r.state);
  const wId = width((r) => r.id);
  const wTitle = Math.min(48, width((r) => r.title));
  const cut = (s) => (s.length > wTitle ? s.slice(0, wTitle - 3) + '...' : s);
  return list
    .map((r) => {
      const place = r.queue ? String(r.queue).padStart(2) : '  ';
      return `${place}  ${r.state.padEnd(wState)}  ${r.id.padEnd(wId)}  ${cut(r.title).padEnd(wTitle)}  ${detail(r)}`.trimEnd();
    })
    .join('\n');
}

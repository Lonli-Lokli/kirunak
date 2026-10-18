import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate, verify } from './approval.mjs';
import { refuse } from './errors.mjs';
import { checkPlan, inputPath, NAMED_INPUTS, parsePlan } from './plan.mjs';
import * as queue from './queue.mjs';
import { parseTask } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// The step lifecycle (orchestrator.md §2, R9): pending → ready → running → done, or failed; a run that wrote
// needs.json waits for a heavy job or the owner. Nothing is stored but what happened, the lines of progress.md and
// the files under steps/<step>/, and every state is computed from them on each pass.

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const pad = (x) => String(x).padStart(2, '0');
const stamp = (d) => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const EVENT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (S-[A-Za-z0-9-]+) (started|finished|failed|escalated|waiting|resumed|heavy)\b:? ?(.*)$/;

export const stepDir = (p, step) => join(p.dir, 'steps', step);

// One line in progress.md: `2026-11-03 14:02 S-2 started (opus, session 7c1…)`.
export function note(p, step, text, now = new Date()) {
  appendFileSync(join(p.dir, 'progress.md'), `${stamp(now)} ${step} ${text}\n`);
}

export function events(progressText) {
  return (progressText || '').split('\n').map((l) => EVENT.exec(l)).filter(Boolean).map((m) => ({ date: m[1], time: m[2], step: m[3], verb: m[4], rest: m[5] }));
}

// A step's history: its last outcome (started, finished, failed) and its failures since the last escalation.
export function historyOf(progressText, step) {
  let last = null;
  let failures = 0;
  for (const e of events(progressText).filter((x) => x.step === step)) {
    if (e.verb === 'started' || e.verb === 'finished') last = e.verb;
    else if (e.verb === 'failed') [last, failures] = ['failed', failures + 1];
    else if (e.verb === 'escalated') failures = 0;
  }
  return { last, failures };
}

// needs.json (orchestrator.md §2): { heavy: { what, command: [argv], maxMinutes }, then: 'resume' } or { owner }.
export function readNeeds(dir) {
  const text = read(join(dir, 'needs.json'));
  if (text === null) return null;
  let n;
  try {
    n = JSON.parse(text);
  } catch (e) {
    return { error: `needs.json is not JSON: ${e.message}` };
  }
  const h = n?.heavy;
  if (h) {
    const ok = typeof h.what === 'string' && Array.isArray(h.command) && h.command.length && h.command.every((x) => typeof x === 'string') && h.maxMinutes > 0;
    return ok ? { heavy: h } : { error: 'needs.json heavy wants { what, command: [argv], maxMinutes }' };
  }
  if (typeof n?.owner === 'string' && n.owner.trim()) return { owner: n.owner.trim() };
  return { error: 'needs.json holds neither heavy nor owner' };
}

const inputExists = (p, input) => NAMED_INPUTS.includes(input) || existsSync(inputPath(p, input));
export const missingOutputs = (p, s) => s.outputs.filter((o) => !existsSync(join(p.dir, o)));

// Map step id → { state, why?, retry?, needs? }: pending, ready, running, waiting-heavy, waiting-owner, done,
// failed (twice, not marked yet) or escalated (marked [escalate] in plan.md).
export function stepStates(p, plan, progressText) {
  const out = new Map();
  for (const s of plan.steps) {
    const h = historyOf(progressText, s.id);
    if (h.last === 'finished') out.set(s.id, { state: 'done' });
    else if (s.escalate) out.set(s.id, { state: 'escalated' });
    else if (h.last === 'started') {
      const needs = readNeeds(stepDir(p, s.id));
      if (needs?.heavy) out.set(s.id, { state: 'waiting-heavy', needs });
      else if (needs?.owner) out.set(s.id, { state: 'waiting-owner', needs });
      else out.set(s.id, { state: 'running' });
    } else if (h.failures >= 2) out.set(s.id, { state: 'failed', why: `failed ${h.failures} times` });
    else {
      const waits = s.needs.filter((n) => out.get(n)?.state !== 'done').map((n) => `${n} is not done`);
      const missing = s.inputs.filter((i) => !inputExists(p, i)).map((i) => `${i} does not exist`);
      const why = [...waits, ...missing];
      out.set(s.id, why.length ? { state: 'pending', why: why.join(', ') } : { state: 'ready', retry: h.last === 'failed' });
    }
  }
  return out;
}

// The task, its plan and its step states, read afresh.
export function load(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  const planText = read(join(p.dir, 'plan.md'));
  if (planText === null) throw refuse(`${id} has no plan: ${p.rel('plan.md')}`);
  const plan = parsePlan(planText);
  const task = parseTask(readFileSync(p.task, 'utf8'));
  const progress = read(join(p.dir, 'progress.md')) ?? '';
  return { ws, id, p, plan, task, progress, states: stepStates(p, plan, progress) };
}

// Why the task cannot run a step now: approved and unchanged, queued, not on hold or done, a plan that passes
// its check, nothing it is blocked by (task-files.md §4, §6).
export function gate(t) {
  const { ws, id, p } = t;
  const out = [];
  const v = verify(ws, id);
  if (v !== 'ok') out.push(v === 'none' ? `${id} is not approved` : `${id}: task.md does not match its approval (stale)`);
  if (existsSync(join(p.dir, 'done.json'))) out.push(`${id} is done`);
  if (existsSync(join(p.dir, 'hold.md'))) out.push(`${id} is on hold`);
  if (!existsSync(ws.queue) || !queue.read(ws).includes(id)) out.push(`${id} is not in the queue`);
  for (const x of checkPlan(t.plan, t.task, p)) out.push(`plan.md line ${x.line}: ${x.problem}`);
  for (const b of t.plan.front.blockedBy) {
    if (b.startsWith('owner')) out.push(`blocked by the owner: ${b}`);
    else if (!existsSync(join(taskPaths(ws, b).dir, 'done.json'))) out.push(`blocked by ${b}, which is not done`);
  }
  return out;
}

export function stepOf(t, step) {
  const s = t.plan.steps.find((x) => x.id === step);
  if (!s) throw refuse(`${t.id} has no step ${step} in plan.md`);
  return s;
}

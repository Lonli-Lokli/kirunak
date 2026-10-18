import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { localDate, logEvent, readRecord, verify } from './approval.mjs';
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

const TEMPLATE = new URL('../templates/brief.md', import.meta.url);

// The next free number k of steps/<step>/<prefix>-<k>.<ext>.
export function nextIndex(dir, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)\\.`);
  const ks = existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)?.[1]).filter(Boolean).map(Number) : [];
  return ks.length ? Math.max(...ks) + 1 : 1;
}

// `k step brief <id> S-n`: the brief from templates/brief.md, at the plan's `brief:` path or steps/S-n/brief.md:
// the Goal and the AC, E and D lines the step covers, quoted from the frozen file, the inputs and outputs with
// their paths from the repo root (the run's cwd), and the rules.
export function brief({ ws, id, step, extraInputs = [] }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const { p, task } = t;
  const rel = (abs) => relative(p.root, abs);
  const sd = rel(stepDir(p, step));
  const all = s.covers.includes('all');
  const covered = [...task.sections.ac, ...task.sections.e, ...task.sections.d].filter((x) => x.id && (all || s.covers.includes(x.id)));
  const input = (i) => (i === 'task' ? `- task: ${p.rel('task.md')}` : i === 'diff' ? `- diff: ${sd}/diff.patch` : `- ${rel(inputPath(p, i))}`);
  const fill = {
    id, step, title: s.title, calls: { ...ws.budget, ...s.budget }.calls ?? 100, stepDir: sd, evidenceDir: p.rel('evidence'),
    goal: task.sections.goal.map((x) => x.raw).join('\n\n') || '(no goal)',
    lines: covered.map((x) => `- ${x.raw}`).join('\n') || '(none)',
    inputs: [...s.inputs.map(input), ...extraInputs.map((x) => `- ${x} (the last attempt failed: read why first)`)].join('\n') || '(none)',
    outputs: s.outputs.map((o) => `- ${p.rel(o)}`).join('\n') || '(none)',
  };
  const text = readFileSync(TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  const path = join(p.dir, s.brief || `steps/${step}/brief.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

// Every session id the task's steps ran, by step: from their run records and their `session <id>` lines.
export function sessionsByStep(t) {
  const out = new Map();
  const add = (step, sid) => sid && (out.get(step) || out.set(step, new Set()).get(step)).add(sid);
  for (const s of t.plan.steps) {
    const dir = stepDir(t.p, s.id);
    for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /^(run|keep)-\d+\.json$/.test(x)) : []) {
      try {
        add(s.id, JSON.parse(readFileSync(join(dir, f), 'utf8')).session_id);
      } catch {}
    }
  }
  for (const e of events(t.progress)) add(e.step, /\bsession ([A-Za-z0-9._-]+)/.exec(e.rest)?.[1]);
  return out;
}

// `k step start <id> S-n`: refuses a task that may not run, a step that is not ready, and a review step whose
// session is one another step ran (review.md §1); writes steps/S-n/diff.patch when `diff` is an input, and the
// `started` line. The orchestrator then starts the runner; a session working by hand just works.
export async function start({ ws, id, step, session = null, label = null, now = new Date() }) {
  const t = load(ws, id);
  const problems = gate(t);
  if (problems.length) throw refuse(`${id} cannot run a step:\n${problems.map((x) => `  ${x}`).join('\n')}`);
  const s = stepOf(t, step);
  const st = t.states.get(step);
  if (st.state !== 'ready') throw refuse(`${id} ${step} is ${st.state}${st.why ? `: ${st.why}` : ''}`);
  if (s.kind === 'review' && session) {
    for (const [other, ids] of sessionsByStep(t)) {
      if (other !== step && ids.has(session)) throw refuse(`${id} ${step} is a review: it runs in a fresh conversation, and session ${session} is ${other}'s`);
    }
  }
  mkdirSync(stepDir(t.p, step), { recursive: true });
  if (s.inputs.includes('diff')) {
    const base = readRecord(t.p.root, t.p.slug).commit;
    const head = await ws.seams.storage.head(t.p.root);
    writeFileSync(join(stepDir(t.p, step), 'diff.patch'), await ws.seams.storage.diff(t.p.root, base, head));
  }
  note(t.p, step, `started (${label || (session ? `session ${session}` : 'by hand')})`, now);
  return { t, s };
}

// `k step finish <id> S-n`: every output present, then the `finished` line.
export function finish({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const missing = missingOutputs(t.p, s);
  if (missing.length) throw refuse(`${id} ${step} has not written ${missing.join(', ')}`);
  note(t.p, step, 'finished', now);
  return { state: 'done' };
}

// `k step fail <id> S-n --why`: the `failed` line and steps/S-n/failure-<n>.md, the report a retry reads. A second
// failure marks the step [escalate] in plan.md, with models.escalate when the workspace names one.
export function fail({ ws, id, step, why, detail = '', now = new Date() }) {
  const t = load(ws, id);
  stepOf(t, step);
  if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const reason = String(why ?? '').replace(/\s+/g, ' ').trim() || 'no reason given';
  const dir = stepDir(t.p, step);
  mkdirSync(dir, { recursive: true });
  const report = join(dir, `failure-${nextIndex(dir, 'failure')}.md`);
  writeFileSync(report, `# ${id} ${step} failed\n\n${stamp(now)}: ${reason}\n${detail ? `\n${detail.trim()}\n` : ''}`);
  note(t.p, step, `failed: ${reason}`, now);
  const failures = historyOf(read(join(t.p.dir, 'progress.md')), step).failures;
  return { report, failures, escalated: failures >= 2 ? escalate({ ws, id, step, now }) : null };
}

export function escalate({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const to = ws.models?.escalate;
  const what = to ? [to.model, to.effort].filter(Boolean).join(', ') : '';
  const planFile = join(t.p.dir, 'plan.md');
  const lines = readFileSync(planFile, 'utf8').split('\n');
  lines[s.line - 1] = `${lines[s.line - 1].trimEnd()} [escalate${what ? `: ${what}` : ''}]`;
  writeFileSync(planFile, lines.join('\n'));
  note(t.p, step, `escalated${what ? `: ${what}` : ''}`, now);
  logEvent(ws, { time: now.toISOString(), kind: 'escalate', task: id, step, to: to || null });
  return { model: to?.model ?? null, effort: to?.effort ?? null };
}

// steps/S-n/run-<k>.json: the runner's whole JSON result (orchestrator.md §3).
export function saveRun(p, step, result) {
  const dir = stepDir(p, step);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-${nextIndex(dir, 'run')}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  return path;
}

// steps/S-n/heavy-<k>.json beside the job's whole log: the exit code, the minutes, the log's path, its last 60 lines.
export function saveHeavy(p, step, { what, command, exitCode, minutes, log }) {
  const dir = stepDir(p, step);
  mkdirSync(dir, { recursive: true });
  const k = nextIndex(dir, 'heavy');
  const logPath = join(dir, `heavy-${k}.log`);
  writeFileSync(logPath, log || '');
  const record = { what, command, exitCode, minutes, report: relative(p.root, logPath), lastLines: String(log || '').replace(/\n$/, '').split('\n').slice(-60) };
  const path = join(dir, `heavy-${k}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return { k, path, record };
}

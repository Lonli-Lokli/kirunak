import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { OWN_START } from '../plugins/resource-guard-local.mjs';
import { hashBytes, localDate, logEvent, verify } from './approval.mjs';
import { refuse } from './errors.mjs';
import { runFields } from './cost.mjs';
import { approvals, filesDiff, ownChange } from './change.mjs';
import { changedUnder, commit, isAncestor, succeeds } from './git.mjs';
import { otherRepos, repoLines } from './other-repos.mjs';
import { expand, real, tilde } from './repos-md.mjs';
import { above, attemptsOf, buildRungFor, DEFAULT_LADDER, modeOf, rungOf } from './ladder.mjs';
import { checkPlan, inputPath, NAMED_INPUTS, parsePlan } from './plan.mjs';
import * as queue from './queue.mjs';
import * as review from './review.mjs';
import { parseTask } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// The step lifecycle (orchestrator.md §2, R9): pending → ready → running → done, or failed; a run that wrote
// needs.json waits for a heavy job or the owner. Nothing is stored but what happened, the lines of progress.md and
// the files under steps/<step>/, and every state is computed from them on each pass.

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
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

// progress.md's lifecycle lines in file order (orchestrator.md §5, R1.1): after each, `active` holds the steps whose
// last line is `started` or `resumed` and whose last `started` line names an id of `sessions`. `paused(step)` says
// whether it wrote needs.json under `dir` (asked only of the steps in question, once each). `stop(i, verb)` after a
// line that ends a step, its index `i`: true ends the walk. → { active, last, paused, stopped }.
const LIFECYCLE = new Set(['started', 'resumed', 'finished', 'failed', 'waiting']);
function walkRunning(progressText, sessions, dir, stop = null) {
  const ids = new Set((sessions || []).filter((x) => typeof x === 'string' && x));
  const [last, by, active, known] = [new Map(), new Map(), new Set(), new Map()];
  const paused = (step) => {
    if (!known.has(step)) known.set(step, existsSync(join(dir, 'steps', step, 'needs.json')));
    return known.get(step);
  };
  const lines = (progressText || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = EVENT.exec(lines[i]);
    if (!m || !LIFECYCLE.has(m[4])) continue;
    const [step, verb] = [m[3], m[4]];
    last.set(step, verb);
    if (verb === 'started') by.set(step, /\bsession ([A-Za-z0-9._-]+)/.exec(m[5])?.[1] ?? null);
    if ((verb === 'started' || verb === 'resumed') && ids.has(by.get(step))) active.add(step);
    else active.delete(step);
    if (stop && verb !== 'started' && verb !== 'resumed' && stop(i, active, paused)) return { active, last, paused, stopped: true };
  }
  return { active, last, paused, stopped: false };
}

// The steps a session is running by hand (R1.1, E-2): those whose last
// lifecycle line is `started` or `resumed`, whose last `started` line names an id of `sessions` (the session's chain,
// R1.2), and that wrote no needs.json under `dir`, the task's folder (a step waiting for a heavy job or the owner is
// paused, not running). A `by hand` start or k run's names no id of the chain, so it holds nothing (R1.3). A step
// boundary is an empty list.
export function runningBy(progressText, sessions, dir) {
  const { active, last, paused } = walkRunning(progressText, sessions, dir);
  return [...last.keys()].filter((step) => active.has(step) && !paused(step));
}

// R1.4: whether a step boundary came after the hook's first block of a fire, though no fire saw it (a step finished
// and the next started in one command, no request between): a line that ends a step and leaves none of the chain
// running (R1.1), in file order, after the `since.line` lines progress.md had at the block; when it has fewer now, or
// none was recorded, after the lines stamped in the block's minute (`since.at`) or before.
export function boundarySince(progressText, sessions, dir, since) {
  if (!since || typeof since !== 'object') return false;
  const lines = (progressText || '').split('\n');
  let from = Number.isInteger(since.line) && since.line >= 0 && since.line < lines.length ? since.line : null;
  if (from == null) {
    const at = new Date(since.at);
    if (!Number.isFinite(at.getTime())) return false;
    const until = stamp(at);
    from = lines.findIndex((l) => {
      const m = EVENT.exec(l);
      return m && `${m[1]} ${m[2]}` > until;
    });
    if (from < 0) return false;
  }
  return walkRunning(progressText, sessions, dir, (i, active, paused) => i >= from && [...active].every(paused)).stopped;
}

// Which k run started a `running` step, and its start: the one named by the run record of the session its `started`
// line names, or for a heavy step (no run record) by that line itself, which records no start. { krun: null } for a
// step started by hand.
export function startedBy(t, s) {
  const started = events(t.progress).filter((e) => e.step === s.id && e.verb === 'started').at(-1)?.rest || '';
  if (s.kind === 'heavy') return { krun: Number(/, k run (\d+)\)$/.exec(started)?.[1]) || null, krunStart: null, rec: null };
  const sid = /\bsession ([A-Za-z0-9._-]+)/.exec(started)?.[1];
  const dir = stepDir(t.p, s.id);
  if (!sid || !existsSync(dir)) return { krun: null, rec: null };
  const ks = readdirSync(dir).map((f) => /^run-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
  for (const k of ks) {
    const rec = readJson(join(dir, `run-${k}.json`));
    if (rec?.session_id === sid && rec.kirunak?.krun) return { krun: rec.kirunak.krun, krunStart: rec.kirunak.krunStart ?? null, rec };
  }
  return { krun: null, rec: null };
}

// The failures a stop of k run writes, a signal or a crash (orchestrator.md §2): they are not the step's own, so
// they are not one of its two failures, and they write no failure report, so a retry reads the last own one.
export const STOPPED = Object.freeze({
  bySignal: (signal) => `k run was stopped (${signal})`,
  orphan: 'the k run that started it stopped',
});
export const isStop = (reason) => reason === STOPPED.orphan || reason === STOPPED.bySignal(/\((\w+)\)$/.exec(reason)?.[1]);

// A step that ran out of its budget with work left fails with this reason and resumes once, in its own conversation,
// with half more budget (gulnya/budget-stop-marked-done): the job was bigger than planned, not too hard for its model,
// so it is not one of its own failures and climbs nothing; it writes a failure report all the same.
export const UNFINISHED = 'unfinished: ';
export const isUnfinished = (reason) => String(reason ?? '').startsWith(UNFINISHED);
export const raised = (b) => ({ calls: Math.round(b.calls * 1.5), minutes: b.minutes * 1.5, usd: Math.round(b.usd * 150) / 100 });

// The lines of a step since its conversation last started fresh (its last `started` line): its resumes share them.
function sinceStarted(progressText, step) {
  const own = events(progressText).filter((e) => e.step === step);
  const at = own.findLastIndex((e) => e.verb === 'started');
  return at < 0 ? [] : own.slice(at);
}

// How often the step's conversation stopped unfinished since it started: one means its one resume has been given.
export const unfinishedOf = (progressText, step) => sinceStarted(progressText, step).filter((e) => e.verb === 'failed' && isUnfinished(e.rest)).length;

// The last heavy job the step's conversation ran since it started, or null: { exitCode, record }, the record a path
// in the task folder (gulnya/budget-stop-marked-done: a step whose last check failed is not done).
const JOB_ENDED = /^job ended: exit (-?\d+) after .*\((steps\/[^)]+\.json)\)/;
export function lastCheckOf(progressText, step) {
  const m = sinceStarted(progressText, step).filter((e) => e.verb === 'heavy').map((e) => JOB_ENDED.exec(e.rest)).filter(Boolean).at(-1);
  return m ? { exitCode: Number(m[1]), record: m[2] } : null;
}

// A climb's line in progress.md (orchestrator.md §2): `escalated: to opus (high, build) after 2 failures on sonnet`.
// Any other `escalated` line, an old plan's or a stop's, starts the step's count afresh on its own rung.
const CLIMB = /^to (\S+) .*?after (\d+) failures? on (\S+)/;
// The `started` label of a design attempt's build run (R2.7): `(…, rung fable build on opus high)`.
const BUILD_RUN = /, rung \S+ build on /;

// A step's history: its last outcome (started, finished, failed), whether that outcome is a stop's failure, the rung it
// climbed to (the model of its last climb, null on its own rung), its own failures on that rung, and since the count
// last started afresh: every own failure (total), the climbs ({ to, after, from }) and whether a design attempt's
// build run has started since the last failure or climb (building). A stop never counts (E-3), nor a stop unfinished,
// which is in total for its report alone, and a design attempt's two runs are one attempt: only its `failed` line
// counts. A `resumed` line runs the step again, as after a stop unfinished. It runs on every pass, so a line not about the step is
// passed over before the regex.
export function historyOf(progressText, step) {
  let [last, stopped, rung, failures, total, climbs, building] = [null, false, null, 0, 0, [], false];
  const mark = ` ${step} `;
  for (const line of (progressText || '').split('\n')) {
    if (!line.includes(mark)) continue;
    const m = EVENT.exec(line);
    if (!m || m[3] !== step) continue;
    const [verb, rest] = [m[4], m[5]];
    if (verb === 'started') {
      [last, stopped] = ['started', false];
      if (BUILD_RUN.test(rest)) building = true;
    } else if (verb === 'resumed') [last, stopped] = ['started', false];
    else if (verb === 'finished') [last, stopped] = ['finished', false];
    else if (verb === 'failed') {
      [last, stopped] = ['failed', isStop(rest)];
      if (isUnfinished(rest)) total += 1;
      else if (!stopped) [failures, total, building] = [failures + 1, total + 1, false];
    } else if (verb === 'escalated') {
      const c = CLIMB.exec(rest);
      if (c) {
        climbs.push({ to: c[1], after: Number(c[2]), from: c[3] });
        [rung, failures, building] = [c[1], 0, false];
      } else [rung, failures, total, climbs, building] = [null, 0, 0, [], false];
    }
  }
  return { last, failures, stopped, rung, total, climbs, building };
}

// needs.json (orchestrator.md §2): { heavy: { what, command: [argv], maxMinutes }, then: 'resume' }, { owner } or
// { unfinished: what is left }.
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
  if (typeof n?.unfinished === 'string' && n.unfinished.trim()) return { unfinished: reasonOf(n.unfinished) };
  return { error: 'needs.json holds none of heavy, owner and unfinished' };
}

const inputExists = (p, input) => NAMED_INPUTS.includes(input) || existsSync(inputPath(p, input));
export const missingOutputs = (p, s) => s.outputs.filter((o) => !existsSync(join(p.dir, o)));

// The ladder a failed step climbs (lib/ladder.mjs): the workspace's, else kirunak's default.
export const ladderOf = (ws) => ws?.ladder ?? DEFAULT_LADDER;
// The rung a climb named, as the ladder has it now; a model the ladder no longer has stands alone, with one attempt.
const rungNamed = (ws, model) => ladderOf(ws).find((r) => r.model === model) ?? { model };

// The plan line's model and effort, else the workspace's models.<kind>, else none (Claude Code's own default).
export function modelOf(ws, s) {
  const cfg = ws?.models?.[s.kind] || {};
  return { model: s.model || cfg.model || null, effort: s.effort || cfg.effort || null };
}

// The model with the most tokens in the step's newest run record that has a result and names one, or null.
function recordedModel(p, step) {
  const dir = stepDir(p, step);
  const ks = existsSync(dir) ? readdirSync(dir).map((f) => /^run-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a) : [];
  for (const k of ks) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(dir, `run-${k}.json`), 'utf8'));
    } catch {
      continue;
    }
    if (!hasResult(rec)) continue;
    const size = (m) => m.input + m.output + m.cacheRead + m.write5m + m.write1h;
    const top = runFields(rec).models.sort((x, y) => size(y) - size(x))[0];
    if (top) return top.model;
  }
  return null;
}

// The model a step ran on and its rung (orchestrator.md §2): the plan line's, else models.<kind>, else the newest run
// record's, else the ladder's lowest rung. A model on no rung stands on the lowest. → { model, rung, onRung }
export function ranOn(ws, p, s) {
  const ladder = ladderOf(ws);
  const model = modelOf(ws, s).model ?? recordedModel(p, s.id);
  const rung = model ? rungOf(ladder, model) : ladder[0];
  return rung ? { model: rung.model, rung, onRung: true } : { model, rung: ladder[0], onRung: false };
}

// The model and effort a step's runs take where it stands: its own (modelOf) on its own rung, the rung's above it
// (R2.3), and once a design attempt's build run started, the rung that builds it (R2.4 b), so a resume after a heavy
// job or the owner's answer goes on on the same model.
export function attemptModel(ws, s, progressText) {
  const h = historyOf(progressText, s.id);
  if (!h.rung) return modelOf(ws, s);
  const at = rungNamed(ws, h.rung);
  const r = h.building && modeFor(s, at) === 'design' ? buildRungFor(ladderOf(ws), at) ?? at : at;
  return { model: r.model, effort: r.effort ?? null };
}

// How a rung's attempt runs: a review is never built from a design (R2.5), so it builds on every rung.
export const modeFor = (s, rung) => (s.kind === 'review' ? 'build' : modeOf(rung));

// The own failures a step may have where it stands before it climbs (R2.2): its two own attempts (AC-1), then each
// rung's `attempts` (AC-5).
export const allowedOf = (ws, h) => (h.rung ? attemptsOf(rungNamed(ws, h.rung)) : 2);

// steps/S-n/<prefix>-<k>.<ext>, as paths in the task folder, in number order.
function numbered(p, step, prefix) {
  const dir = stepDir(p, step);
  const re = new RegExp(`^${prefix}-(\\d+)\\.md$`);
  const ks = existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
  return ks.map((k) => `steps/${step}/${prefix}-${k}.md`);
}

// The failure reports of the count it stands in: one a failure of its own (a stop writes none), so the newest `total`.
const reportsOf = (p, step, h) => (h.total ? numbered(p, step, 'failure').slice(-h.total) : []);

// What the next attempt of a step that failed reads and where it runs (R2.6, R2.8): on its own rung the newest report
// (rung null), above it every report since its count started, on that rung. A design rung's attempt starts with
// its design run (phase design), or with its build run when that one started and was stopped (phase build, the
// newest design-<k>.md beside it). null when it has not failed on its own.
export function retryOf(ws, p, s, h) {
  if (!h.total) return null;
  const reports = reportsOf(p, s.id, h);
  if (!h.rung) return { reports: reports.slice(-1), rung: null, phase: 'build', design: null };
  const rung = rungNamed(ws, h.rung);
  const phase = modeFor(s, rung) === 'design' && !h.building ? 'design' : 'build';
  const design = phase === 'build' && modeFor(s, rung) === 'design' ? numbered(p, s.id, 'design').at(-1) ?? null : null;
  return { reports, rung, phase, design };
}

// Map step id → { state, why?, retry?, needs? }: pending, ready, running, waiting-heavy, waiting-owner, done,
// failed (as often as it may where it stands: k run climbs it, or stops past the top) or escalated (marked
// [escalate] in plan.md). retry: as retryOf says, or null.
export function stepStates(p, plan, progressText, ws = null) {
  const out = new Map();
  // Whether a needed step is done is its own history's, wherever the plan lists it: a step may need one written below it.
  const finished = new Set(plan.steps.filter((x) => historyOf(progressText, x.id).last === 'finished').map((x) => x.id));
  for (const s of plan.steps) {
    const h = historyOf(progressText, s.id);
    if (h.last === 'finished') out.set(s.id, { state: 'done' });
    else if (s.escalate) out.set(s.id, { state: 'escalated' });
    else if (h.last === 'started') {
      const needs = readNeeds(stepDir(p, s.id));
      if (needs?.heavy) out.set(s.id, { state: 'waiting-heavy', needs });
      else if (needs?.owner) out.set(s.id, { state: 'waiting-owner', needs });
      else out.set(s.id, { state: 'running' });
    } else if (h.failures >= allowedOf(ws, h)) out.set(s.id, { state: 'failed', why: `failed ${h.failures} time${h.failures > 1 ? 's' : ''}${h.rung ? ` on ${h.rung}` : ''}` });
    else {
      const waits = s.needs.filter((n) => !finished.has(n)).map((n) => `${n} is not done`);
      const missing = s.inputs.filter((i) => !inputExists(p, i)).map((i) => `${i} does not exist`);
      const why = [...waits, ...missing];
      out.set(s.id, why.length ? { state: 'pending', why: why.join(', ') } : { state: 'ready', retry: retryOf(ws, p, s, h) });
    }
  }
  return out;
}

// The steps a task stopped at for the owner (orchestrator.md §2): one marked [escalate], with what its stop line says
// happened, the newest failure report's reason and every report, or one waiting for the owner's answer, with the
// question and whether it was started by hand (no k run's record: its own session resumes it, not k run). A task with
// no plan has none. → [{ step, kind: 'escalated' | 'owner', what, why, reports, dir, byHand? }]
const STOP_LINE = 'stopped for the owner, ';
export function stopsOf(ws, p) {
  const planText = read(join(p.dir, 'plan.md'));
  if (planText === null) return [];
  const plan = parsePlan(planText);
  const progress = read(join(p.dir, 'progress.md')) ?? '';
  const out = [];
  for (const [step, st] of stepStates(p, plan, progress, ws)) {
    const dir = p.rel(`steps/${step}/`);
    if (st.state === 'waiting-owner') {
      const byHand = !startedBy({ p, progress }, plan.steps.find((s) => s.id === step)).rec;
      out.push({ step, kind: 'owner', what: 'waits for your answer', why: st.needs.owner, reports: [], dir, byHand });
    }
    if (st.state !== 'escalated') continue;
    const reports = numbered(p, step, 'failure');
    const said = events(progress).filter((e) => e.step === step && e.verb === 'escalated' && e.rest.startsWith(STOP_LINE)).at(-1);
    const what = said ? `stopped, ${said.rest.slice(STOP_LINE.length).replace(/ \(.*\)$/, '')}` : 'stopped for the owner';
    // A stop after a repeated not met (review-reruns-whole-task AC-4): its why is the repeat file, which holds both
    // reviews' rows and the owner's three ways on.
    const repeat = said && REPEAT.test(said.rest) && existsSync(join(stepDir(p, step), REPEAT_FILE)) ? `steps/${step}/${REPEAT_FILE}` : null;
    if (repeat) {
      out.push({ step, kind: 'escalated', what, why: `not met in two reviews in a row: ${repeat} holds both rows and your three ways on`, reports: [repeat], dir });
      continue;
    }
    const why = reports.length ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}: (.*)$/m.exec(read(join(p.dir, reports.at(-1))) ?? '')?.[1] ?? null : null;
    out.push({ step, kind: 'escalated', what, why, reports, dir });
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
  return { ws, id, p, plan, task, progress, states: stepStates(p, plan, progress, ws) };
}

// A task out of the queue is parked: no step of it starts until the owner puts it back (kirunak-phone AC-16).
export const queued = (ws, id) => existsSync(ws.queue) && queue.read(ws).includes(id);
export const PARKED = (id) => `${id} is parked, not in the queue: k queue add ${id} puts it back`;

// Why the task cannot run a step now: approved and unchanged, queued, not on hold or done, a plan that passes
// its check, nothing it is blocked by (task-files.md §4, §6).
export function gate(t) {
  const { ws, id, p } = t;
  const out = [];
  const v = verify(ws, id);
  if (v !== 'ok') out.push(v === 'none' ? `${id} is not approved` : `${id}: task.md does not match its approval (stale)`);
  if (existsSync(join(p.dir, 'done.json'))) out.push(`${id} is done`);
  if (existsSync(join(p.dir, 'hold.md'))) out.push(`${id} is on hold`);
  if (!queued(ws, id)) out.push(PARKED(id));
  for (const x of checkPlan(t.plan, t.task, p, ws)) if (!x.warning) out.push(`plan.md line ${x.line}: ${x.problem}`);
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
const DESIGN_TEMPLATE = new URL('../templates/design-brief.md', import.meta.url);

// The next free number k of steps/<step>/<prefix>-<k>.<ext>.
export function nextIndex(dir, prefix) {
  const re = new RegExp(`^${prefix}-(\\d+)\\.`);
  const ks = existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)?.[1]).filter(Boolean).map(Number) : [];
  return ks.length ? Math.max(...ks) + 1 : 1;
}

// A run's request ends with its run: steps/<step>/needs.json moves to needs-<k>.json, one index with every earlier
// request, when the step fails or finishes and as a resume or a retry starts. So needs.json is only ever the request
// of a run still going, and the name it moves to never changes after (a plan line may name it). → the new path or null.
export function setAsideNeeds(p, step) {
  const dir = stepDir(p, step);
  if (!existsSync(join(dir, 'needs.json'))) return null;
  const to = join(dir, `needs-${nextIndex(dir, 'needs')}.json`);
  renameSync(join(dir, 'needs.json'), to);
  return to;
}

// A rung attempt's section `## Why this step is yours` (orchestrator.md §2): how often it failed on which model, then
// the design a design run wrote, to build first, and every report in order. Empty on the step's own rung.
function historyText(ws, t, s, retry) {
  if (!retry?.rung) return '';
  const counts = countsOf(ws, t.p, s, historyOf(t.progress, s.id));
  const n = counts.reduce((a, c) => a + c.n, 0);
  const items = [
    ...(retry.design ? [`- ${t.p.rel(retry.design)}: the design. Build exactly this design; where it is wrong, say so in the report.`] : []),
    ...retry.reports.map((r) => `- ${t.p.rel(r)}`),
  ];
  const first = retry.design ? 'Read the design first, then every report, in order' : 'Read every report first, in order';
  return `\n## Why this step is yours\n\nIt failed ${n} time${n === 1 ? '' : 's'} (${countsText(counts)}). ${first}: each says what that attempt tried.\n\n${items.join('\n')}\n`;
}

// A brief's section quoted from the plan (gulnya/brief-what-and-header): its heading and the text, or '' with no text,
// so no empty heading is written. The step's `what:` line, and the plan's header (parsePlan), its rules for every step.
const quoted = (heading, text) => (text ? `\n## ${heading}, quoted from the plan\n\n${text}\n` : '');

// `k step brief <id> S-n`: the brief from templates/brief.md, at the plan's `brief:` path or steps/S-n/brief.md:
// the step's `what:` line and the plan's header, quoted from the plan, the Goal and the AC, E and D lines the step
// covers, quoted from the frozen file, the inputs and outputs with
// their paths from the repo root (the run's cwd), and the rules. `retry` is the step's state's (stepStates): on its
// own rung its report joins the inputs; above it the brief gets the section of historyText; a design run's
// (phase design) is templates/design-brief.md at steps/S-n/design-brief.md, whose one output is the next free
// steps/S-n/design-<k>.md (R2.4). → { path, text, design: that file's path in the task folder, or null }
export async function brief({ ws, id, step, extraInputs = [], retry = null, session = null, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const own = retry && !retry.rung ? retry.reports : [];
  if (s.kind === 'review') return reviewBrief(t, s, { extraInputs: [...extraInputs, ...(retry?.reports ?? []).map((r) => t.p.rel(r))], session, now });
  const { p, task } = t;
  const rel = (abs) => relative(p.root, abs);
  const sd = rel(stepDir(p, step));
  const all = s.covers.includes('all');
  const covered = [...task.sections.ac, ...task.sections.e, ...task.sections.d].filter((x) => x.id && (all || s.covers.includes(x.id)));
  const input = (i) => (i === 'task' ? `- task: ${p.rel('task.md')}` : i === 'diff' ? `- diff: ${sd}/diff.patch` : `- ${rel(inputPath(p, i))}`);
  const extra = [...extraInputs, ...own.map((r) => p.rel(r))];
  const designing = retry?.rung && retry.phase === 'design';
  const design = designing ? `steps/${step}/design-${nextIndex(stepDir(p, step), 'design')}.md` : null;
  const fill = {
    id, step, title: s.title,
    what: quoted('What this step does', s.what), header: quoted("The plan's rules for every step", t.plan.header),
    calls: { ...ws.budget, ...s.budget }.calls ?? 100, stepDir: sd, evidenceDir: p.rel('evidence'),
    goal: task.sections.goal.map((x) => x.raw).join('\n\n') || '(no goal)',
    lines: covered.map((x) => `- ${x.raw}`).join('\n') || '(none)',
    inputs: [...s.inputs.map(input), ...extra.map((x) => `- ${x} (the last attempt failed: read why first)`)].join('\n') || '(none)',
    outputs: s.outputs.map((o) => `- ${p.rel(o)}`).join('\n') || '(none)',
    history: historyText(ws, t, s, designing ? { ...retry, design: null } : retry),
    design: design && p.rel(design),
  };
  const text = readFileSync(designing ? DESIGN_TEMPLATE : TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  const path = join(p.dir, designing ? `steps/${step}/design-brief.md` : s.brief || `steps/${step}/brief.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return { path, text, design };
}

// A review step (review.md §1): its inputs are exactly the frozen task, the diff from the approved commit and the
// evidence, copied into steps/<step>/in/, the one folder its brief names; its review file is one of its outputs.
export const REVIEW_INPUTS = ['task', 'diff', 'evidence/'];
const REVIEW_FILE = /^review(-\d+)?\.md$/;
export const reviewFileOf = (s) => s.outputs.find((o) => REVIEW_FILE.test(o)) ?? null;
const REVIEW_TEMPLATE = new URL('../templates/review-brief.md', import.meta.url);

function refuseReview(t, s) {
  const out = s.inputs.filter((i) => !REVIEW_INPUTS.includes(i)).map((i) => `${i} is outside its three inputs (task, diff, evidence/)`);
  if (!reviewFileOf(s)) out.push('its outputs name no review file (review.md, review-2.md, ...)');
  if (out.length) throw refuse(`${t.id} ${s.id} is a review: ${out.join('; ')}`);
}

// What a review's run may not read (review.md §1), as Read deny rules on absolute paths: the implementer's account,
// the task's progress.md, notes.md and plan.md, every other step's folder (the plan's, and any other on disk), and
// the session transcripts. Its own folder and in/ stay readable. → ['Read(//...)', ...]
export function reviewDeny(t, step) {
  const { p } = t;
  const onDisk = existsSync(join(p.dir, 'steps')) ? readdirSync(join(p.dir, 'steps'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const others = [...new Set([...t.plan.steps.map((s) => s.id), ...onDisk])].filter((x) => x !== step);
  const read = (path) => `Read(/${path})`;
  return [
    ...['progress.md', 'notes.md', 'plan.md'].map((f) => read(join(p.dir, f))),
    ...others.flatMap((x) => [read(stepDir(p, x)), read(join(stepDir(p, x), '**'))]),
    'Read(~/.claude/projects)',
    'Read(~/.claude/projects/**)',
  ];
}

// What kirunak writes into a step's folder for itself, never committed: copies of what git holds (diff.patch, a
// review's in/), the run records, which k run and k cost read on disk while the task runs (k accept records their
// numbers in done.json, and cost.md is rendered from those), and a heavy job's record and whole log. Numbered names only, as nextIndex gives them, so a
// step's own run-summary.json stays the step's. The .gitignore leaves out itself too.
const STEP_IGNORE = "# kirunak's own files (review.md §1, orchestrator.md §6): never committed.\nin/\ndiff.patch\nrun-[0-9]*.json\nrun-[0-9]*.json.tmp\nkeep-[0-9]*.json\nheavy-[0-9]*.json\nheavy-[0-9]*.log\n.gitignore\n";
const ignoreOwn = (dir) => read(join(dir, '.gitignore')) !== STEP_IGNORE && writeFileSync(join(dir, '.gitignore'), STEP_IGNORE);

// What kirunak gave a review step (review.md §1), in its folder beside in/ and committed with it: the base its diff
// starts at, the last amendment's approval, the head, and each other repo's part. k review check reads its base (AC-4).
export const GIVEN = 'given.json';

// A review file's number and its name in rows (review-reruns-whole-task AC-1): review.md is 1, review-2.md is 2;
// reviewName('review.md') → 'review-1'.
export const reviewNumber = (file) => Number(/^review-(\d+)\.md$/.exec(file)?.[1] ?? 1);
export const reviewName = (file) => `review-${reviewNumber(file)}`;
const numberedReview = (n) => (n === 1 ? 'review.md' : `review-${n}.md`);

// The last review a review step writing `file` follows (review-reruns-whole-task AC-1, E-1, E-3): the latest review
// file before it, by number, that counts (reviewProblems finds nothing: the grammar, and a finished review step whose
// recorded hash is still the file's). null when none counts, or when the latest that counts names a head that is not
// a commit of the repo or not an ancestor of `head` (a rebase): the review is then whole, as a first one is.
// → { file, review: 'review-<n>', text, head, given } | null: head as that review wrote it, given what kirunak gave
// the step that wrote it (review.givenFor), null when that step kept none.
export function lastReview(t, file, head) {
  const { p, task, id } = t;
  for (let n = reviewNumber(file) - 1; n >= 1; n--) {
    const name = numberedReview(n);
    const path = join(p.dir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (review.reviewProblems({ file: name, text }, { task, id, p, ws: t.ws }).length) continue;
    const at = review.parseReview(text).front.head;
    const known = at && succeeds(p.root, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`]);
    if (!known || !isAncestor(p.root, at, head)) return null;
    return { file: name, review: `review-${n}`, text, head: at, given: review.givenFor(p.dir, name) };
  }
  return null;
}

// The head the last review's step recorded for the repo of `part` (its given.json's repos), when it is still a commit
// there; null when it recorded none (no part there then, or no given.json).
export function lastHeadIn(last, part) {
  const seen = (last?.given?.repos ?? []).find((r) => real(expand(r.root)) === real(part.root));
  return seen && succeeds(part.root, ['rev-parse', '--verify', '--quiet', `${seen.head}^{commit}`]) ? seen.head : null;
}

// given.json's `last` (AC-1): the last review's file, name, head and each other repo's head its step recorded; null.
const lastGiven = (last) => last && { file: last.file, review: last.review, head: last.head, repos: Object.fromEntries((last.given?.repos ?? []).map((r) => [r.name, r.head])) };

// steps/<step>/diff.patch, from the task's first approval to head, whatever amendments came after (AC-1, AC-2); for a
// review, the task's own change only (D-1: the files of the commits naming the task or naming no task, kirunak's
// records left out, so the implementer's account in the task folder is not its input either), then in/ afresh:
// task.md, diff.patch, evidence/ and a retry's failure report, the last review and the since patches when it follows
// one, and given.json. diff.patch and in/ are copies of what git holds, so the step's .gitignore leaves them out of
// git. → { base, head, amendment, unnamed, parts, last }
async function writeDiff(t, s, extraInputs = []) {
  const { p, ws } = t;
  const dir = stepDir(p, s.id);
  mkdirSync(dir, { recursive: true });
  ignoreOwn(dir);
  const { first: base, amendment } = approvals(p);
  const head = await ws.seams.storage.head(p.root);
  if (s.kind !== 'review') {
    writeFileSync(join(dir, 'diff.patch'), await ws.seams.storage.diff(p.root, base, head, []));
    return { base, head, amendment, unnamed: [], parts: [] };
  }
  const away = otherRepos(ws, p, base);
  const own = ownChange(ws, p, base, head, away.own);
  const patch = filesDiff(p.root, base, head, own.files);
  writeFileSync(join(dir, 'diff.patch'), patch);
  const inDir = join(dir, 'in');
  rmSync(inDir, { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  cpSync(p.task, join(inDir, 'task.md'));
  writeFileSync(join(inDir, 'diff.patch'), patch);
  if (existsSync(join(p.dir, 'evidence'))) cpSync(join(p.dir, 'evidence'), join(inDir, 'evidence'), { recursive: true });
  for (const x of extraInputs) cpSync(join(p.root, x), join(inDir, basename(x)));
  // A review that follows one (AC-1): that review verbatim, and the same files from its head to now, here and in
  // each other repo from the head its step recorded there.
  const last = lastReview(t, reviewFileOf(s), head);
  if (last) {
    writeFileSync(join(inDir, 'last-review.md'), last.text);
    writeFileSync(join(inDir, 'since.patch'), filesDiff(p.root, last.head, head, own.files));
  }
  if (away.parts.length) mkdirSync(join(inDir, 'repos'));
  const parts = away.parts.map((r) => ({ ...r, since: lastHeadIn(last, r) }));
  for (const r of parts) {
    writeFileSync(join(inDir, 'repos', `${r.file}.patch`), filesDiff(r.root, r.base, r.head, r.files));
    if (r.since) writeFileSync(join(inDir, 'repos', `${r.file}.since.patch`), filesDiff(r.root, r.since, r.head, r.files));
  }
  const repos = parts.map((r) => ({ name: r.name, root: tilde(r.root), ref: r.ref, base: r.base, head: r.head, files: r.files }));
  writeFileSync(join(dir, GIVEN), JSON.stringify({ base, amendment, head, repos, last: lastGiven(last) }, null, 2) + '\n');
  const unnamed = [...own.unnamed.map((c) => ({ repo: p.repo, ...c })), ...parts.flatMap((r) => r.unnamed)];
  return { base, head, amendment, unnamed, parts, last };
}

// The brief's line for each other repo's patch (AC-8, AC-9), and for each of the task's commits there its diff does not
// hold, with the branches that do.
const reposText = (parts, inDir) => parts.map((r) => {
  const not = r.notHeld.map((c) => `\n  Not in it: \`${c.sha}\` ${c.subject}${c.on.length ? `, on ${c.on.join(', ')}` : ''}.`).join('');
  const since = r.since ? `\n- \`${inDir}/repos/${r.file}.since.patch\`: the same files in ${r.name}, from ${r.since}, the head the last review saw there, to ${r.head}.` : '';
  return `\n- \`${inDir}/repos/${r.file}.patch\`: the task's change in ${r.name} (\`${tilde(r.root)}\`), from ${r.base} to ${r.head} (${r.ref}): each file of its ${r.count} commit(s) there that name the task, are on a branch named after it or are in its repos.md, diffed once.${not}${since}`;
}).join('');

// The brief's lines for the last review and the since patch (AC-1): none for a review that follows none (E-1).
const lastText = (last, inDir, head) => (last ? `\n- \`${inDir}/last-review.md\`: ${last.review} (\`${last.file}\`), the last review of this task that counts, verbatim: its rows and findings, at head ${last.head}.\n- \`${inDir}/since.patch\`: the same files as \`diff.patch\`, from ${last.review}'s head ${last.head} to head ${head}: what changed since.` : '');

// The brief's section for a review that follows one (AC-1, D-2): which rows are checked again, and how any other row
// is carried. '' for a review that follows none (E-1). k review check holds a carry to this rule.
function followsText(last, { p, head }) {
  if (!last) return '';
  const n = last.review;
  return `
## A review that follows ${n}

You follow ${n}, \`last-review.md\`. Still write a row for every AC and E, none missing and none extra. Check
again, as a first review would:

- every row that was \`not met\` in ${n}, and every \`needs device\` or \`needs owner\` row there with no item of the
  same id and words on the owner's checklist, \`${p.rel('checklist.md')}\`;
- every row whose evidence names a path changed since ${n}'s head ${last.head}: \`since.patch\` shows the task's own
  files, \`git diff --name-only ${last.head} ${head}\` every file of the repo, and each \`repos/<name>.since.patch\`
  another repo's;
- every row of a task line amended since: \`git diff ${last.head} ${head} -- ${p.rel('task.md')}\`;
- every row whose evidence names no path.

Any other row may be carried: the same verdict as in ${n}, and as evidence \`carried from ${n}: \` followed by that
row's evidence verbatim, with its own \`carried from review-<m>: \` taken off. A path is a word of the evidence (a
trailing \`:<line>\` dropped, and never the form's first word: test, file, measure or screenshot) that is a file or
folder at ${n}'s head, from the repo root or the task's folder, or an absolute or \`~/\` path inside a workspace repo
or one of its git worktrees, at the head ${n} saw there; a path in a repo whose head ${n} saw is not known counts as
changed. \`k review check\` refuses a carry that breaks this rule, and names which part failed.
`;
}

// The brief's line for the last amendment (AC-3, E-1): none when the task was never amended.
const amendedText = (a, head) => (a ? `\n  The task was amended after its first approval: ${a.id}, the last amendment, was approved in ${a.commit}, and \`git diff ${a.commit} ${head}\` over these files shows what changed since.` : '');

// The brief's list of the commits in its diffs that name no task (AC-7): '' with none.
function unnamedText(unnamed) {
  if (!unnamed.length) return '';
  const lines = unnamed.map((c) => `- ${c.repo} \`${c.sha}\` ${c.subject}: ${c.files.join(', ')}`);
  return `\n## Commits that name no task\n\nTheir files are in the diff, but their messages name no task, so a change in them may be other work: read\nthem before you count them as the task's.\n\n${lines.join('\n')}\n`;
}

// The reviewer's brief from templates/review-brief.md: the task's AC, E and O lines verbatim, the grammar, in/.
async function reviewBrief(t, s, { extraInputs, session, now }) {
  refuseReview(t, s);
  const { p, task } = t;
  const { base, head, amendment, unnamed, parts, last } = await writeDiff(t, s, extraInputs);
  const inDir = relative(p.root, join(stepDir(p, s.id), 'in'));
  const fill = {
    id: t.id, step: s.id, title: s.title, calls: { ...t.ws.budget, ...s.budget }.calls ?? 100, inDir, base, head, repo: p.repo,
    session: session || "<this conversation's session id>", date: localDate(now), output: p.rel(reviewFileOf(s)),
    lines: [...task.sections.ac, ...task.sections.e, ...task.sections.o].filter((x) => x.id).map((x) => `- ${x.raw}`).join('\n'),
    extra: extraInputs.map((x) => `\n- \`${inDir}/${basename(x)}\`: the last attempt failed; read why first.`).join(''),
    amended: amendedText(amendment, head),
    repos: reposText(parts, inDir),
    readable: parts.length ? ' So is each other repo, at the head its patch names.' : '',
    unnamed: unnamedText(unnamed),
    last: lastText(last, inDir, head),
    follows: followsText(last, { p, head }),
  };
  const text = readFileSync(REVIEW_TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  const path = join(p.dir, s.brief || `steps/${s.id}/brief.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return { path, text };
}

// A review step's output check (review.md §2): its review file in the grammar. [] for every other kind.
export function outputCheck(ws, id, s) {
  if (s.kind !== 'review') return [];
  return review.check(ws, id, reviewFileOf(s)).problems.map((x) => (x.line ? `line ${x.line}: ${x.problem}` : x.problem));
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
  if (s.kind === 'review') {
    refuseReview(t, s);
    // The same id not met in the two latest reviews that count: the step stops for the owner instead of starting.
    const rep = repeatStop({ ws, id, step, now });
    if (rep) throw refuse(`${id} ${step} is stopped for the owner: ${rep.why}; read ${t.p.rel(rep.file)}, which holds both reviews' rows and the three ways on: amend the line, accept a ratio by an amendment, or let one more fix run (the owner's session takes [escalate] off ${step} in plan.md)`);
    repoLines(ws, t.p);
    if (!session) throw refuse(`${id} ${step} is a review: it runs in a fresh conversation, so it starts with its --session`);
    for (const [other, ids] of sessionsByStep(t)) {
      if (other !== step && ids.has(session)) throw refuse(`${id} ${step} is a review: it runs in a fresh conversation, and session ${session} is ${other}'s`);
    }
  }
  mkdirSync(stepDir(t.p, step), { recursive: true });
  // A review keeps the inputs its brief copied; one started without a brief gets them now.
  if (s.kind === 'review' ? !existsSync(join(stepDir(t.p, step), 'in')) : s.inputs.includes('diff')) await writeDiff(t, s);
  note(t.p, step, `started (${label || (session ? `session ${session}` : 'by hand')})`, now);
  return { t, s };
}

// The step a file under evidence/ belongs to, its path given relative to evidence/: the step that declares it among
// its outputs; else the step whose id is the longest that the path's first segment equals or begins with followed by
// `-`, as plans name evidence (`S-1-cache-sizes.tsv`, `S-1/shot.png`; `S-13-look-renders.md` is S-13-look's, and S-1
// never takes `S-10-x`); else the step that declares a folder holding it (an output ending in /); null when none.
export function evidenceOwner(planSteps, rel) {
  const path = `evidence/${rel}`;
  const declaring = (match) => planSteps.find((s) => s.outputs.some(match))?.id;
  const first = rel.split('/')[0];
  const named = planSteps.map((s) => s.id).filter((id) => first === id || first.startsWith(`${id}-`));
  return declaring((o) => o === path) ?? named.sort((a, b) => b.length - a.length)[0]
    ?? declaring((o) => o.endsWith('/') && path.startsWith(o)) ?? null;
}

// A commit kirunak's own pre-commit hook refused: `git commit in <root> failed: kirunak: …` (lib/git.mjs).
const OWN_REFUSAL = /^git commit in .*? failed: (kirunak: [^]*)$/;

// The finish of a step whose evidence commit kirunak's own hook refused: its question to the owner in needs.json and
// progress.md, as a step's own question is written (lib/run.mjs), and no `failed` line; it stays `started`, so it
// reads waiting-owner until `k step finish` commits it.
function waitOnRefusal(ws, p, id, step, hook, now) {
  const why = hook.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  const owner = `kirunak refused the commit of ${id} ${step}'s evidence: ${why}. Once it is fixed: k step finish ${id} ${step}`;
  setAsideNeeds(p, step);
  writeFileSync(join(stepDir(p, step), 'needs.json'), `${JSON.stringify({ owner }, null, 2)}\n`);
  note(p, step, `waiting for the owner: ${owner}`, now);
  logEvent(ws, { time: now.toISOString(), kind: 'awaiting owner', task: id, step, question: owner });
  return { state: 'waiting-owner', owner };
}

// `k step finish <id> S-n`: a running step, or an owner step that is ready; every output present, the evidence it wrote committed, then the `finished` line; a
// review's carries its file's hash, `finished (review.md sha256:…)`, so a review edited after it no longer counts.
export function finish({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  // An owner step is the owner's to do, never started by an agent: k run's notice names k step finish alone, so it
  // finishes from ready, its needs done, through the task's gate as k step start's `started` line would have gone:
  // a task on hold, stale against its approval, accepted or blocked moves no step (gulnya/owner-step-finish).
  if (s.kind === 'owner' && historyOf(t.progress, step).last !== 'started') {
    const problems = gate(t);
    if (problems.length) throw refuse(`${id} cannot finish a step:\n${problems.map((x) => `  ${x}`).join('\n')}`);
    const st = t.states.get(step);
    if (st.state !== 'ready') throw refuse(`${id} ${step} is ${st.state}${st.why ? `: ${st.why}` : ''}`);
  } else if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const missing = missingOutputs(t.p, s);
  if (missing.length) throw refuse(`${id} ${step} has not written ${missing.join(', ')}`);
  const bad = outputCheck(ws, id, s);
  if (bad.length) throw refuse(`${id} ${step}: ${reviewFileOf(s)} fails k review check:\n${bad.map((x) => `  ${x}`).join('\n')}`);
  // Only the step's own new or changed files under evidence/ go into the commit, whatever else is staged, so a
  // review's `measure` or `screenshot` row stands at head and a step running beside it keeps its half-written
  // evidence out (gulnya/evidence-commit-own-step). A commit git refuses fails the finish; one kirunak's own hook
  // refuses (its every message starts `kirunak: `) leaves the step waiting for the owner, no failure counted: the work
  // is done, and the fix is the owner's or the plan's (gulnya/finish-refused-commit-waits).
  const under = `${t.p.rel('evidence')}/`;
  const evidence = changedUnder(t.p.root, t.p.rel('evidence'))
    .filter((f) => [step, null].includes(evidenceOwner(t.plan.steps, f.slice(under.length))));
  if (evidence.length) {
    try {
      commit(t.p.root, evidence, `${id} ${step}: the step's evidence`);
    } catch (e) {
      const hook = OWN_REFUSAL.exec(e.message)?.[1];
      if (!hook) throw e;
      return waitOnRefusal(ws, t.p, id, step, hook, now);
    }
  }
  const file = reviewFileOf(s);
  const isReview = s.kind === 'review' && file;
  setAsideNeeds(t.p, step);
  note(t.p, step, isReview ? `finished (${file} ${hashBytes(readFileSync(join(t.p.dir, file)))})` : 'finished', now);
  if (isReview) logEvent(ws, { time: now.toISOString(), kind: 'review-ready', task: id, step, file });
  return { state: 'done' };
}

// A failure's reason as progress.md records it: one line.
export const reasonOf = (why) => String(why ?? '').replace(/\s+/g, ' ').trim() || 'no reason given';

// `k step fail <id> S-n --why`: the `failed` line and steps/S-n/failure-<n>.md, the report the next attempts read; a
// stop's failure writes the line alone (report null). It climbs nothing: k run's next pass does (climb), or stops.
// → { report, failures }: the step's own failures where it stands.
export function fail({ ws, id, step, why, detail = '', now = new Date() }) {
  const t = load(ws, id);
  stepOf(t, step);
  if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const reason = reasonOf(why);
  const aside = setAsideNeeds(t.p, step);
  let report = null;
  if (!isStop(reason)) {
    const dir = stepDir(t.p, step);
    mkdirSync(dir, { recursive: true });
    report = join(dir, `failure-${nextIndex(dir, 'failure')}.md`);
    const moved = aside ? `\nIts needs.json is now ${relative(t.p.root, aside)}.\n` : '';
    writeFileSync(report, `# ${id} ${step} failed\n\n${stamp(now)}: ${reason}\n${detail ? `\n${detail.trim()}\n` : ''}${moved}`);
  }
  note(t.p, step, `failed: ${reason}`, now);
  return { report, failures: historyOf(read(join(t.p.dir, 'progress.md')), step).failures };
}

// The own failures on each model since the step's count started, lowest first: [{ model, n }]; a heavy step's
// model is null.
function countsOf(ws, p, s, h) {
  const out = h.climbs.map((c) => ({ model: c.from, n: c.after }));
  if (h.failures || !out.length) out.push({ model: h.rung ?? (s.kind === 'heavy' ? null : ranOn(ws, p, s).model), n: h.failures });
  return out;
}
const countsText = (counts) => counts.map((c) => (c.model ? `${c.model} ${c.n}` : String(c.n))).join(', ');

// A step that failed as often as it may where it stands climbs one rung (AC-1, AC-2, R2.2): the line
// `escalated: to opus (high, build) after 2 failures on sonnet`, and its next attempt runs there. A heavy step has no
// model and no rung (R2.5), and the top rung has none above: then nothing is written, and k run stops for the owner
// (escalate). → { to: rung | null, from: the model it failed on, failures }
export function climb({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const st = t.states.get(step);
  if (st.state !== 'failed') throw refuse(`${id} ${step} is ${st.state}: a step climbs once it has failed as often as it may`);
  const h = historyOf(t.progress, step);
  if (s.kind === 'heavy') return { to: null, from: null, failures: h.failures };
  const own = h.rung ? null : ranOn(ws, t.p, s);
  const from = h.rung ?? own.model;
  const to = above(ladderOf(ws), h.rung ? rungNamed(ws, h.rung) : own.rung);
  if (!to) return { to: null, from, failures: h.failures };
  const how = [to.effort, modeFor(s, to)].filter(Boolean).join(', ');
  const off = own && !own.onRung ? ` (model ${own.model} is on no rung)` : '';
  note(t.p, step, `escalated: to ${to.model} (${how}) after ${h.failures} failure${h.failures === 1 ? '' : 's'} on ${from}${off}`, now);
  return { to, from, failures: h.failures };
}

// The stop past the top rung (AC-7, R2.7): `[escalate]` on the step's header, the plan field `failures:` naming every
// failure report of the step, an `escalated` line that starts its count afresh should the owner's session take the
// mark off, and the event. → { failures: [paths in the task folder], last, why }
// `because` names another stop than the ladder's: a step that stopped unfinished after its one resume.
export function escalate({ ws, id, step, because = null, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const h = historyOf(t.progress, step);
  const counts = s.kind === 'heavy' ? null : countsOf(ws, t.p, s, h);
  const why = because ?? (counts ? `failed on every rung (${countsText(counts)})` : `failed ${h.failures} times`);
  const failures = numbered(t.p, step, 'failure');
  const planFile = join(t.p.dir, 'plan.md');
  const lines = readFileSync(planFile, 'utf8').split('\n');
  if (!s.escalate) lines[s.line - 1] = `${lines[s.line - 1].trimEnd()} [escalate]`;
  if (failures.length) {
    // After the step's last field, or in place of the one an earlier stop wrote.
    const next = lines.findIndex((l, i) => i >= s.line && l.startsWith('### '));
    const end = next < 0 ? lines.length : next;
    const field = `failures: ${failures.join(', ')}`;
    const had = lines.slice(s.line, end).findIndex((l) => l.startsWith('failures:'));
    let at = end;
    while (at > s.line && lines[at - 1].trim() === '') at--;
    if (had >= 0) lines[s.line + had] = field;
    else lines.splice(at, 0, field);
  }
  writeFileSync(planFile, lines.join('\n'));
  note(t.p, step, `escalated: ${STOP_LINE}${why}`, now);
  logEvent(ws, { time: now.toISOString(), kind: 'escalate', trigger: 'k run failure count', task: id, step, failures: h.total, from: { model: counts?.at(-1).model ?? null }, to: null, stopped: true });
  return { failures, last: failures.at(-1) ?? null, why };
}

// The stop after a repeated not met (review-reruns-whole-task AC-4, D-4): its file in the step's folder, and the end
// of its progress line, which records the pair of reviews so that pair stops the step only once.
export const REPEAT_FILE = 'repeat.md';
const REPEAT = /not met in (review-\d+) and (review-\d+)$/;

// The latest `n` reviews before `file` that count (reviewProblems finds nothing), newest first: [{ file, review, text }].
function countingReviews(t, file, n) {
  const out = [];
  for (let k = reviewNumber(file) - 1; k >= 1 && out.length < n; k--) {
    const name = numberedReview(k);
    const path = join(t.p.dir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!review.reviewProblems({ file: name, text }, { task: t.task, id: t.id, p: t.p, ws: t.ws }).length) out.push({ file: name, review: `review-${k}`, text });
  }
  return out;
}

// The repeat a review step stops at (AC-4): the ids `not met` in both of the two latest reviews that count before the
// file it writes, each with both rows verbatim. null when it is no review, fewer than two count, or no id repeats.
// → { a, b, ids, rows: [{ id, a: '<row line in a>', b: '<row line in b>' }] }, a the older review, b the newer.
export function repeatOf(t, s) {
  const file = s.kind === 'review' && reviewFileOf(s);
  if (!file) return null;
  const [b, a] = countingReviews(t, file, 2);
  if (!a) return null;
  const rowsOf = (r) => {
    const lines = r.text.replace(/\r/g, '').split('\n');
    return new Map(review.parseReview(r.text).rows.filter((x) => x.verdict === 'not met').map((x) => [x.id, lines[x.line - 1].trim()]));
  };
  const [inA, inB] = [rowsOf(a), rowsOf(b)];
  const rows = [...inA].filter(([id]) => inB.has(id)).map(([id, row]) => ({ id, a: row, b: inB.get(id) }));
  return rows.length ? { a: { file: a.file, review: a.review }, b: { file: b.file, review: b.review }, ids: rows.map((r) => r.id), rows } : null;
}

function repeatText(t, s, rep) {
  const { a, b, ids } = rep;
  const each = rep.rows.map((r) => `## ${r.id}\n\n${a.review} (\`${a.file}\`):\n\n${r.a}\n\n${b.review} (\`${b.file}\`):\n\n${r.b}\n`).join('\n');
  return `# ${t.id} ${s.id}: ${ids.join(', ')} not met in ${a.review} and ${b.review}

kirunak stopped ${s.id}, the review that writes \`${reviewFileOf(s)}\`, before it started: ${ids.length === 1 ? 'this id was' : 'these ids were'} \`not met\` in the two latest reviews that count, so a third review would most likely find the same. Both reviews' rows, verbatim:

${each}
## Your three ways on

1. Amend the line: \`k amend new ${t.id}\`, then the owner types \`! k approve ${t.id} --amendment A-<n>\`.
2. Accept a ratio: an amendment the same way, whose line states the ratio the work reaches.
3. Let one more fix run: the owner's session takes \`[escalate]\` off ${s.id}'s header in plan.md. This pair of reviews, ${a.review} and ${b.review}, does not stop ${s.id} again; a new pair does.
`;
}

// Stops a ready review step whose two latest counting reviews repeat a `not met` (AC-4, D-4), as the stop past the top
// rung does: `[escalate]` on its header in plan.md, steps/<step>/repeat.md, the progress line `escalated: stopped for
// the owner, <ids> not met in review-<a> and review-<b>`, and the event. A pair whose stop the progress already
// records does not stop the step again, so once the owner's session takes the mark off the step runs. k run's pass
// and k step start both call it. → { ids, a, b, rows, file, why } | null
export function repeatStop({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  const rep = repeatOf(t, s);
  if (!rep) return null;
  const pair = (e) => {
    const m = REPEAT.exec(e.rest);
    return m && m[1] === rep.a.review && m[2] === rep.b.review;
  };
  if (events(t.progress).some((e) => e.step === step && e.verb === 'escalated' && e.rest.startsWith(STOP_LINE) && pair(e))) return null;
  const why = `${rep.ids.join(', ')} not met in ${rep.a.review} and ${rep.b.review}`;
  const file = `steps/${step}/${REPEAT_FILE}`;
  mkdirSync(stepDir(t.p, step), { recursive: true });
  writeFileSync(join(t.p.dir, file), repeatText(t, s, rep));
  const planFile = join(t.p.dir, 'plan.md');
  const lines = readFileSync(planFile, 'utf8').split('\n');
  if (!s.escalate) lines[s.line - 1] = `${lines[s.line - 1].trimEnd()} [escalate]`;
  writeFileSync(planFile, lines.join('\n'));
  note(t.p, step, `escalated: ${STOP_LINE}${why}`, now);
  logEvent(ws, { time: now.toISOString(), kind: 'escalate', trigger: 'repeated not met', task: id, step, ids: rep.ids, reviews: [rep.a.review, rep.b.review], to: null, stopped: true });
  return { ...rep, file, why };
}

// steps/S-n/<prefix>-<k>.json: a run's whole JSON result, run-<k>.json (orchestrator.md §3), or a keep-alive's,
// keep-<k>.json (§5), so a keep-alive's cost is in the step's.
function saveResult(p, step, prefix, result) {
  const dir = stepDir(p, step);
  mkdirSync(dir, { recursive: true });
  ignoreOwn(dir);
  const path = join(dir, `${prefix}-${nextIndex(dir, prefix)}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  return path;
}

export const saveKeep = (p, step, result) => saveResult(p, step, 'keep', result);

// steps/S-n/run-<k>.json is written before the run starts (orchestrator.md §3): its session, and under `kirunak` the
// k run's pid and its start (krunStart), the claude's pid and its start once it starts (claudeStart: what tells that
// pid from a later process that reused it), the start. When the run ends its whole JSON result joins them, with the end and the exit code.
// → { started(pid), ended(o) }; each write replaces the file whole.
export function runRecord(p, step, session, now = new Date()) {
  const dir = stepDir(p, step);
  mkdirSync(dir, { recursive: true });
  ignoreOwn(dir);
  const path = join(dir, `run-${nextIndex(dir, 'run')}.json`);
  const kirunak = { krun: process.pid, krunStart: OWN_START, claude: null, claudeStart: null, started: now.toISOString(), ended: null, result: false };
  const write = (rec) => {
    writeFileSync(`${path}.tmp`, JSON.stringify({ session_id: session, ...rec, kirunak }, null, 2) + '\n');
    renameSync(`${path}.tmp`, path);
  };
  write({});
  return {
    path,
    started(pid, at = new Date()) {
      kirunak.claude = pid ?? null;
      kirunak.claudeStart = pid ? at.toISOString() : null;
      write({});
    },
    ended(o, end = new Date()) {
      Object.assign(kirunak, { ended: end.toISOString(), exitCode: o.exitCode ?? null, result: !!o.result });
      write(o.result || {});
    },
  };
}

// A record without a result (`kirunak.result` false): a run still going, one whose k run stopped, or one that printed
// none. It names a session the step ran, and no calls or money.
export const hasResult = (rec) => !!rec && rec.kirunak?.result !== false;

// steps/S-n/heavy-<k>.json beside the job's whole log: the exit code, the minutes, the log's path, its last 60 lines.
export function saveHeavy(p, step, { what, command, exitCode, minutes, log }) {
  const dir = stepDir(p, step);
  mkdirSync(dir, { recursive: true });
  ignoreOwn(dir);
  const k = nextIndex(dir, 'heavy');
  const logPath = join(dir, `heavy-${k}.log`);
  writeFileSync(logPath, log || '');
  const record = { what, command, exitCode, minutes, report: relative(p.root, logPath), lastLines: String(log || '').replace(/\n$/, '').split('\n').slice(-60) };
  const path = join(dir, `heavy-${k}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return { k, path, record };
}

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { OWN_START } from '../plugins/resource-guard-local.mjs';
import { hashBytes, localDate, logEvent, readRecord, verify } from './approval.mjs';
import { refuse } from './errors.mjs';
import { changedUnder, commit } from './git.mjs';
import { checkPlan, inputPath, NAMED_INPUTS, parsePlan } from './plan.mjs';
import * as queue from './queue.mjs';
import * as review from './review.mjs';
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

// The failures a stop of k run writes, a signal or a crash (orchestrator.md §2): they are not the step's own, so
// they are not one of its two failures, and they write no failure report, so a retry reads the last own one.
export const STOPPED = Object.freeze({
  bySignal: (signal) => `k run was stopped (${signal})`,
  orphan: 'the k run that started it stopped',
});
export const isStop = (reason) => reason === STOPPED.orphan || reason === STOPPED.bySignal(/\((\w+)\)$/.exec(reason)?.[1]);

// A step's history: its last outcome (started, finished, failed), its own failures since the last escalation, and
// whether that last outcome is a stop's failure.
export function historyOf(progressText, step) {
  let last = null;
  let failures = 0;
  let stopped = false;
  for (const e of events(progressText).filter((x) => x.step === step)) {
    if (e.verb === 'started' || e.verb === 'finished') [last, stopped] = [e.verb, false];
    else if (e.verb === 'failed') {
      [last, stopped] = ['failed', isStop(e.rest)];
      if (!stopped) failures += 1;
    } else if (e.verb === 'escalated') failures = 0;
  }
  return { last, failures, stopped };
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
// retry: the step failed on its own since its last escalation, so the next attempt reads the newest failure report,
// a stop in between or not (a stop writes none).
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
      out.set(s.id, why.length ? { state: 'pending', why: why.join(', ') } : { state: 'ready', retry: h.failures > 0 });
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
export async function brief({ ws, id, step, extraInputs = [], session = null, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  if (s.kind === 'review') return reviewBrief(t, s, { extraInputs, session, now });
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
// review's in/) and the run records, which k run and k cost read on disk while the task runs (k accept commits their
// summary, cost.md). The .gitignore leaves out itself too, so a step folder shows only the step's own files.
const STEP_IGNORE = "# kirunak's own files (review.md §1, orchestrator.md §6): never committed.\nin/\ndiff.patch\nrun-*.json\nrun-*.json.tmp\nkeep-*.json\n.gitignore\n";
const ignoreOwn = (dir) => read(join(dir, '.gitignore')) !== STEP_IGNORE && writeFileSync(join(dir, '.gitignore'), STEP_IGNORE);

// steps/<step>/diff.patch, from the approved commit to head; for a review, in/ afresh: task.md, diff.patch,
// evidence/ and a retry's failure report. A review's diff leaves out the task's folder: the implementer's account
// (notes, progress, plan, step reports) is not its input, and task.md and evidence/ reach it through in/. Both are
// copies of what git holds, so the step's .gitignore leaves them out of git. → { base, head }
async function writeDiff(t, s, extraInputs = []) {
  const { p, ws } = t;
  const dir = stepDir(p, s.id);
  mkdirSync(dir, { recursive: true });
  ignoreOwn(dir);
  const base = readRecord(p.root, p.slug).commit;
  const head = await ws.seams.storage.head(p.root);
  const exclude = s.kind === 'review' ? [relative(p.root, p.dir)] : [];
  const patch = await ws.seams.storage.diff(p.root, base, head, exclude);
  writeFileSync(join(dir, 'diff.patch'), patch);
  if (s.kind !== 'review') return { base, head };
  const inDir = join(dir, 'in');
  rmSync(inDir, { recursive: true, force: true });
  mkdirSync(inDir, { recursive: true });
  cpSync(p.task, join(inDir, 'task.md'));
  writeFileSync(join(inDir, 'diff.patch'), patch);
  if (existsSync(join(p.dir, 'evidence'))) cpSync(join(p.dir, 'evidence'), join(inDir, 'evidence'), { recursive: true });
  for (const x of extraInputs) cpSync(join(p.root, x), join(inDir, basename(x)));
  return { base, head };
}

// The reviewer's brief from templates/review-brief.md: the task's AC, E and O lines verbatim, the grammar, in/.
async function reviewBrief(t, s, { extraInputs, session, now }) {
  refuseReview(t, s);
  const { p, task } = t;
  const { base, head } = await writeDiff(t, s, extraInputs);
  const inDir = relative(p.root, join(stepDir(p, s.id), 'in'));
  const fill = {
    id: t.id, step: s.id, title: s.title, calls: { ...t.ws.budget, ...s.budget }.calls ?? 100, inDir, base, head,
    session: session || "<this conversation's session id>", date: localDate(now), output: p.rel(reviewFileOf(s)),
    lines: [...task.sections.ac, ...task.sections.e, ...task.sections.o].filter((x) => x.id).map((x) => `- ${x.raw}`).join('\n'),
    extra: extraInputs.map((x) => `\n- \`${inDir}/${basename(x)}\`: the last attempt failed; read why first.`).join(''),
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

// `k step finish <id> S-n`: every output present, the evidence it wrote committed, then the `finished` line; a
// review's carries its file's hash, `finished (review.md sha256:…)`, so a review edited after it no longer counts.
export function finish({ ws, id, step, now = new Date() }) {
  const t = load(ws, id);
  const s = stepOf(t, step);
  if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const missing = missingOutputs(t.p, s);
  if (missing.length) throw refuse(`${id} ${step} has not written ${missing.join(', ')}`);
  const bad = outputCheck(ws, id, s);
  if (bad.length) throw refuse(`${id} ${step}: ${reviewFileOf(s)} fails k review check:\n${bad.map((x) => `  ${x}`).join('\n')}`);
  // Only the new or changed files under evidence/ go into the commit, whatever else is staged, so a review's
  // `measure` or `screenshot` row stands at head. A commit git refuses fails the finish.
  const evidence = changedUnder(t.p.root, t.p.rel('evidence'));
  if (evidence.length) commit(t.p.root, evidence, `${id} ${step}: the step's evidence`);
  const file = reviewFileOf(s);
  note(t.p, step, s.kind === 'review' && file ? `finished (${file} ${hashBytes(readFileSync(join(t.p.dir, file)))})` : 'finished', now);
  return { state: 'done' };
}

// A failure's reason as progress.md records it: one line.
export const reasonOf = (why) => String(why ?? '').replace(/\s+/g, ' ').trim() || 'no reason given';

// `k step fail <id> S-n --why`: the `failed` line and steps/S-n/failure-<n>.md, the report a retry reads; a stop's
// failure writes the line alone (report null). A second failure of the step's own (a stop is not one) marks it
// [escalate] in plan.md, with models.escalate when the workspace names one.
export function fail({ ws, id, step, why, detail = '', now = new Date() }) {
  const t = load(ws, id);
  stepOf(t, step);
  if (historyOf(t.progress, step).last !== 'started') throw refuse(`${id} ${step} is not running`);
  const reason = reasonOf(why);
  let report = null;
  if (!isStop(reason)) {
    const dir = stepDir(t.p, step);
    mkdirSync(dir, { recursive: true });
    report = join(dir, `failure-${nextIndex(dir, 'failure')}.md`);
    writeFileSync(report, `# ${id} ${step} failed\n\n${stamp(now)}: ${reason}\n${detail ? `\n${detail.trim()}\n` : ''}`);
  }
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
  const k = nextIndex(dir, 'heavy');
  const logPath = join(dir, `heavy-${k}.log`);
  writeFileSync(logPath, log || '');
  const record = { what, command, exitCode, minutes, report: relative(p.root, logPath), lastLines: String(log || '').replace(/\n$/, '').split('\n').slice(-60) };
  const path = join(dir, `heavy-${k}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n');
  return { k, path, record };
}

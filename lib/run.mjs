import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { logEvent } from './approval.mjs';
import { refuse } from './errors.mjs';
import * as steps from './steps.mjs';
import { admit, register, unregister } from '../plugins/machine-guard-pids.mjs';
import { killTree } from '../plugins/resource-guard-local.mjs';

// `k run <id> [--once|--watch]` (orchestrator.md §2): a plain Node loop, no model. Each pass reads the files, starts
// every ready step the machine guard admits, and waits; --watch passes every 30 s and ends when no step is ready
// and nothing runs, or when the task stops (an owner's question, a step marked [escalate]).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATER = { review: 'slice 4 (review.md §1)', sync: 'slice 5 (boards.md §3)' };

// The plan line's model and effort, else the workspace's models.<kind>, else none (Claude Code's own default).
export function modelOf(ws, s) {
  const cfg = ws.models?.[s.kind] || {};
  return { model: s.model || cfg.model || null, effort: s.effort || cfg.effort || null };
}

export const budgetOf = (ws, s) => ({ calls: 100, minutes: 40, usd: 3, ...ws.budget, ...s.budget });

// The calls and money a conversation has used: its results' turns add up; its cost is its latest result's.
export function usedBy(p, step, sessionId) {
  const dir = steps.stepDir(p, step);
  let turns = 0;
  let usd = 0;
  for (const f of readdirSync(dir).filter((x) => /^run-\d+\.json$/.test(x))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (r.session_id !== sessionId) continue;
    turns += Number(r.num_turns) || 0;
    usd = Math.max(usd, Number(r.total_cost_usd) || 0);
  }
  return { turns, usd };
}

// The session a waiting step's conversation runs in: its latest run record's.
export function lastSession(p, step) {
  const dir = steps.stepDir(p, step);
  const runs = readdirSync(dir).filter((x) => /^run-\d+\.json$/.test(x)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)));
  return runs.length ? JSON.parse(readFileSync(join(dir, runs.at(-1)), 'utf8')).session_id : null;
}

// The run's end, or the budget's minutes: then its process tree is killed (TERM, then KILL) and it failed.
export async function timed(handle, minutes) {
  let timer;
  const late = new Promise((r) => (timer = setTimeout(() => r('late'), minutes * 60000)));
  const first = await Promise.race([handle.done, late]);
  clearTimeout(timer);
  if (first !== 'late') return first;
  if (handle.pid) await killTree(handle.pid);
  const after = await Promise.race([handle.done, new Promise((r) => (timer = setTimeout(() => r({}), 15000)))]);
  clearTimeout(timer);
  return { ...after, exitCode: 124, timedOut: true };
}

export function failureOf(o, minutes) {
  if (o.timedOut) return `no end within the budget's ${minutes} minutes`;
  const sub = o.result?.subtype && o.result.subtype !== 'success' ? ` (${o.result.subtype})` : '';
  if (o.exitCode !== 0) return `exit ${o.exitCode}${sub}`;
  if (!o.result) return 'no JSON result';
  if (o.result.is_error) return `the run ended in error (${o.result.subtype || 'is_error'})`;
  return null;
}

export async function run({ ws, id, watch = false, intervalMs = 30000, out = () => {} }) {
  const first = steps.load(ws, id);
  const problems = steps.gate(first);
  if (problems.length) throw refuse(`${id} cannot run:\n${problems.map((x) => `  ${x}`).join('\n')}`);
  const { p } = first;
  const session = `kirunak:${id}`;
  const inflight = new Map();
  const ended = {};
  let reserved = 0;
  const take = () => (reserved++, { held: true });
  const free = (slot) => slot?.held && ((slot.held = false), reserved--);
  let stop = null;
  let refused = [];
  let firstPass = true;
  const say = (line) => out(`${id} ${line}`);

  async function heavyJob(s, job) {
    const t0 = Date.now();
    const r = await ws.seams.resourceGuard.run({ session, what: job.what, maxMinutes: job.maxMinutes, command: job.command, cwd: p.root });
    const minutes = Math.round(((Date.now() - t0) / 60000) * 100) / 100;
    return { r, saved: steps.saveHeavy(p, s.id, { ...job, exitCode: r.exitCode, minutes, log: r.log }) };
  }

  // One conversation of an agent step, from its start or a resume, through its heavy jobs, to its end.
  async function converse(s, { sessionId, prompt, resume, slot }) {
    const { model, effort } = modelOf(ws, s);
    const budget = budgetOf(ws, s);
    for (;;) {
      if (!slot?.held) while (!(await admit(ws.seams.machineGuard, reserved)).ok) await sleep(intervalMs);
      const used = resume ? usedBy(p, s.id, sessionId) : { turns: 0, usd: 0 };
      const handle = await ws.seams.runner.start({
        brief: prompt, prompt, cwd: p.root, model, effort, sessionId, resume,
        maxTurns: Math.max(1, budget.calls - used.turns), maxBudgetUsd: Math.max(0.01, Math.round((budget.usd - used.usd) * 100) / 100),
        permissionMode: ws.runner?.permissionMode || 'auto', disallowedTools: ['Agent'], addDirs: [],
        env: { KIRUNAK_TASK: id, KIRUNAK_STEP: s.id },
      });
      if (handle.pid) register(ws, handle.pid, { task: id, step: s.id, session: handle.sessionId || sessionId });
      free(slot);
      const o = await timed(handle, budget.minutes);
      if (handle.pid) unregister(ws, handle.pid);
      if (o.result) steps.saveRun(p, s.id, o.result);
      const needs = steps.readNeeds(steps.stepDir(p, s.id));
      let why = failureOf(o, budget.minutes) || needs?.error || null;
      if (!why && needs?.heavy) {
        steps.note(p, s.id, `waiting for a heavy job: ${needs.heavy.what}`);
        const { saved } = await heavyJob(s, needs.heavy);
        renameSync(join(steps.stepDir(p, s.id), 'needs.json'), join(steps.stepDir(p, s.id), `needs-${saved.k}.json`));
        steps.note(p, s.id, `heavy job ended: exit ${saved.record.exitCode} after ${saved.record.minutes} min (${relative(p.dir, saved.path)})`);
        [prompt, resume] = [`the job ended; read ${relative(p.root, saved.path)} and continue`, sessionId];
        steps.note(p, s.id, `resumed (session ${sessionId})`);
        continue;
      }
      if (!why && needs?.owner) {
        steps.note(p, s.id, `waiting for the owner: ${needs.owner}`);
        logEvent(ws, { time: new Date().toISOString(), kind: 'awaiting owner', task: id, step: s.id, question: needs.owner });
        return 'waiting-owner';
      }
      const missing = why ? [] : steps.missingOutputs(p, s);
      if (missing.length) why = `missing outputs: ${missing.join(', ')}`;
      if (why) {
        const detail = [`Exit code ${o.exitCode}, session ${sessionId}.`, o.result?.result ? `The run's last message:\n\n${o.result.result}` : ''].join('\n\n');
        return steps.fail({ ws, id, step: s.id, why, detail }).escalated ? 'escalated' : 'failed';
      }
      steps.finish({ ws, id, step: s.id });
      return 'done';
    }
  }

  const agentStep = (s, st, slot) => withDevice(s, async () => {
    const retry = st.retry ? readdirSync(steps.stepDir(p, s.id)).filter((f) => /^failure-\d+\.md$/.test(f)).sort((a, b) => Number(a.slice(8, -3)) - Number(b.slice(8, -3))).at(-1) : null;
    const extra = retry ? [relative(p.root, join(steps.stepDir(p, s.id), retry))] : [];
    const { text } = steps.brief({ ws, id, step: s.id, extraInputs: extra });
    const sessionId = randomUUID();
    const { model, effort } = modelOf(ws, s);
    await steps.start({ ws, id, step: s.id, session: sessionId, label: `${[model, effort].filter(Boolean).join(' ') || 'default model'}, session ${sessionId}` });
    return converse(s, { sessionId, prompt: text, resume: null, slot });
  });

  const heavyStep = (s) => withDevice(s, async () => {
    const what = s.what || s.title;
    await steps.start({ ws, id, step: s.id, label: `heavy: ${what}` });
    const { saved } = await heavyJob(s, { what, command: ['/bin/sh', '-c', s.command], maxMinutes: s.maxMinutes || budgetOf(ws, s).minutes });
    const missing = steps.missingOutputs(p, s);
    const why = saved.record.exitCode !== 0 ? `exit ${saved.record.exitCode}` : missing.length ? `missing outputs: ${missing.join(', ')}` : null;
    if (why) return steps.fail({ ws, id, step: s.id, why, detail: `The log: ${saved.record.report}` }).escalated ? 'escalated' : 'failed';
    steps.finish({ ws, id, step: s.id });
    return 'done';
  });

  // A plan step's `device:` is claimed for the step and released however it ends.
  async function withDevice(s, fn) {
    if (!s.device) return fn();
    await ws.seams.resourceGuard.claim(s.device, session, `${id} ${s.id}`);
    try {
      return await fn();
    } finally {
      await ws.seams.resourceGuard.release(s.device, session);
    }
  }

  const launch = (s, fn, slot = null) => {
    say(`${s.id} starts`);
    const run = fn()
      .catch((e) => {
        say(`${s.id}: ${e.message}`);
        // A runner or a guard that throws after the step started must not leave it looking like it runs.
        const t = steps.load(ws, id);
        if (steps.historyOf(t.progress, s.id).last !== 'started') return 'error';
        return steps.fail({ ws, id, step: s.id, why: `kirunak stopped the step: ${e.message}` }).escalated ? 'escalated' : 'failed';
      })
      .then((r) => {
        free(slot);
        ended[s.id] = r;
        inflight.delete(s.id);
        say(`${s.id} ${r}`);
      });
    inflight.set(s.id, run);
  };

  async function pass() {
    const t = steps.load(ws, id);
    refused = [];
    for (const s of t.plan.steps) {
      if (stop) break;
      if (inflight.has(s.id)) continue;
      const st = t.states.get(s.id);
      if (st.state === 'failed') steps.escalate({ ws, id, step: s.id });
      if (st.state === 'failed' || st.state === 'escalated') stop = `${s.id} is marked [escalate] in plan.md: it failed twice; the owner's session decides`;
      else if (st.state === 'waiting-owner' && !firstPass) stop = `${s.id} waits for the owner: ${st.needs.owner}`;
      else if (st.state === 'waiting-owner') {
        const dir = steps.stepDir(p, s.id);
        const k = steps.nextIndex(dir, 'needs');
        renameSync(join(dir, 'needs.json'), join(dir, `needs-${k}.json`));
        const sid = lastSession(p, s.id);
        steps.note(p, s.id, `resumed (session ${sid}): the owner answered`);
        launch(s, () => withDevice(s, () => converse(s, { sessionId: sid, resume: sid, prompt: `the owner has answered the question of ${relative(p.root, join(dir, `needs-${k}.json`))}; read ${p.rel('notes.md')} and any new amendment, then continue` })));
      } else if (st.state === 'waiting-heavy') {
        launch(s, async () => {
          const sid = lastSession(p, s.id);
          const { saved } = await heavyJob(s, st.needs.heavy);
          renameSync(join(steps.stepDir(p, s.id), 'needs.json'), join(steps.stepDir(p, s.id), `needs-${saved.k}.json`));
          steps.note(p, s.id, `heavy job ended: exit ${saved.record.exitCode} after ${saved.record.minutes} min; resumed (session ${sid})`);
          return withDevice(s, () => converse(s, { sessionId: sid, resume: sid, prompt: `the job ended; read ${relative(p.root, saved.path)} and continue` }));
        });
      } else if (st.state !== 'ready') continue;
      else if (s.kind === 'owner') stop = `${s.id} waits for the owner: ${s.title}${s.outputs.length ? ` (it needs ${s.outputs.join(', ')})` : ''}`;
      else if (LATER[s.kind]) stop = `${s.id} is a ${s.kind} step, which comes with ${LATER[s.kind]}`;
      else if (s.kind === 'heavy') launch(s, () => heavyStep(s));
      else {
        const a = await admit(ws.seams.machineGuard, reserved);
        if (!a.ok) {
          refused.push(`${s.id} waits for the machine: ${a.why}`);
          continue;
        }
        const slot = take();
        launch(s, () => agentStep(s, st, slot), slot);
      }
    }
    firstPass = false;
  }

  await pass();
  if (watch) {
    while (inflight.size || (!stop && refused.length)) {
      let tick;
      await Promise.race([...inflight.values(), new Promise((r) => (tick = setTimeout(r, intervalMs)))]);
      clearTimeout(tick);
      if (!stop) await pass();
    }
  }
  await Promise.all(inflight.values());
  const states = steps.load(ws, id).states;
  for (const r of refused) say(r);
  if (stop) say(`stopped: ${stop}`);
  return { ended, stopped: stop, refused, states: Object.fromEntries([...states].map(([k, v]) => [k, v.state])) };
}

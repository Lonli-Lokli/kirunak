import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { logEvent } from './approval.mjs';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import * as keeper from './keeper.mjs';
import * as steps from './steps.mjs';
import { onStop } from './stop.mjs';
import { admit, register, release, unregister } from '../plugins/machine-guard-pids.mjs';
import { groupAlive, isStill, killTree, OWN_START, stillRuns } from '../plugins/resource-guard-local.mjs';

// `k run <id> [--once|--watch]` (orchestrator.md §2): a plain Node loop, no model. Each pass reads the files, starts
// every ready step the machine guard admits, and waits; --watch passes every 30 s and ends when no step is ready
// and nothing runs, or when the task stops (an owner's question, a step marked [escalate]).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATER = { sync: 'slice 5 (boards.md §3)' };

// The plan line's model and effort, else the workspace's models.<kind>, else none (Claude Code's own default).
export function modelOf(ws, s) {
  const cfg = ws.models?.[s.kind] || {};
  return { model: s.model || cfg.model || null, effort: s.effort || cfg.effort || null };
}

export const budgetOf = (ws, s) => ({ calls: 100, minutes: 40, usd: 3, ...ws.budget, ...s.budget });

// The calls and money a conversation has used: its results' turns add up; its cost is its latest result's. A record
// without a result adds nothing.
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

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// One k run per task, or two would run its heavy job twice: k-run/<id>.json (the id URI-encoded) under $KIRUNAK_HOME
// holds the pid of the k run that drives it and its start, written inside a short mkdir mutex. A lock whose k run is
// dead, or whose pid is now another process or recorded no start, is taken over. → release().
export async function lockTask(ws, id, say = () => {}) {
  const dir = join(ws.home || kirunakHome(), 'k-run');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${encodeURIComponent(id)}.json`);
  const mutex = `${path}.take`;
  for (;;) {
    try {
      mkdirSync(mutex);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > 5000) rmSync(mutex, { recursive: true, force: true });
      } catch {}
      await sleep(10);
    }
  }
  try {
    const held = readJson(path);
    if (stillRuns(held?.pid, held?.pidStart)) throw refuse(`${id} has a k run already (pid ${held.pid}): one k run drives a task at a time`);
    writeFileSync(path, JSON.stringify({ pid: process.pid, pidStart: OWN_START, task: id, since: new Date().toISOString() }) + '\n');
    if (held?.pid) say(`took over the lock of k run ${held.pid}, which no longer runs`);
  } finally {
    rmSync(mutex, { recursive: true, force: true });
  }
  return () => readJson(path)?.pid === process.pid && rmSync(path, { force: true });
}

// Which k run started a `running` step, and its start: the one named by the run record of the session its `started`
// line names, or for a heavy step (no run record) by that line itself, which records no start. { krun: null } for a
// step started by hand.
export function startedBy(t, s) {
  const started = steps.events(t.progress).filter((e) => e.step === s.id && e.verb === 'started').at(-1)?.rest || '';
  if (s.kind === 'heavy') return { krun: Number(/, k run (\d+)\)$/.exec(started)?.[1]) || null, krunStart: null, rec: null };
  const sid = /\bsession ([A-Za-z0-9._-]+)/.exec(started)?.[1];
  const dir = steps.stepDir(t.p, s.id);
  if (!sid || !existsSync(dir)) return { krun: null, rec: null };
  const ks = readdirSync(dir).map((f) => /^run-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
  for (const k of ks) {
    const rec = readJson(join(dir, `run-${k}.json`));
    if (rec?.session_id === sid && rec.kirunak?.krun) return { krun: rec.kirunak.krun, krunStart: rec.kirunak.krunStart ?? null, rec };
  }
  return { krun: null, rec: null };
}

export function failureOf(o, minutes) {
  if (o.timedOut) return `no end within the budget's ${minutes} minutes`;
  const sub = o.result?.subtype && o.result.subtype !== 'success' ? ` (${o.result.subtype})` : '';
  if (o.exitCode !== 0) return `exit ${o.exitCode}${sub}`;
  if (!o.result) return 'no JSON result';
  if (o.result.is_error) return `the run ended in error (${o.result.subtype || 'is_error'})`;
  return null;
}

export async function run({ ws, id, watch = false, intervalMs = 30000, out = () => {}, clock = keeper.CLOCK, keepAliveMinutes = keeper.KEEP_ALIVE_MINUTES }) {
  const first = steps.load(ws, id);
  const problems = steps.gate(first);
  if (problems.length) throw refuse(`${id} cannot run:\n${problems.map((x) => `  ${x}`).join('\n')}`);
  const { p } = first;
  const session = `kirunak:${id}`;
  const inflight = new Map();
  const ended = {};
  // The machine slots this k run was admitted to and has not started a run in: given back however the step ends.
  const slots = new Set();
  const take = (slot) => (slots.add(slot), slot);
  const free = (slot) => {
    if (!slot?.held) return;
    slot.held = false;
    slots.delete(slot);
    release(ws, slot);
  };
  let stop = null;
  let refused = [];
  let firstPass = true;
  const say = (line) => out(`${id} ${line}`);
  const unlock = await lockTask(ws, id, say);
  // Every process this k run started and has not seen end, a step's run or a keep-alive: pid → step.
  const handles = new Map();
  // The devices its steps hold: step → device, released by the step's end or by a stop.
  const claimed = new Map();
  let stopping = null;
  // Once k run is stopped nothing new starts, and no step's end is written but the stop's own line.
  const halt = () => {
    if (stopping) throw new Error(steps.STOPPED.bySignal(stopping));
  };
  // Ctrl-C, a TERM or a closed terminal: every process of this k run is killed and unregistered (the guard ends a
  // heavy job itself), a step in flight fails only while it runs (a stop's failure, not one of its own), one waiting
  // for its job, or whose resume waits for a slot, keeps its request and conversation for the next k run, every device
  // its steps hold is released, and the lock goes; then the stop module exits.
  const offStop = onStop(async (signal) => {
    stopping = signal;
    const flying = [...inflight.keys()];
    const pids = [...handles.keys()];
    try {
      await Promise.all(pids.map((pid) => killTree(pid)));
      for (const pid of pids) unregister(ws, pid);
      [...slots].forEach(free);
      for (const [step, device] of claimed) {
        try {
          await ws.seams.resourceGuard.release(device, session);
        } catch (e) {
          say(`${step}: ${e.message}`);
        }
      }
      for (const step of flying) {
        try {
          const { state } = steps.load(ws, id).states.get(step);
          if (state === 'running') steps.fail({ ws, id, step, why: steps.STOPPED.bySignal(signal) });
          else if (state === 'waiting-heavy') say(`${step} waits for its job again: the next k run runs it`);
          else if (state === 'waiting-owner') say(`${step} still waits for the owner: the next k run resumes it`);
        } catch (e) {
          say(`${step}: ${e.message}`);
        }
      }
    } finally {
      unlock();
    }
  });

  // needs.json moved aside to needs-<k>.json, one index for every request, so nothing reads a request twice: a
  // failed run's is kept for the record and a retry starts without it; a resume's goes as its claude starts.
  // → its path, or null when there is none.
  function setAside(s) {
    const dir = steps.stepDir(p, s.id);
    if (!existsSync(join(dir, 'needs.json'))) return null;
    const to = join(dir, `needs-${steps.nextIndex(dir, 'needs')}.json`);
    renameSync(join(dir, 'needs.json'), to);
    return to;
  }

  async function heavyJob(s, job) {
    halt();
    const t0 = Date.now();
    const r = await ws.seams.resourceGuard.run({ session, what: job.what, maxMinutes: job.maxMinutes, command: job.command, cwd: p.root });
    halt();
    const minutes = Math.round(((Date.now() - t0) / 60000) * 100) / 100;
    return { r, saved: steps.saveHeavy(p, s.id, { ...job, exitCode: r.exitCode, minutes, log: r.log }) };
  }

  // The flags a step's runs and keep-alives share (orchestrator.md §3: a resume does not remember them); a review's
  // deny the implementer's account (review.md §1).
  const flagsOf = (s) => ({
    ...modelOf(ws, s), permissionMode: ws.runner?.permissionMode || 'auto', disallowedTools: ['Agent'], addDirs: [],
    ...(s.kind === 'review' ? { deny: steps.reviewDeny(steps.load(ws, id), s.id) } : {}),
    env: { KIRUNAK_TASK: id, KIRUNAK_STEP: s.id },
  });

  // A heavy job while the step's conversation waits, no process of it alive: the keeper keeps its cache warm
  // meanwhile, from the guard's estimate of the job's end (orchestrator.md §5).
  async function heavyWarm(s, sessionId, job) {
    const pending = heavyJob(s, job);
    await keeper.keepWarm({
      ws, session: sessionId, until: pending, clock, out: say, deadlineMinutes: keepAliveMinutes,
      expectedWait: async (now) => {
        const st = await ws.seams.resourceGuard.status();
        return keeper.jobWait(st, [session], now) ?? st.estimateMinutes ?? null;
      },
      keepAlive: () => {
        halt();
        const h = ws.seams.runner.keepAlive(sessionId, p.root, flagsOf(s));
        if (h.pid) handles.set(h.pid, s.id);
        return { pid: h.pid, done: h.done.then((r) => (handles.delete(h.pid), r?.result && steps.saveKeep(p, s.id, r.result), r)) };
      },
    }).catch((e) => say(`${s.id}: the keeper stopped: ${e.message}`));
    return pending;
  }

  // One conversation of an agent step, from its start or a resume, through its heavy jobs, to its end. A resume of
  // the owner's answer (`answered`) names the request in its prompt once it is set aside.
  async function converse(s, { sessionId, prompt, resume, slot, answered = false }) {
    const budget = budgetOf(ws, s);
    for (;;) {
      // A resume takes a slot as a start does: admitted and reserved at once, until its run is registered.
      if (!slot?.held) {
        let a;
        let waited = false;
        while (!(a = await admit(ws, ws.seams.machineGuard, { task: id, step: s.id })).ok) {
          if (resume && !waited) keeper.atSlotWait(ws, sessionId, a.why, clock.now());
          waited = true;
          await sleep(intervalMs);
        }
        slot = take(a.slot);
      }
      const used = resume ? usedBy(p, s.id, sessionId) : { turns: 0, usd: 0 };
      let record;
      let handle;
      try {
        halt();
        if (resume) {
          // A resume's hit or miss is its first call's: recorded once it has its slot and its device, as it starts.
          await keeper.atResume(ws, sessionId, clock.now());
          halt();
          // Its request goes aside only now, nothing awaited between here and the spawn: a stop or a crash before
          // leaves the step waiting, and the next k run runs the job again (or reads the answer) and resumes.
          const asked = setAside(s);
          if (answered) prompt = `the owner has answered the question of ${relative(p.root, asked)}; read ${p.rel('notes.md')} and any new amendment, then continue`;
          steps.note(p, s.id, `resumed (session ${sessionId})${answered ? ': the owner answered' : ''}`);
          answered = false;
        }
        record = steps.runRecord(p, s.id, sessionId);
        handle = await ws.seams.runner.start({
          ...flagsOf(s), brief: prompt, prompt, cwd: p.root, sessionId, resume,
          maxTurns: Math.max(1, budget.calls - used.turns), maxBudgetUsd: Math.max(0.01, Math.round((budget.usd - used.usd) * 100) / 100),
        });
        if (handle.pid) {
          handles.set(handle.pid, s.id);
          register(ws, handle.pid, { task: id, step: s.id, session: handle.sessionId || sessionId }, slot);
          if (stopping) killTree(handle.pid);
        }
      } finally {
        free(slot);
      }
      record.started(handle.pid);
      const o = await timed(handle, budget.minutes);
      handles.delete(handle.pid);
      if (handle.pid) unregister(ws, handle.pid);
      record.ended(o);
      halt();
      const needs = steps.readNeeds(steps.stepDir(p, s.id));
      let why = failureOf(o, budget.minutes) || needs?.error || null;
      const wait = (waitsFor) => o.result && keeper.track(ws, { session: sessionId, task: id, step: s.id, result: o.result, end: clock.now(), waitsFor, willResume: waitsFor === 'heavy', expectedWaitMin: null });
      if (!why && needs?.heavy) {
        steps.note(p, s.id, `waiting for a heavy job: ${needs.heavy.what}`);
        wait('heavy');
        const { saved } = await heavyWarm(s, sessionId, needs.heavy);
        steps.note(p, s.id, `heavy job ended: exit ${saved.record.exitCode} after ${saved.record.minutes} min (${relative(p.dir, saved.path)})`);
        [prompt, resume] = [`the job ended; read ${relative(p.root, saved.path)} and continue`, sessionId];
        continue;
      }
      if (!why && needs?.owner) {
        steps.note(p, s.id, `waiting for the owner: ${needs.owner}`);
        logEvent(ws, { time: new Date().toISOString(), kind: 'awaiting owner', task: id, step: s.id, question: needs.owner });
        if (wait('owner')) await keeper.judge(ws, sessionId, clock.now());
        return 'waiting-owner';
      }
      keeper.forget(ws, sessionId);
      const missing = why ? [] : steps.missingOutputs(p, s);
      if (missing.length) why = `missing outputs: ${missing.join(', ')}`;
      // A review's output check is its grammar (review.md §2): a review that fails it fails the step.
      const grammar = why ? [] : steps.outputCheck(ws, id, s);
      if (grammar.length) why = `${steps.reviewFileOf(s)} fails k review check (${grammar.length} problem${grammar.length > 1 ? 's' : ''})`;
      if (why) {
        const aside = setAside(s);
        const detail = [
          `Exit code ${o.exitCode}, session ${sessionId}.`,
          aside ? `Its needs.json is now ${relative(p.root, aside)}; a retry starts without it.` : '',
          grammar.length ? `k review check:\n\n${grammar.map((x) => `- ${x}`).join('\n')}` : '',
          o.result?.result ? `The run's last message:\n\n${o.result.result}` : '',
        ].filter(Boolean).join('\n\n');
        return steps.fail({ ws, id, step: s.id, why, detail }).escalated ? 'escalated' : 'failed';
      }
      steps.finish({ ws, id, step: s.id });
      return 'done';
    }
  }

  const agentStep = (s, st, slot) => withDevice(s, async () => {
    const retry = st.retry ? readdirSync(steps.stepDir(p, s.id)).filter((f) => /^failure-\d+\.md$/.test(f)).sort((a, b) => Number(a.slice(8, -3)) - Number(b.slice(8, -3))).at(-1) : null;
    const extra = retry ? [relative(p.root, join(steps.stepDir(p, s.id), retry))] : [];
    const sessionId = randomUUID();
    const { text } = await steps.brief({ ws, id, step: s.id, extraInputs: extra, session: sessionId });
    const { model, effort } = modelOf(ws, s);
    halt();
    // A request left by a run that failed or was stopped belongs to that run, not to this fresh conversation.
    setAside(s);
    await steps.start({ ws, id, step: s.id, session: sessionId, label: `${[model, effort].filter(Boolean).join(' ') || 'default model'}, session ${sessionId}` });
    return converse(s, { sessionId, prompt: text, resume: null, slot });
  });

  const heavyStep = (s) => withDevice(s, async () => {
    const what = s.what || s.title;
    halt();
    await steps.start({ ws, id, step: s.id, label: `heavy: ${what}, k run ${process.pid}` });
    const { saved } = await heavyJob(s, { what, command: ['/bin/sh', '-c', s.command], maxMinutes: s.maxMinutes || budgetOf(ws, s).minutes });
    const missing = steps.missingOutputs(p, s);
    const why = saved.record.exitCode !== 0 ? `exit ${saved.record.exitCode}` : missing.length ? `missing outputs: ${missing.join(', ')}` : null;
    if (why) return steps.fail({ ws, id, step: s.id, why, detail: `The log: ${saved.record.report}` }).escalated ? 'escalated' : 'failed';
    steps.finish({ ws, id, step: s.id });
    return 'done';
  });

  // A plan step's `device:` is claimed for the step and released however it ends, a stop of k run included.
  async function withDevice(s, fn) {
    if (!s.device) return fn();
    await ws.seams.resourceGuard.claim(s.device, session, `${id} ${s.id}`);
    claimed.set(s.id, s.device);
    try {
      return await fn();
    } finally {
      claimed.delete(s.id);
      await ws.seams.resourceGuard.release(s.device, session);
    }
  }

  // A step a dead k run left `running`: its claude, if it still runs, is killed, since nobody will collect its result
  // (a heavy step's job is the guard's, whose next take ends it), and the step fails with a stop's failure, which is
  // not one of its own, so it is retried. One started by hand is left. A pid is that claude only while it started when
  // the record (claudeStart) or its running/ file (since) says: a pid reused since, or one with no start recorded, is
  // left alone. The k run is gone, likewise, once its pid is another process or no start of it was recorded.
  async function orphans() {
    const t = steps.load(ws, id);
    for (const s of t.plan.steps) {
      if (t.states.get(s.id).state !== 'running') continue;
      const { krun, krunStart, rec } = startedBy(t, s);
      if (!krun) say(`${s.id} is running by hand`);
      else if (stillRuns(krun, krunStart)) say(`${s.id} is running under pid ${krun}`);
      else {
        const listed = !rec ? [] : (await ws.seams.machineGuard.running()).filter((g) => g.task === id && g.step === s.id && g.session === rec.session_id);
        const starts = new Map();
        for (const [pid, at] of [[rec?.kirunak.claude, rec?.kirunak.claudeStart], ...listed.map((g) => [g.pid, g.since])]) {
          if (groupAlive(pid)) starts.set(pid, [...(starts.get(pid) || []), at]);
        }
        const ours = [...starts].filter(([pid, at]) => at.some((a) => isStill(pid, a))).map(([pid]) => pid);
        const others = [...starts.keys()].filter((pid) => !ours.includes(pid));
        for (const pid of ours) await killTree(pid);
        // Every listed file is this step's, whoever holds its pid now.
        for (const pid of new Set([...ours, ...listed.map((g) => g.pid)])) unregister(ws, pid);
        steps.fail({ ws, id, step: s.id, why: steps.STOPPED.orphan });
        const what = [
          ...(ours.length ? [`its claude (pid ${ours.join(', ')}) was killed`] : []),
          ...others.map((pid) => `pid ${pid} is not the claude of that run, so it was left running`),
        ];
        say(`${s.id} failed: the k run that started it (pid ${krun}) stopped${what.map((x) => `; ${x}`).join('')}`);
      }
    }
  }

  const launch = (s, fn, slot = null) => {
    say(`${s.id} starts`);
    const run = fn()
      .catch((e) => {
        say(`${s.id}: ${e.message}`);
        if (stopping) return 'stopped';
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
      if (stop || stopping) break;
      if (inflight.has(s.id)) continue;
      const st = t.states.get(s.id);
      if (st.state === 'failed') steps.escalate({ ws, id, step: s.id });
      if (st.state === 'failed' || st.state === 'escalated') stop = `${s.id} is marked [escalate] in plan.md: it failed twice; the owner's session decides`;
      // A waiting step resumes the conversation its `started` line names and k run ran; one started by hand has none,
      // and its own session resumes itself, so no claude starts here with nothing but the resume prompt.
      else if (st.state === 'waiting-owner' && !startedBy(t, s).rec) stop = `${s.id} was started by hand: its session resumes itself; its question is ${relative(p.dir, join(steps.stepDir(p, s.id), 'needs.json'))}`;
      else if (st.state === 'waiting-owner' && !firstPass) stop = `${s.id} waits for the owner: ${st.needs.owner}`;
      else if (st.state === 'waiting-owner') {
        const sid = startedBy(t, s).rec.session_id;
        launch(s, () => withDevice(s, () => converse(s, { sessionId: sid, resume: sid, answered: true })));
      } else if (st.state === 'waiting-heavy') {
        const { rec } = startedBy(t, s);
        const sid = rec?.session_id ?? null;
        launch(s, async () => {
          // A k run that ended while the job was asked for: the conversation is tracked from its record.
          if (sid && steps.hasResult(rec) && !keeper.readSession(keeper.homeOf(ws), sid)) keeper.track(ws, { session: sid, task: id, step: s.id, result: rec, end: new Date(rec.kirunak.ended), waitsFor: 'heavy', willResume: true });
          const { saved } = await (sid ? heavyWarm(s, sid, st.needs.heavy) : heavyJob(s, st.needs.heavy));
          const record = relative(p.dir, saved.path);
          const ended = `heavy job ended: exit ${saved.record.exitCode} after ${saved.record.minutes} min (${record})`;
          if (!sid) {
            setAside(s);
            steps.note(p, s.id, `${ended}; started by hand, its session resumes itself`);
            say(`${s.id} was started by hand: its session resumes itself; the job's record is ${record}`);
            return 'started by hand';
          }
          steps.note(p, s.id, ended);
          return withDevice(s, () => converse(s, { sessionId: sid, resume: sid, prompt: `the job ended; read ${relative(p.root, saved.path)} and continue` }));
        });
      } else if (st.state !== 'ready') continue;
      else if (s.kind === 'owner') stop = `${s.id} waits for the owner: ${s.title}${s.outputs.length ? ` (it needs ${s.outputs.join(', ')})` : ''}`;
      else if (LATER[s.kind]) stop = `${s.id} is a ${s.kind} step, which comes with ${LATER[s.kind]}`;
      else if (s.kind === 'heavy') launch(s, () => heavyStep(s));
      else {
        const a = await admit(ws, ws.seams.machineGuard, { task: id, step: s.id });
        if (!a.ok) {
          refused.push(`${s.id} waits for the machine: ${a.why}`);
          continue;
        }
        const slot = take(a.slot);
        launch(s, () => agentStep(s, st, slot), slot);
      }
    }
    firstPass = false;
  }

  try {
    await orphans();
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
    // Stopped: the steps it stopped end here first, and the stop module ends the process once its callbacks are done.
    if (stopping) await new Promise(() => {});
  } finally {
    offStop();
    [...slots].forEach(free);
    unlock();
  }
  const states = steps.load(ws, id).states;
  for (const r of refused) say(r);
  if (stop) say(`stopped: ${stop}`);
  return { ended, stopped: stop, refused, states: Object.fromEntries([...states].map(([k, v]) => [k, v.state])) };
}

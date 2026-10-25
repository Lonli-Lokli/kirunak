import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { logEvent } from './approval.mjs';
import { runFields } from './cost.mjs';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import * as keeper from './keeper.mjs';
import { attemptsOf, buildRungFor } from './ladder.mjs';
import { notice, stopNotice } from './notice.mjs';
import * as steps from './steps.mjs';
import { onStop } from './stop.mjs';
import { admit, register, release, unregister } from '../plugins/machine-guard-pids.mjs';
import { groupAlive, isStill, killTree, OWN_START, stillRuns } from '../plugins/resource-guard-local.mjs';

// `k run <id> [--once|--watch]` (orchestrator.md §2): a plain Node loop, no model. Each pass reads the files, starts
// every ready step the machine guard admits, and waits; --watch passes every 30 s and ends when no step is ready,
// nothing runs and no step is left undecided for a ps that could not answer, or when the task stops (an owner's
// question, a step marked [escalate]). A stop for the owner ends with one more line, `kirunak-push: <text>`, which
// the escalation hook of the session that started k run in the background turns into a push to the owner's phone
// (gulnya/enforced-escalation S-2 design R7.2, E-16); a climb k run carries on with prints a plain line and no push.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LATER = { sync: 'slice 5 (boards.md §3)' };

// The plan line's model and effort, else the workspace's models.<kind>, else none (Claude Code's own default): in
// lib/steps.mjs, whose ladder rules read it (gulnya/enforced-escalation S-2 design R2.1).
export const modelOf = steps.modelOf;

export const budgetOf = (ws, s) => ({ calls: 100, minutes: 40, usd: 3, ...ws.budget, ...s.budget });

// The calls, money and tokens a conversation has used: its results' turns and tokens add up (lib/cost.mjs reads
// them); its cost is its latest result's. A record without a result adds nothing.
export function usedBy(p, step, sessionId) {
  const dir = steps.stepDir(p, step);
  let turns = 0;
  let usd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const f of readdirSync(dir).filter((x) => /^run-\d+\.json$/.test(x))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (r.session_id !== sessionId) continue;
    turns += Number(r.num_turns) || 0;
    usd = Math.max(usd, Number(r.total_cost_usd) || 0);
    for (const k of Object.keys(tokens)) tokens[k] += runFields(r).usage[k];
  }
  return { turns, usd, tokens };
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
  // The push of a stop for the owner: the ladder spent, a step marked [escalate], a question waiting for the owner or
  // an owner step; a task the owner parked has none.
  let push = null;
  let parked = false;
  let refused = [];
  let firstPass = true;
  const say = (line) => out(`${id} ${line}`);
  // Records the push of a stop for the owner and returns its stop line: for a step k waiting shows as stopped for the
  // owner (E-15), the words it shows there, on one line with the task's title (R7.1); else the words given.
  const title = first.task.front.title;
  const forOwner = (line, step, words = null) => {
    const shown = step && steps.stopsOf(ws, p).find((x) => x.step === step);
    push = words ?? (shown ? stopNotice({ title, id }, shown) : notice({ title, id, step, what: 'stopped for you', next: 'k waiting says why' })).one;
    return line;
  };
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
    const r = await ws.seams.resourceGuard.run({ session, what: job.what, maxMinutes: job.maxMinutes, command: job.command, cwd: p.root, say: (line) => say(`${s.id} ${line}`) });
    halt();
    const minutes = Math.round(((Date.now() - t0) / 60000) * 100) / 100;
    const saved = steps.saveHeavy(p, s.id, { ...job, exitCode: r.exitCode, minutes, log: r.log });
    logEvent(ws, { time: new Date().toISOString(), kind: 'build-ended', task: id, step: s.id, what: job.what, exitCode: r.exitCode, minutes });
    return { r, saved };
  }

  // The flags a step's runs and keep-alives share (orchestrator.md §3: a resume does not remember them); a review's
  // deny the implementer's account (review.md §1).
  // The model is the one the step's attempt runs on: its own, or its rung's once it climbed.
  const flagsOf = (s) => {
    const t = steps.load(ws, id);
    return {
      ...steps.attemptModel(ws, s, t.progress), permissionMode: ws.runner?.permissionMode || 'auto', disallowedTools: ['Agent'], addDirs: [],
      ...(s.kind === 'review' ? { deny: steps.reviewDeny(t, s.id) } : {}),
      env: { KIRUNAK_TASK: id, KIRUNAK_STEP: s.id },
    };
  };

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

  // A rung run's end in events.jsonl (S-2 design R3.1, AC-21): its rung, its phase, whether it passed, and the tokens
  // and cost of its conversation from the run records, the newest named.
  function rungRunEnded(s, { rung, phase, passed, sessionId, record }) {
    if (!rung) return;
    const { usd, tokens } = usedBy(p, s.id, sessionId);
    logEvent(ws, {
      time: new Date().toISOString(), kind: 'escalated-run', task: id, step: s.id, rung: { model: rung.model, effort: rung.effort ?? null, mode: steps.modeFor(s, rung) },
      phase, passed, tokens, costUsd: usd, record: relative(p.dir, record.path),
    });
  }

  // One conversation of an agent step, from its start or a resume, through its heavy jobs, to its end. A resume of
  // the owner's answer (`answered`) names the request in its prompt once it is set aside. On a rung (S-2 design R2.4)
  // its end is an event; a design run's one output is its `design` file, in place of the step's outputs, and once it
  // is written the run ends `designed`, the step still running for its build run.
  async function converse(s, { sessionId, prompt, resume, slot, answered = false, rung = null, phase = 'build', design = null }) {
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
      const missing = why ? [] : design ? [design].filter((d) => !existsSync(join(p.dir, d))) : steps.missingOutputs(p, s);
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
        steps.fail({ ws, id, step: s.id, why, detail });
        rungRunEnded(s, { rung, phase, passed: false, sessionId, record });
        return 'failed';
      }
      if (!design) steps.finish({ ws, id, step: s.id });
      rungRunEnded(s, { rung, phase, passed: true, sessionId, record });
      return design ? 'designed' : 'done';
    }
  }

  // A fresh conversation: a step's first run, its own retry, which reads the newest failure report, or a run of an
  // attempt on the rung it climbed to, which reads every report (S-2 design R2.6). Its `started` line names the rung
  // and the run (R2.7): `rung opus`; a design run's `rung fable design`, on the rung's model; a design attempt's build
  // run's `rung fable build on opus high`, on the rung that builds it, which a build run that follows its design run
  // writes by itself, the step running already.
  async function fresh(s, retry, slot = null) {
    const rung = retry?.rung ?? null;
    const designing = rung && retry.phase === 'design';
    const builder = rung && retry.design ? buildRungFor(steps.ladderOf(ws), rung) ?? rung : rung;
    const sessionId = randomUUID();
    const b = await steps.brief({ ws, id, step: s.id, retry, session: sessionId });
    const { model, effort } = builder ? { model: builder.model, effort: builder.effort ?? null } : modelOf(ws, s);
    const on = [model, effort].filter(Boolean).join(' ') || 'default model';
    const run = !rung ? '' : designing ? `, rung ${rung.model} design` : retry.design ? `, rung ${rung.model} build on ${on}` : `, rung ${rung.model}`;
    const label = `${on}, session ${sessionId}${run}`;
    halt();
    // A request left by a run that failed or was stopped belongs to that run, not to this fresh conversation.
    setAside(s);
    if (steps.historyOf(steps.load(ws, id).progress, s.id).last === 'started') steps.note(p, s.id, `started (${label})`);
    else await steps.start({ ws, id, step: s.id, session: sessionId, label });
    return converse(s, { sessionId, prompt: b.text, resume: null, slot, rung, phase: designing ? 'design' : 'build', design: designing ? b.design : null });
  }

  // A design attempt's build run (R2.4 b): a fresh conversation on the rung below the design rung, its brief naming
  // the design first, then every failure report since the step's count started.
  function buildRun(s, design, slot = null) {
    const t = steps.load(ws, id);
    const retry = { ...steps.retryOf(ws, p, s, steps.historyOf(t.progress, s.id)), phase: 'build', design };
    const by = buildRungFor(steps.ladderOf(ws), retry.rung) ?? retry.rung;
    say(`${s.id} builds ${design} on ${[by.model, by.effort].filter(Boolean).join(' ')}`);
    return fresh(s, retry, slot);
  }

  // A step's attempt where it stands: on a design rung its design run, then its build run (one attempt: either
  // failing fails it); a design attempt whose build run was stopped starts again at its build run; anywhere else one
  // fresh conversation.
  const attemptStep = (s, st, slot) => withDevice(s, async () => {
    const retry = st.retry;
    if (retry?.rung && retry.phase === 'design') {
      const r = await fresh(s, retry, slot);
      return r === 'designed' ? buildRun(s, designOf(s)) : r;
    }
    if (retry?.rung && retry.design) return buildRun(s, retry.design, slot);
    return fresh(s, retry, slot);
  });

  // The design file a design run writes: the one its brief names last (steps/S-n/design-brief.md, R2.4).
  const designOf = (s) => {
    const names = readFileSync(join(steps.stepDir(p, s.id), 'design-brief.md'), 'utf8').match(/design-\d+\.md/g) || [];
    return names.length ? `steps/${s.id}/${names.at(-1)}` : null;
  };

  // A resume of a conversation k run started, after its heavy job or the owner's answer: on the rung and in the run its
  // `started` line names (R2.7), so a build run stays on its build model and a design run's checks its design file,
  // then goes on to its build run.
  const RUN_LABEL = /, rung (\S+)( design| build on [^)]*)?\)$/;
  async function resumeStep(s, opts) {
    const started = steps.events(steps.load(ws, id).progress).filter((e) => e.step === s.id && e.verb === 'started').at(-1)?.rest || '';
    const m = RUN_LABEL.exec(started);
    const rung = m ? steps.ladderOf(ws).find((r) => r.model === m[1]) ?? { model: m[1] } : null;
    const design = m?.[2] === ' design' ? designOf(s) : null;
    const r = await converse(s, { ...opts, resume: opts.sessionId, rung, phase: design ? 'design' : 'build', design });
    return r === 'designed' ? buildRun(s, design) : r;
  }

  const heavyStep = (s) => withDevice(s, async () => {
    const what = s.what || s.title;
    halt();
    await steps.start({ ws, id, step: s.id, label: `heavy: ${what}, k run ${process.pid}` });
    const { saved } = await heavyJob(s, { what, command: ['/bin/sh', '-c', s.command], maxMinutes: s.maxMinutes || budgetOf(ws, s).minutes });
    const missing = steps.missingOutputs(p, s);
    const why = saved.record.exitCode !== 0 ? `exit ${saved.record.exitCode}` : missing.length ? `missing outputs: ${missing.join(', ')}` : null;
    if (why) {
      steps.fail({ ws, id, step: s.id, why, detail: `The log: ${saved.record.report}` });
      return 'failed';
    }
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
  // left alone. The k run is gone, likewise, once its pid is another process or no start of it was recorded. A pid ps
  // cannot tell about now may be either, so the step is left running as it is, for a later k run to decide or, under
  // --watch, a later pass: the steps left so are returned, and `only` asks about those alone, saying so once a step.
  const toldUnknown = new Set();
  async function orphans(only = null) {
    const t = steps.load(ws, id);
    const left = new Set();
    for (const s of t.plan.steps) {
      if (only && !only.has(s.id)) continue;
      if (t.states.get(s.id).state !== 'running') continue;
      const { krun, krunStart, rec } = steps.startedBy(t, s);
      if (!krun) say(`${s.id} is running by hand`);
      else if (stillRuns(krun, krunStart)) say(`${s.id} is running under pid ${krun}`);
      else {
        const listed = !rec ? [] : (await ws.seams.machineGuard.running()).filter((g) => g.task === id && g.step === s.id && g.session === rec.session_id);
        const starts = new Map();
        for (const [pid, at] of [[rec?.kirunak.claude, rec?.kirunak.claudeStart], ...listed.map((g) => [g.pid, g.since])]) {
          if (groupAlive(pid)) starts.set(pid, [...(starts.get(pid) || []), at]);
        }
        // true: that claude; null: ps cannot tell; false: another process, or no start recorded.
        const answer = new Map([...starts].map(([pid, at]) => {
          const all = at.map((a) => isStill(pid, a));
          return [pid, all.includes(true) ? true : all.includes(null) ? null : false];
        }));
        const unknown = [...answer].filter(([, a]) => a === null).map(([pid]) => pid);
        if (unknown.length) {
          left.add(s.id);
          if (!toldUnknown.has(s.id)) say(`${s.id} is left running: ps gave no answer for pid ${unknown.join(', ')}, so its claude is believed to run`);
          toldUnknown.add(s.id);
          continue;
        }
        const ours = [...answer].filter(([, a]) => a === true).map(([pid]) => pid);
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
    return left;
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
        steps.fail({ ws, id, step: s.id, why: `kirunak stopped the step: ${e.message}` });
        return 'failed';
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
    refused = [];
    // Parked while k run --watch went on: the steps running end as they will, and no other starts (AC-16). The owner
    // parked it, so no push tells them so (E-16: a push is for a stop for them); the stop line names k queue add.
    if (!steps.queued(ws, id)) {
      stop = steps.PARKED(id);
      parked = true;
      return;
    }
    const t = steps.load(ws, id);
    for (const s of t.plan.steps) {
      if (stop || stopping) break;
      if (inflight.has(s.id)) continue;
      let st = t.states.get(s.id);
      // A step that failed as often as it may where it stands climbs one rung, and its attempt there starts in this
      // pass (S-2 design R2.2), an event and one plain line (R3.1, R2.8: nothing for the owner, E-17); past the top
      // rung, or a heavy step's second failure, stops the task for the owner with R2.7's line.
      if (st.state === 'failed') {
        const { to, from, failures } = steps.climb({ ws, id, step: s.id });
        if (to) {
          const attempts = attemptsOf(to);
          logEvent(ws, {
            time: new Date().toISOString(), kind: 'escalate', trigger: 'k run failure count', task: id, step: s.id, failures,
            from: { model: from }, to: { model: to.model, effort: to.effort ?? null, mode: steps.modeFor(s, to), attempt: 1 },
          });
          say(`${s.id} climbs to ${to.model}${to.effort ? ` (${to.effort})` : ''}: attempt 1 of ${attempts}`);
          st = steps.load(ws, id).states.get(s.id);
        } else {
          const { why, last } = steps.escalate({ ws, id, step: s.id });
          stop = forOwner(`${s.id} ${why}; the owner decides${last ? `: read ${last}` : ''}`, s.id);
          continue;
        }
      }
      if (st.state === 'escalated') stop = forOwner(`${s.id} is marked [escalate] in plan.md: the owner's session decides`, s.id);
      // A waiting step resumes the conversation its `started` line names and k run ran; one started by hand has none,
      // and its own session resumes itself, so no claude starts here with nothing but the resume prompt.
      else if (st.state === 'waiting-owner' && !steps.startedBy(t, s).rec) stop = forOwner(`${s.id} was started by hand: its session resumes itself; its question is ${relative(p.dir, join(steps.stepDir(p, s.id), 'needs.json'))}`, s.id);
      else if (st.state === 'waiting-owner' && !firstPass) stop = forOwner(`${s.id} waits for the owner: ${st.needs.owner}`, s.id);
      else if (st.state === 'waiting-owner') {
        const sid = steps.startedBy(t, s).rec.session_id;
        launch(s, () => withDevice(s, () => resumeStep(s, { sessionId: sid, answered: true })));
      } else if (st.state === 'waiting-heavy') {
        const { rec } = steps.startedBy(t, s);
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
          return withDevice(s, () => resumeStep(s, { sessionId: sid, prompt: `the job ended; read ${relative(p.root, saved.path)} and continue` }));
        });
      } else if (st.state !== 'ready') continue;
      else if (s.kind === 'owner') {
        const needs = s.outputs.length ? ` (it needs ${s.outputs.join(', ')})` : '';
        stop = forOwner(`${s.id} waits for the owner: ${s.title}${needs}`, null, notice({ title, id, step: s.id, what: `is yours: ${s.title}${needs}`, next: `once it is done: k step finish ${id} ${s.id}` }).one);
      }
      else if (LATER[s.kind]) stop = `${s.id} is a ${s.kind} step, which comes with ${LATER[s.kind]}`;
      else if (s.kind === 'heavy') launch(s, () => heavyStep(s));
      else {
        const a = await admit(ws, ws.seams.machineGuard, { task: id, step: s.id });
        if (!a.ok) {
          refused.push(`${s.id} waits for the machine: ${a.why}`);
          continue;
        }
        const slot = take(a.slot);
        launch(s, () => attemptStep(s, st, slot), slot);
      }
    }
    firstPass = false;
  }

  try {
    let undecided = await orphans();
    await pass();
    if (watch) {
      // A step left running because ps could not answer keeps the watch alive, and each pass asks about it again.
      while (inflight.size || (undecided.size && !stopping) || (!stop && refused.length)) {
        let tick;
        await Promise.race([...inflight.values(), new Promise((r) => (tick = setTimeout(r, intervalMs)))]);
        clearTimeout(tick);
        if (undecided.size && !stopping) undecided = await orphans(undecided);
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
  // A k run --once ends without a pass to stop it at a question asked in this run, which waits for the owner all
  // the same, unless the owner parked the task. The push is the last line, for the escalation hook to find in the
  // output's tail.
  const asked = Object.keys(ended).find((step) => ended[step] === 'waiting-owner' && states.get(step)?.state === 'waiting-owner');
  if (!push && !parked && asked) forOwner(null, asked);
  if (push) out(`kirunak-push: ${push}`);
  return { ended, stopped: stop, push, refused, states: Object.fromEntries([...states].map(([k, v]) => [k, v.state])) };
}

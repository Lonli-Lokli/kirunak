// fable.txt (gulnya/usage-improve-11-22 AC-13): which work the week gave Fable, and whether it paid. A row per Fable
// step (a headless step session, or a step interval in another session, whose calls' model is in the fable family:
// only those calls count) and per Fable agent (an agent's calls on a fable model), with its task, its step or agent
// type, its weight (common.mjs's, in Opus-input tokens), its calls, its first call's context and its role:
// - `escalation`: an agent of type fable-step, or a step k run ran on a Fable rung (an `escalated-run` event in
//   events.jsonl whose rung's model is fable);
// - `review`: a review step (plan.md's kind), or a step whose title or `what:` names a review, or an agent whose
//   description does;
// - else `design`.
// A design is `redone` when its step id was started again after it finished (progress.md's lines), or a later Fable
// design step of the same task covers one of its ids (plan.md's `covers:`); the reason follows in brackets.
// Steps and agents are joined to their task and step by tasks.mjs's joinOf, an agent at its first call as bytask.mjs
// joins it. Fable calls in a main session outside every step are counted on the last line, not listed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan } from '../plan.mjs';
import { contextOf, jsonLines, printer, weight } from './common.mjs';
import { NO_TASK } from './bytask.mjs';
import { joinOf } from './tasks.mjs';

export const FABLE = /fable/i;
const REVIEW = /review/i;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;

// The task's plan steps by id, from the first of its checkouts holding a plan.md; an empty map with none.
function planOf(t) {
  const dir = t?.dirs?.find((d) => existsSync(join(d, 'plan.md')));
  if (!dir) return new Map();
  try {
    return new Map(parsePlan(readFileSync(join(dir, 'plan.md'), 'utf8')).steps.map((s) => [s.id, s]));
  } catch {
    return new Map();
  }
}

// `rows` are calls.jsonl's, `tasks` readTasks's, `home` $KIRUNAK_HOME (its sessions/ and events.jsonl).
export function fable({ rows, tasks, home, from: FROM, to: TO }) {
  const xs = rows.filter((c) => c.kind === 'call' && c.model !== '<synthetic>' && c.ts >= FROM && c.ts < TO)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const of = joinOf({ tasks, home, sessions: new Set(xs.map((c) => c.session)) });
  const firstOfAgent = new Map();
  for (const c of xs) if (c.sub && !firstOfAgent.has(`${c.session}/${c.sub}`)) firstOfAgent.set(`${c.session}/${c.sub}`, c.ts);

  const groups = new Map(), loose = { calls: 0, weight: 0 };
  for (const c of xs) {
    if (!FABLE.test(c.model || '')) continue;
    const agent = c.sub ? `${c.session}/${c.sub}` : null;
    const { task, step } = of(c.session, Date.parse(agent ? firstOfAgent.get(agent) : c.ts));
    if (!agent && !step) {
      loose.calls++, loose.weight += weight(c);
      continue;
    }
    // A step's row is the step in one session: a step run twice by two sessions is two rows, each judged on its own.
    const key = agent ? `agent ${agent}` : `step ${task} ${step} ${c.session}`;
    if (!groups.has(key)) groups.set(key, { task, step, agent: agent ? (c.agentType || 'agent') : null, desc: c.desc || '', first: c, calls: 0, weight: 0 });
    const g = groups.get(key);
    g.calls++, g.weight += weight(c);
  }

  const plans = new Map(), planFor = (id) => plans.get(id) ?? plans.set(id, planOf(tasks.get(id))).get(id);
  const events = jsonLines(join(home, 'events.jsonl')).filter((e) => e.kind === 'escalated-run' && FABLE.test(e.rung?.model || '') && !(e.time >= TO));
  const list = [...groups.values()];
  for (const g of list) {
    const ps = g.task && g.step ? planFor(g.task).get(g.step) : null;
    g.covers = (ps?.covers ?? []).filter((x) => x !== 'all');
    if (g.agent) g.role = g.agent === 'fable-step' ? 'escalation' : REVIEW.test(g.desc) ? 'review' : 'design';
    else if (events.some((e) => e.task === g.task && e.step === g.step)) g.role = 'escalation';
    else g.role = ps?.kind === 'review' || REVIEW.test(ps?.title ?? '') || REVIEW.test(ps?.what ?? '') ? 'review' : 'design';
  }
  for (const g of list.filter((x) => x.role === 'design' && x.task && x.step)) {
    const at = Date.parse(g.first.ts), why = [];
    // Its step started again after a run of it that finished once this design had begun.
    const ivs = tasks.get(g.task)?.steps.filter((iv) => iv.step === g.step) ?? [];
    if (ivs.some((a) => a.finished != null && a.end >= at && ivs.some((b) => b.start > a.finished))) why.push(`${g.step} started again`);
    // A later Fable design step of the task, run in the week, covering one of its ids.
    const later = list.filter((x) => !x.agent && x.role === 'design' && x.task === g.task && x.step !== g.step && Date.parse(x.first.ts) > at)
      .sort((a, b) => (a.first.ts < b.first.ts ? -1 : 1));
    for (const x of later) {
      const id = x.covers.find((c) => g.covers.includes(c));
      if (id) {
        why.push(`${x.step} covers ${id}`);
        break;
      }
    }
    if (why.length) g.redone = why.join('; ');
  }

  list.sort((a, b) => b.weight - a.weight || (a.first.ts < b.first.ts ? -1 : 1));
  const steps = list.filter((g) => !g.agent), agents = list.filter((g) => g.agent);
  const sum = (a) => a.reduce((s, g) => s + g.weight, 0), n = (r) => list.filter((g) => g.role === r).length;
  const p = printer();
  p.log(`fable: ${steps.length} steps (weight ${M(sum(steps))}), ${agents.length} agents (weight ${M(sum(agents))}); design ${n('design')}, review ${n('review')}, escalation ${n('escalation')}; designs redone ${list.filter((g) => g.redone).length}`);
  p.log("each Fable step and agent, heaviest first: task, step or agent type (its step), weight in Opus-input tokens, calls, first call's context, role; a design is redone when its step started again after it finished or a later Fable design step of its task covers one of its ids");
  const what = (g) => (g.agent ? `agent ${g.agent}${g.step ? ` (${g.step})` : ''}` : g.step);
  const tw = Math.max(0, ...list.map((g) => (g.task ?? NO_TASK).length)), ww = Math.max(0, ...list.map((g) => what(g).length));
  for (const g of list) {
    p.log(`${(g.task ?? NO_TASK).padEnd(tw)}  ${what(g).padEnd(ww)}  ${M(g.weight).padStart(7)}  ${String(g.calls).padStart(4)} calls  first ${Math.round(contextOf(g.first) / 1e3)}k  ${g.role}${g.redone ? `, redone (${g.redone})` : ''}`);
  }
  p.log(`Fable calls in a main session outside every step (not listed): ${loose.calls} (weight ${M(loose.weight)})`);
  return p.text();
}

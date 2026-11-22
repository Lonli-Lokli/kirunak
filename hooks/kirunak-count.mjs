#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { readSession } from '../lib/keeper.mjs';
import { isId, readJson, taskDir } from './compact-rules.mjs';
import { lastCall } from './kirunak-stale.mjs';

// The count hook (gulnya/usage-improve-11-22 AC-15), on PostToolUse for every tool: a call is a tool call. Inside an
// agent (the input's `agent_id`) it counts that agent's calls, each agent of a session apart, and at the agent's 75th
// call gives it AGENT_SOON, at its 100th AGENT_LAST, each once, as additionalContext: a long agent is the cost (each of
// its calls re-reads all it has gathered), so it is told to hand over before it grows past 100. A main session's call
// (no `agent_id`) gets no agent notice.
//
// A stretch outside any step (gulnya/usage-improve-11-22 AC-12): in a main session that holds a task (its session
// file's `task`, which k start wrote) and is not a k run step (no KIRUNAK_STEP in its env), a Bash call running `k step
// start` begins a step, and the calls in it are not counted; one running `k step finish` or `k step fail` ends it and
// starts a new stretch. A stretch's calls are counted, and its context growth: the transcript tail's last call's
// context minus the stretch's first call's. At STRETCH.calls calls or STRETCH.context growth, once per stretch, it gives
// stretchNotice as additionalContext: work done in the task's session re-reads all of it, a k run step starts fresh. The
// step it names is the plan's first ready one, else the first not finished, read through lib's own readers (held.mjs,
// plan.mjs, steps.mjs stepStates) only when the notice is due, so the other calls load none of them; a task folder or
// plan it cannot read gives the notice without a step. A session holding no task counts nothing; a new task starts a
// new stretch.
//
// Its counts are in <home>/counts/<session>.json, `{ agents: { <agent_id>: { calls, told: [75, 100] } },
// main: { task, inStep, calls, base, told } }`, written
// whole through a file beside it and a rename, so a reader never sees half of one. Agents of one session that run at
// once can lose a count to each other; a notice is given at or past its call and kept in `told`, so a lost count delays
// it by a call and never skips it.
//
// It never blocks: no `decision`, never a non-zero exit. It fails open: input it cannot read, a session id that is not
// an id, or a count file it cannot write lets the call through silent; a count file that is not JSON starts again.

export const AGENT_SOON = 'About 25 calls are left for this agent: finish the piece in hand, and write what is left to a handoff file by call 100.';
export const AGENT_LAST = "Return now with the short report and the handoff file's path.";
export const AGENT_NOTICES = Object.freeze([[75, AGENT_SOON], [100, AGENT_LAST]]);

export const STRETCH = Object.freeze({ calls: 150, context: 150_000 });
// `k step start|finish|fail`, as k or as kirunak's bin/k.mjs, anywhere in a Bash command; the last one counts.
const STEP_COMMAND = /(?:^|[^\w.-])k(?:\.mjs)?\s+step\s+(start|finish|fail)\b/g;

/** The notice for a stretch past its threshold: `calls` when it was the count, else the context `growth`. */
export function stretchNotice({ task, step = null, calls = null, growth = 0 }) {
  const what = calls !== null ? `made ${calls} calls` : `grown ${Math.round(growth / 1000)}k tokens of context`;
  const next = step
    ? `the plan's next step, ${step.id} (${step.title}), runs in a session of its own with \`k run ${task}\``
    : `the plan's next steps run in sessions of their own with \`k run ${task}\``;
  return `kirunak's count hook: this session has ${what} outside any step of ${task} since its last one, and each ` +
    `call from here re-reads all of it. Before other work, offer the user in one line: ${next}; or write the handoff ` +
    `with \`k handoff ${task}\` and go on in a fresh session. If they want to go on here, do so.`;
}

export const countPath = (home, session) => join(home, 'counts', `${session}.json`);

function readCounts(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch {}
  return {};
}

function writeCounts(file, counts) {
  mkdirSync(join(file, '..'), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(counts) + '\n');
  renameSync(part, file);
}

/** One agent call counted: the notice it is due now, or null. Throws when the count cannot be kept. */
function countAgent(home, session, agent) {
  const file = countPath(home, session);
  const counts = readCounts(file);
  const agents = counts.agents && typeof counts.agents === 'object' && !Array.isArray(counts.agents) ? counts.agents : {};
  const was = agents[agent] ?? {};
  const calls = (Number.isInteger(was.calls) && was.calls > 0 ? was.calls : 0) + 1;
  const told = Array.isArray(was.told) ? was.told.filter(Number.isInteger) : [];
  const due = AGENT_NOTICES.filter(([at]) => calls >= at && !told.includes(at)).at(-1);
  // Past 100 with neither given (a count file lost its told), only the last is said; both are marked.
  if (due) told.push(...AGENT_NOTICES.map(([at]) => at).filter((at) => at <= due[0] && !told.includes(at)));
  writeCounts(file, { ...counts, agents: { ...agents, [agent]: { calls, told } } });
  return due ? due[1] : null;
}

/** The verb of the last `k step` command a Bash call runs (start, finish or fail), or null. */
function stepVerb(input) {
  const command = input.tool_name === 'Bash' ? input.tool_input?.command : null;
  return typeof command === 'string' ? [...command.matchAll(STEP_COMMAND)].at(-1)?.[1] ?? null : null;
}

/** The plan's first ready step, else its first not finished, as { id, title }; null when it cannot be read. */
function nextStep(home, task) {
  try {
    const config = readJson(join(home, 'escalate', 'config.json'));
    const dir = taskDir(config, task);
    if (!dir) return null;
    const require = createRequire(import.meta.url);
    const { planText, progressText } = require('../lib/held.mjs');
    const { parsePlan } = require('../lib/plan.mjs');
    const { stepStates } = require('../lib/steps.mjs');
    const text = planText(dir, home);
    if (text == null) return null;
    const plan = parsePlan(text);
    const states = stepStates({ dir, root: config.repos[task.split('/')[0]] }, plan, progressText(dir, home) ?? '', null);
    const s = plan.steps.find((x) => states.get(x.id)?.state === 'ready') ?? plan.steps.find((x) => states.get(x.id)?.state !== 'done');
    return s ? { id: s.id, title: s.title } : null;
  } catch {
    return null;
  }
}

/** One main-session call counted to its stretch: the notice it is due now, or null. Throws when the count cannot be kept. */
function countMain(home, input, env) {
  if (env.KIRUNAK_STEP) return null;
  const task = readSession(home, input.session_id)?.task;
  if (typeof task !== 'string' || !task) return null;
  const file = countPath(home, input.session_id);
  const counts = readCounts(file);
  const was = counts.main && typeof counts.main === 'object' && counts.main.task === task ? counts.main : null;
  const fresh = { task, inStep: false, calls: 0, base: null, told: false };
  const verb = stepVerb(input);
  let main = was ?? fresh;
  let notice = null;
  if (verb === 'start') main = { ...fresh, inStep: true };
  else if (verb) main = fresh;
  else if (!main.inStep) {
    const calls = (Number.isInteger(main.calls) && main.calls > 0 ? main.calls : 0) + 1;
    main = { ...main, calls };
    if (!main.told) {
      let context = null;
      try {
        context = typeof input.transcript_path === 'string' && input.transcript_path ? lastCall(input.transcript_path)?.context ?? null : null;
      } catch {}
      if (!Number.isFinite(main.base) && context !== null) main.base = context;
      const growth = context !== null && Number.isFinite(main.base) ? context - main.base : 0;
      if (calls >= STRETCH.calls || growth >= STRETCH.context) {
        main.told = true;
        notice = stretchNotice({ task, step: nextStep(home, task), ...(calls >= STRETCH.calls ? { calls } : { growth }) });
      }
    }
  }
  writeCounts(file, { ...counts, main });
  return notice;
}

/** The reply for one PostToolUse event, or null. Anything it cannot read or write is null. */
export function reply(input, home = kirunakHome(), env = process.env) {
  try {
    if (!input || typeof input !== 'object' || !isId(input.session_id)) return null;
    const agent = input.agent_id;
    const notice = typeof agent === 'string' && agent ? countAgent(home, input.session_id, agent) : countMain(home, input, env ?? {});
    if (!notice) return null;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notice } };
  } catch {
    return null;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = reply(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
  process.exit(0);
}

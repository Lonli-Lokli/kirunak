#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import {
  blockLines, commandOf, count, logLine, message, modelOf, notificationOf, prune, pushIn, pushLines, readConfig,
  readState, repeatsOf, runEnd, rungFor, signatureOf, statePath, tail, taskOf, unfitFor, unmarkEdited, withState,
  writeState,
} from './escalate-state.mjs';

// The escalation hook (gulnya/enforced-escalation S-2 design §4). In an interactive session it counts a build or test
// failing again on the same test or error after an edit, and once, on the configured repeat, tells the session to
// hand the step one rung up the ladder (AC-8..AC-11). It prints nothing unless it fires or hands the session the push
// of a k run it started in the background that stopped for the owner (AC-9, E-16), stays quiet in a k run step,
// which counts its own failures (E-12), and does nothing at all with `hook.enabled: false`. It imports nothing but
// node: modules, lib/home.mjs and its rules, because it runs on every failed Bash call (AC-12).
//
// Its events (R4.1): PostToolUseFailure on Bash counts, and on an edit tool takes back that edit's flag (O-2);
// PostToolUse on Agent records a launch; SubagentStop records an agent's end and may lift the block; UserPromptSubmit
// counts the end of a noted background build (R4.5) and hands on the push a noted k run's end carries (R7.2);
// UserPromptExpansion of /k-go-on is the owner's override;
// SessionStart and PostModelSwitch record the session's model.
//
// The block (S-2 design §5). The first failure after a fire sets the session's `block` (the caller's, for a
// subagent, E-13), and the freeze hook refuses Edit, Write, MultiEdit and NotebookEdit while it is not lifted. It
// names the rung above, or the one above that when that rung's agent already finished on the fire's word (S-10 S-1).
//
// The rule a reviewer can check, held by the code's shape: the block is lifted only by liftByAgent(), which runs on a
// SubagentStop of an agent of the rung above the block's, launched by the session itself after the fire that led to
// the block (when that agent was already running then) or after the block, that ran as that rung (its model of the
// rung's family, its effort not below the rung's) and finished its run (a hand-back or a last text, not interrupted)
// (R5.3, E-8, S-10 B-1, S-1, S-2), and by override(), which runs on a UserPromptExpansion naming k-go-on outside any
// subagent and outside a claude run that another claude started (R5.4 branch A, D-1, E-11, S-10 S-4). Nothing else
// here writes `block.lifted`. SubagentStop and UserPromptExpansion come from Claude Code, never from a tool; a typed
// /k-go-on fires UserPromptExpansion, and a scheduled prompt fires UserPromptSubmit alone (S-1 §4), which lifts
// nothing; a claude run from the model's shell has a second claude among this hook's ancestors, however its command
// line is written. An event written by hand and piped into this script from the model's shell has one claude above
// it, as the owner's has, and nothing here tells the two apart. So the freeze hook refuses, as a guard against
// mistakes and not against a deliberate bypass, the Skill call of k-go-on, a CronCreate, ScheduleWakeup or SendMessage
// that carries /k-go-on and an Agent prompt that starts with it, a claude run from the shell that resumes a session or
// carries /k-go-on, any write to this hook's state files and log (R5.2), and a shell command that runs this script or
// escalate-state.mjs, named in it by basename, with node or as itself (S-17); a shell that hides the name gets past.

const OUTPUT_TAIL = 64 * 1024;
const GO_ON = 'k-go-on';
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// The agents whose end lifts a block at `rung` (R4.8): the rung above's, as config.json lists them (its generated
// <model>-step first), or that <model>-step alone; none at the top of the ladder (E-9).
const liftersOf = (rung) => (!rung.up ? [] : rung.agents.length ? rung.agents : [`${rung.up}-step`]);

// The block in force: set and not lifted.
const inForce = (block) => Boolean(block && typeof block === 'object' && block.lifted == null);

// Counts one failure into the file of the session or subagent that ran it (E-14); on the first failure after a fire
// sets the block in the session's file (the caller's, E-13) unless one is in force or `hook.block` is off; logs a
// fire, the block and every failure after them (R3.2); and returns the message's lines when it fires. A signature
// blocked while another block was in force blocks again once none is (S-10 N-3).
function countFailure({ input, home, config, command, error, now }) {
  const sig = signatureOf(error, command);
  if (!sig) return null;
  const session = input.session_id;
  const agent = input.agent_id ?? null;
  const counted = withState(home, session, agent, () => {
    const state = readState(home, session, agent);
    const what = count(state, sig, repeatsOf(config), now);
    if (what !== 'rerun') writeState(home, state);
    return { what, f: state.failures[sig.hash] };
  });
  if (!counted || !['fire', 'block', 'after'].includes(counted.what)) return null;
  const { f } = counted;
  const model = modelOf(input, readState(home, session));
  const rung = rungFor(config.ladder, model);
  const task = taskOf(home, session, config);
  const { repeats } = f;
  const blocking = config.hook?.block !== false;
  let what = counted.what;
  if (what !== 'fire' && blocking) {
    withState(home, session, null, () => {
      const caller = readState(home, session);
      if (inForce(caller.block)) return;
      if (what === 'after') what = 'block';
      caller.block = blockFor({ sig, f, input, config, caller, model, rung, task, agent, now });
      writeState(home, caller);
    });
  }
  const blocks = what === 'block' && blocking;
  const triggers = { fire: 'hook fired', block: blocks ? 'hook blocked' : 'repeat after fire', after: 'repeat after fire' };
  logLine(home, {
    time: now.toISOString(),
    session,
    agent,
    agentType: input.agent_type ?? null,
    task: task?.id ?? null,
    step: task?.step ?? null,
    trigger: triggers[what],
    rung: { from: model ?? rung.from, to: rung.up, agents: rung.agents },
    ...(rung.unknown ? { rungUnknown: true } : {}),
    signature: { kind: sig.kind, label: sig.label, hash: sig.hash },
    count: repeats,
    liftedBy: null,
  });
  if (what !== 'fire') return null;
  return message({ label: sig.label, repeats, task, rung, subagent: Boolean(agent), block: blocking });
}

// The block a failure after the fire sets (S-2 design §5, S-10 S-1). An agent of the rung above that the session
// launched on the fire's word counts here: one that finished as that rung means the step failed there too, so the
// block names the rung above that (none at the top: stop and say what is missing, E-9); one still running is let lift
// by its end, the block's threshold being the fire (`firedAt`) instead of the block.
function blockFor({ sig, f, input, config, caller, model, rung, task, agent, now }) {
  const since = Date.parse(f.firedAt ?? '');
  const after = Object.entries(caller.agents ?? {}).filter(([, a]) =>
    a && a.by == null && Date.parse(a.at) > since && liftersOf(rung).includes(String(a.type ?? '').split(':').pop()) &&
    !unfitFor(config.ladder, rung.up, a));
  const failedAbove = after.some(([, a]) => a.ended && a.finished);
  const at = failedAbove ? rungFor(config.ladder, rung.up) : rung;
  const running = !failedAbove && after.some(([, a]) => !a.ended);
  const lines = (subagent) => blockLines({ label: sig.label, task, rung: at, subagent }).join('\n');
  return {
    hash: sig.hash, kind: sig.kind, label: sig.label, at: now.toISOString(),
    ...(running ? { firedAt: f.firedAt } : {}),
    rung: { from: model ?? rung.from, to: at.up, agents: liftersOf(at), ...(failedAbove ? { failedOn: rung.up } : {}) },
    agent, agentType: input.agent_type ?? null, task: task?.id ?? null, step: task?.step ?? null, count: f.repeats,
    reason: lines(false), subagentReason: lines(true), lifted: null,
  };
}

// An edit that failed to apply takes back the flag it set (O-2), in the file of the session or subagent that made it.
function editFailed(input, home) {
  const agent = input.agent_id ?? null;
  withState(home, input.session_id, agent, () => {
    const state = readState(home, input.session_id, agent);
    if (unmarkEdited(state, typeof input.tool_use_id === 'string' ? input.tool_use_id : null)) writeState(home, state);
  });
}

// A background build's end (S-1 §8): counted when it failed and this session noted it at launch; its output is the
// tail of the file the notification names. A noted k run's end: the push its output closes with, when it stopped for
// the owner (R7.2, E-16). → { lines } of a fire, { push }, or null
function notified(input, home, config, now) {
  const n = notificationOf(input.prompt);
  if (!n?.description) return null;
  const agent = input.agent_id ?? null;
  const note = withState(home, input.session_id, agent, () => {
    const state = readState(home, input.session_id, agent);
    const found = state.background[n.description];
    if (!found) return null;
    delete state.background[n.description];
    writeState(home, state);
    return found;
  });
  if (!note) return null;
  if (note.run) {
    const push = pushIn(n.outputFile);
    return push && { push };
  }
  if (n.status !== 'failed') return null;
  const error = `Exit code ${n.code ?? 1}\n${tail(n.outputFile, OUTPUT_TAIL)}`;
  const lines = countFailure({ input, home, config, command: note.command, error, now });
  return lines && { lines };
}

// An agent's launch (S-1 §2: PostToolUse on Agent fires at launch, with the id and the model it resolved), in the
// session's file, with the Agent call's own `model` and `effort`, which override the agent file's (S-10 B-1); `by`
// names the subagent that launched it, if one did.
function launched(input, home, now) {
  const r = input.tool_response ?? {};
  const id = r.agentId ?? r.agent_id;
  if (input.tool_name !== 'Agent' || typeof id !== 'string' || !id) return;
  const ti = input.tool_input ?? {};
  withState(home, input.session_id, null, () => {
    const state = readState(home, input.session_id);
    state.agents[id] = {
      type: ti.subagent_type ?? null, model: r.resolvedModel ?? null, asked: ti.model ?? null, effort: ti.effort ?? null,
      at: now.toISOString(), ended: null, by: input.agent_id ?? null,
    };
    writeState(home, state);
  });
}

// An agent of a rung above the lowest stopped (the matcher names them): its end is recorded, with whether it finished
// its run (S-10 S-2), and it may lift the block.
function ended(input, home, config, now) {
  const id = input.agent_id;
  if (typeof id !== 'string' || !id || !input.agent_type) return;
  const { finished, bytes } = runEnd(input.agent_transcript_path, input.last_assistant_message);
  const result = withState(home, input.session_id, null, () => {
    const state = readState(home, input.session_id);
    const launch = state.agents[id] ?? null;
    state.agents[id] = { type: input.agent_type, model: null, at: null, by: null, ...launch, ended: now.toISOString(), finished };
    const out = liftByAgent(state, home, config, input, launch, finished, now);
    writeState(home, state);
    return out;
  });
  if (!result) return;
  const run = { agent: String(input.agent_type).split(':').pop(), agentId: id };
  if (result.lifted) logLift(home, input.session_id, result.block, run, now, { transcriptBytes: bytes });
  else logLift(home, input.session_id, result.block, null, now, { trigger: 'lift refused', refused: { ...run, ...result.refused, transcriptBytes: bytes } });
}

// The lift by an agent one rung up (R5.3, E-8): the agent that stopped is of the rung above the block's (the generated
// <model>-step or one of that rung's `agents`, the part after a plugin's `:`), the session itself launched it after
// the fire that led to the block (`firedAt`, when that agent was already running then, S-10 S-1) or after the block,
// it ran as that rung, its model of the rung's family and its effort not below the rung's (S-10 B-1), and it finished
// its run (S-10 S-2). The end counts, not the launch; a launch before the block, a launch by a subagent and an agent
// of the block's own rung lift nothing; a Fable session's block lists no agent (E-9). → { lifted: true, block },
// { lifted: false, block, refused } for an agent of that rung that may not lift, which is logged, or null.
function liftByAgent(state, home, config, input, launch, finished, now) {
  const { block } = state;
  if (!inForce(block) || !launch || launch.by != null) return null;
  const type = String(input.agent_type).split(':').pop();
  const agents = Array.isArray(block.rung?.agents) ? block.rung.agents : [];
  if (!agents.includes(type)) return null;
  if (!(Date.parse(launch.at) > Date.parse(block.firedAt ?? block.at))) return null;
  const why = unfitFor(config.ladder, block.rung.to, launch) ?? (finished ? null : 'not finished');
  if (why) return { lifted: false, block, refused: { model: launch.model ?? null, asked: launch.asked ?? null, effort: launch.effort ?? null, why } };
  block.lifted = { by: 'agent', agent: type, agentId: input.agent_id, at: now.toISOString() };
  forget(state, home, block, [block.hash]);
  return { lifted: true, block };
}

// The owner's override (R5.4 branch A, D-1, E-11): /k-go-on typed in the session, at the terminal or on the phone,
// fires UserPromptExpansion with its command name; inside a subagent it is not the owner's, nor in a claude run that
// another claude started (S-10 S-4: a run from the model's shell, however its command line hides it, has a second
// claude among the hook's ancestors; the owner's session has one). It lifts the block in force and clears the
// session's counts, and is logged even with nothing to lift.
export function override(input, home, now, ancestors = ancestry) {
  if (input.command_name !== GO_ON || input.agent_id) return;
  if (nested(ancestors())) {
    const block = readState(home, input.session_id).block;
    logLift(home, input.session_id, inForce(block) ? block : null, null, now, { trigger: '/k-go-on refused: nested run' });
    return;
  }
  const block = withState(home, input.session_id, null, () => {
    const state = readState(home, input.session_id);
    const found = inForce(state.block) ? state.block : null;
    if (found) found.lifted = { by: 'override', agent: null, agentId: null, at: now.toISOString() };
    if (found || Object.keys(state.failures).length > 0) {
      forget(state, home, found, null);
      writeState(home, state);
    }
    return found;
  });
  logLift(home, input.session_id, block ?? null, 'override', now);
}

// The commands of the hook's ancestors, nearest first, read with ps on a /k-go-on alone: `claude` for Claude Code (its
// binary, or node running its cli), else the command's base name. It stops at the second claude, after 8 steps or at
// launchd. node:child_process loads here alone, so no other call pays for it (AC-12).
export function ancestry(pid = process.ppid) {
  const { execFileSync } = createRequire(import.meta.url)('node:child_process');
  const ps = (field, p) => execFileSync('ps', ['-o', field, '-p', String(p)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const names = [];
  for (let i = 0; i < 8 && pid > 1 && !nested(names); i++) {
    let m;
    try {
      m = /^(\d+)\s+(.+)$/.exec(ps('ppid=,comm=', pid));
    } catch {
      break; // gone, or no ps
    }
    if (!m) break;
    let name = basename(m[2]);
    if (/\/claude\/versions\/[^/]+$/.test(m[2])) name = 'claude';
    else if (/^node(?:js)?$/.test(name)) {
      try {
        if (/@anthropic-ai\/claude-code\/|claude-code\/cli/.test(ps('args=', pid))) name = 'claude';
      } catch {
        // gone: as named
      }
    }
    names.push(name);
    pid = Number(m[1]);
  }
  return names;
}

// A nested run: a claude above the hook's own claude (S-10 S-4).
export const nested = (names) => names.filter((n) => n === 'claude').length >= 2;

// Deletes the counts the lift settles: `hashes` (all with null) in the session's file and, when a subagent's failure
// set the block, in that subagent's file too.
function forget(state, home, block, hashes) {
  const clear = (s) => {
    for (const h of hashes ?? Object.keys(s.failures)) delete s.failures[h];
  };
  clear(state);
  if (!block?.agent) return;
  withState(home, state.session, block.agent, () => {
    const sub = readState(home, state.session, block.agent);
    clear(sub);
    writeState(home, sub);
  });
}

// A lift's line in escalate.log (R3.2, AC-21): `block lifted` with the agent, its id and its transcript's size (a
// short run that finished lifts, and the usage review can see it), or `/k-go-on override`; `extra` names a refusal
// instead (`lift refused`, `/k-go-on refused: nested run`).
function logLift(home, session, block, liftedBy, now, extra = {}) {
  logLine(home, {
    time: now.toISOString(),
    session,
    agent: block?.agent ?? null,
    agentType: block?.agentType ?? null,
    task: block?.task ?? null,
    step: block?.step ?? null,
    trigger: liftedBy === 'override' ? '/k-go-on override' : 'block lifted',
    rung: block?.rung ?? null,
    signature: block ? { kind: block.kind ?? null, label: block.label ?? null, hash: block.hash ?? null } : null,
    count: block?.count ?? null,
    liftedBy,
    ...extra,
  });
}

function recordModel(input, home, model) {
  if (typeof model !== 'string' || !model || readState(home, input.session_id).model === model) return;
  withState(home, input.session_id, null, () => {
    const state = readState(home, input.session_id);
    state.model = model;
    writeState(home, state);
  });
}

// The message reaches the model as additionalContext and the terminal as systemMessage (S-1 §5; hooks.md lists
// additionalContext for PostToolUseFailure and UserPromptSubmit, and systemMessage for every event that keeps it).
function say(event, lines) {
  const text = lines.join('\n');
  process.stdout.write(JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (process.env.KIRUNAK_STEP || !input || typeof input !== 'object') return;
  const event = input.hook_event_name;
  // The cheap answers first, so most calls end before reading a file.
  if (event === 'PostToolUseFailure' && !(input.tool_name === 'Bash' ? input.is_interrupt !== true : EDITS.has(input.tool_name))) return;
  if (event === 'UserPromptSubmit' && !String(input.prompt ?? '').startsWith('<task-notification>')) return;
  if (event === 'UserPromptExpansion' && input.command_name !== GO_ON) return;
  const home = kirunakHome();
  if (!statePath(home, input.session_id)) return;
  const config = readConfig(home);
  if (!config || config.hook?.enabled === false) return;
  const now = new Date();
  if (event === 'PostToolUseFailure' && input.tool_name !== 'Bash') {
    editFailed(input, home);
  } else if (event === 'PostToolUseFailure') {
    const command = commandOf(input.tool_input?.command, config.hook?.commands);
    const lines = command && countFailure({ input, home, config, command, error: input.error, now });
    if (lines) say(event, lines);
  } else if (event === 'UserPromptExpansion') {
    override(input, home, now);
  } else if (event === 'UserPromptSubmit') {
    const { lines, push } = notified(input, home, config, now) ?? {};
    if (lines) say(event, lines);
    // The push is the model's to send (S-1 §8), so it goes to the model alone.
    if (push) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: pushLines(push).join('\n') } }));
  } else if (event === 'PostToolUse') {
    launched(input, home, now);
  } else if (event === 'SubagentStop') {
    ended(input, home, config, now);
  } else if (event === 'SessionStart') {
    if (input.source === 'startup') prune(home, now.getTime());
    recordModel(input, home, input.model);
  } else if (event === 'PostModelSwitch') {
    recordModel(input, home, input.to_model);
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch {
    // a hook that fails stays quiet and never stops the session
  }
  process.exitCode = 0;
}

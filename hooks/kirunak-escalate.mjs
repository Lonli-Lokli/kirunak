#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import {
  commandOf, count, logLine, message, modelOf, notificationOf, prune, readConfig, readState, repeatsOf, rungFor,
  signatureOf, statePath, tail, taskOf, writeState,
} from './escalate-state.mjs';

// The escalation hook (gulnya/enforced-escalation S-2 design §4). In an interactive session it counts a build or test
// failing again on the same test or error after an edit, and once, on the configured repeat, tells the session to
// hand the step one rung up the ladder (AC-8..AC-11). It prints nothing unless it fires (AC-9), stays quiet in a k run
// step, which counts its own failures (E-12), and does nothing at all with `hook.enabled: false`. It imports nothing
// but node: modules, lib/home.mjs and its rules, because it runs on every failed Bash call (AC-12).
//
// Its events (R4.1): PostToolUseFailure on Bash counts; PostToolUse on Agent records a launch; SubagentStop records an
// agent's end; UserPromptSubmit counts the end of a noted background build (R4.5); SessionStart and PostModelSwitch
// record the session's model. The block and what lifts it are S-6's.

const OUTPUT_TAIL = 64 * 1024;

// Counts one failure into the file of the session or subagent that ran it (E-14), logs a fire and every failure after
// it (R3.2), and returns the message's lines when it fires.
function countFailure({ input, home, config, command, error, now }) {
  const sig = signatureOf(error, command);
  if (!sig) return null;
  const session = input.session_id;
  const agent = input.agent_id ?? null;
  const state = readState(home, session, agent);
  const what = count(state, sig, repeatsOf(config), now);
  if (what === 'rerun') return null;
  writeState(home, state);
  if (what !== 'fire' && what !== 'after') return null;
  const model = modelOf(input, agent ? readState(home, session) : state);
  const rung = rungFor(config.ladder, model);
  const task = taskOf(home, session, config);
  const { repeats } = state.failures[sig.hash];
  logLine(home, {
    time: now.toISOString(),
    session,
    agent,
    agentType: input.agent_type ?? null,
    task: task?.id ?? null,
    step: task?.step ?? null,
    trigger: what === 'fire' ? 'hook fired' : 'repeat after fire',
    rung: { from: model ?? rung.from, to: rung.up, agents: rung.agents },
    ...(rung.unknown ? { rungUnknown: true } : {}),
    signature: { kind: sig.kind, label: sig.label, hash: sig.hash },
    count: repeats,
    liftedBy: null,
  });
  if (what !== 'fire') return null;
  return message({ label: sig.label, repeats, task, rung, subagent: Boolean(agent), block: config.hook?.block !== false });
}

// A background build's end (S-1 §8): counted when it failed and this session noted it at launch; its output is the
// tail of the file the notification names.
function notified(input, home, config, now) {
  const n = notificationOf(input.prompt);
  if (!n?.description) return null;
  const state = readState(home, input.session_id, input.agent_id ?? null);
  const note = state.background[n.description];
  if (!note) return null;
  delete state.background[n.description];
  writeState(home, state);
  if (n.status !== 'failed') return null;
  const error = `Exit code ${n.code ?? 1}\n${tail(n.outputFile, OUTPUT_TAIL)}`;
  return countFailure({ input, home, config, command: note.command, error, now });
}

// An agent's launch (S-1 §2: PostToolUse on Agent fires at launch, with the id and the model it resolved), in the
// session's file; `by` names the subagent that launched it, if one did.
function launched(input, home, now) {
  const r = input.tool_response ?? {};
  const id = r.agentId ?? r.agent_id;
  if (input.tool_name !== 'Agent' || typeof id !== 'string' || !id) return;
  const state = readState(home, input.session_id);
  state.agents[id] = {
    type: input.tool_input?.subagent_type ?? null, model: r.resolvedModel ?? null, at: now.toISOString(), ended: null, by: input.agent_id ?? null,
  };
  writeState(home, state);
}

// An agent of a rung above the lowest finished (the matcher names them); S-6 lifts the block from here.
function ended(input, home, now) {
  const id = input.agent_id;
  if (typeof id !== 'string' || !id || !input.agent_type) return;
  const state = readState(home, input.session_id);
  state.agents[id] = { type: input.agent_type, model: null, at: null, by: null, ...state.agents[id], ended: now.toISOString() };
  writeState(home, state);
}

function recordModel(input, home, model) {
  if (typeof model !== 'string' || !model) return;
  const state = readState(home, input.session_id);
  if (state.model === model) return;
  state.model = model;
  writeState(home, state);
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
  if (event === 'PostToolUseFailure' && (input.tool_name !== 'Bash' || input.is_interrupt === true)) return;
  if (event === 'UserPromptSubmit' && !String(input.prompt ?? '').startsWith('<task-notification>')) return;
  const home = kirunakHome();
  if (!statePath(home, input.session_id)) return;
  const config = readConfig(home);
  if (!config || config.hook?.enabled === false) return;
  const now = new Date();
  if (event === 'PostToolUseFailure') {
    const command = commandOf(input.tool_input?.command, config.hook?.commands);
    const lines = command && countFailure({ input, home, config, command, error: input.error, now });
    if (lines) say(event, lines);
  } else if (event === 'UserPromptSubmit') {
    const lines = notified(input, home, config, now);
    if (lines) say(event, lines);
  } else if (event === 'PostToolUse') {
    launched(input, home, now);
  } else if (event === 'SubagentStop') {
    ended(input, home, now);
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

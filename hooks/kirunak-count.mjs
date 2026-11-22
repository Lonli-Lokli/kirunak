#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { isId } from './compact-rules.mjs';

// The count hook (gulnya/usage-improve-11-22 AC-15), on PostToolUse for every tool: a call is a tool call. Inside an
// agent (the input's `agent_id`) it counts that agent's calls, each agent of a session apart, and at the agent's 75th
// call gives it AGENT_SOON, at its 100th AGENT_LAST, each once, as additionalContext: a long agent is the cost (each of
// its calls re-reads all it has gathered), so it is told to hand over before it grows past 100. A main session's call
// (no `agent_id`) gets no agent notice.
//
// Its counts are in <home>/counts/<session>.json, `{ agents: { <agent_id>: { calls, told: [75, 100] } } }`, written
// whole through a file beside it and a rename, so a reader never sees half of one. Agents of one session that run at
// once can lose a count to each other; a notice is given at or past its call and kept in `told`, so a lost count delays
// it by a call and never skips it.
//
// It never blocks: no `decision`, never a non-zero exit. It fails open: input it cannot read, a session id that is not
// an id, or a count file it cannot write lets the call through silent; a count file that is not JSON starts again.

export const AGENT_SOON = 'About 25 calls are left for this agent: finish the piece in hand, and write what is left to a handoff file by call 100.';
export const AGENT_LAST = "Return now with the short report and the handoff file's path.";
export const AGENT_NOTICES = Object.freeze([[75, AGENT_SOON], [100, AGENT_LAST]]);

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

/** The reply for one PostToolUse event, or null. Anything it cannot read or write is null. */
export function reply(input, home = kirunakHome()) {
  try {
    if (!input || typeof input !== 'object' || !isId(input.session_id)) return null;
    const agent = input.agent_id;
    if (typeof agent !== 'string' || !agent) return null;
    const notice = countAgent(home, input.session_id, agent);
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

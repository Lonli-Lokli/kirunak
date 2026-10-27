#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { readSession } from '../lib/keeper.mjs';
import { bugsLine, waitingBugs } from '../lib/waiting.mjs';
import { loadWorkspace } from '../lib/workspace.mjs';

// SessionStart on `startup|clear` (gulnya/kirunak-bugs AC-7, E-7): a session the owner starts is told, before
// anything else, how many bugs wait and how many carry a fix ready, in k waiting's own line. A k run step's session
// (its env names a step, or its session's file is a headless one) and a bug's review session are told nothing, and
// nor is any session while no bug waits. The line reaches the model as additionalContext and the terminal as
// systemMessage, as kirunak-escalate.mjs says; the hook never stops a session.

// noticeFrom(input, known, env, counts) → the line to print, or '' for a session that is told nothing. `known` is the
// session's file, `counts` is waitingBugs's { count, ready } or a function that gives it, called only when needed.
export async function noticeFrom(input, known = null, env = {}, counts = null) {
  if (env.KIRUNAK_STEP || env.KIRUNAK_BUG_REVIEW || known?.kind === 'headless') return '';
  if (input?.source !== 'startup' && input?.source !== 'clear') return '';
  const c = typeof counts === 'function' ? await counts() : counts;
  return c ? bugsLine(c) : '';
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const home = kirunakHome();
    const known = typeof input?.session_id === 'string' && input.session_id ? readSession(home, input.session_id) : null;
    const counts = async () => (existsSync(join(home, 'workspace')) ? waitingBugs(await loadWorkspace(join(home, 'workspace'))) : null);
    const text = await noticeFrom(input, known, process.env, counts);
    const event = input?.hook_event_name || 'SessionStart';
    if (text) process.stdout.write(JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  } catch {}
  process.exit(0);
}

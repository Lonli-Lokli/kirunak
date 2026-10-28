#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { readSession } from '../lib/keeper.mjs';

// The stale-session hook (gulnya/k-usage AC-3, D-4, D-8), on UserPromptSubmit beside the escalation hook: on the first
// prompt after a long gap in a session that holds a large context, its prompt cache has expired and every call from
// there re-reads all of it, so it shows the user one line saying so, naming `k handoff <id>` when the session holds a
// task (the session's file `k start` wrote, $KIRUNAK_HOME/sessions/<session>.json) and otherwise saying to start fresh.
// The gap and the context are the workspace's `usage.stale` ({ minutes, context }, 60 and 150,000 by default), read
// from escalate/config.json, which k install writes from the workspace, since a hook on every prompt cannot load the
// workspace in its time. The next prompt finds a recent call, so it speaks once.
//
// It never blocks: no `decision`, never a non-zero exit. It fails open: a transcript it cannot find or read, an empty
// one or one with no call it can parse lets the prompt through silent. It reads only the transcript's tail.

export const DEFAULT_STALE = Object.freeze({ minutes: 60, context: 150_000 });

/** The last assistant call in a transcript: when it ran and how much context it held, or null. Reads only the tail. */
export function lastCall(file, tailBytes = 512 * 1024) {
  const fd = openSync(file, 'r');
  let text;
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, tailBytes));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    text = buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const u = r?.message?.usage;
    if (r.type !== 'assistant' || !u || typeof u !== 'object' || r.message.model === '<synthetic>') continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at)) continue;
    const n = (x) => (Number.isFinite(x) ? x : 0);
    return { at, context: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) };
  }
  return null;
}

/** The thresholds k install wrote from the workspace's usage.stale, each falling back to kirunak's default. */
export function staleOf(home) {
  let s = null;
  try {
    s = JSON.parse(readFileSync(join(home, 'escalate', 'config.json'), 'utf8'))?.usage?.stale;
  } catch {}
  return {
    minutes: Number.isFinite(s?.minutes) && s.minutes > 0 ? s.minutes : DEFAULT_STALE.minutes,
    context: Number.isFinite(s?.context) && s.context > 0 ? s.context : DEFAULT_STALE.context,
  };
}

/** The task the session holds (the id k start wrote into its file), or null. */
export function taskOfSession(home, session) {
  const task = typeof session === 'string' && session ? readSession(home, session)?.task : null;
  return typeof task === 'string' && task ? task : null;
}

/** The hook's JSON reply, or null to stay silent: past both the gap and the context only. */
export function advice({ at, context }, { stale = DEFAULT_STALE, task = null, now = Date.now() } = {}) {
  const minutes = Math.round((now - at) / 6e4);
  if (!(minutes > stale.minutes && context > stale.context)) return null;
  const k = Math.round(context / 1000);
  const away = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  const next = task
    ? `Write the handoff with \`k handoff ${task}\` and go on in a fresh session`
    : 'Start fresh in a new session';
  return {
    systemMessage: `This session was idle ${away} and holds ${k}k tokens, so its cache has expired: ${next}; it costs far less than going on here.`,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `kirunak's stale-session hook: this session was idle ${away} and holds ${k}k tokens, so its prompt cache has ` +
        'expired and every call from here re-reads all of it. Before other work, offer the user in one line to ' +
        (task
          ? `write the handoff with \`k handoff ${task}\`, so they can /clear and continue the task in a fresh session`
          : 'start fresh: a new session, given what it needs in a few lines') +
        '; if they want to go on here, do so.',
    },
  };
}

/** The reply for one UserPromptSubmit event, or null. Anything it cannot read is null. */
export function reply(input, home = kirunakHome(), now = Date.now()) {
  try {
    if (typeof input?.transcript_path !== 'string' || !input.transcript_path) return null;
    const last = lastCall(input.transcript_path);
    if (!last) return null;
    return advice(last, { stale: staleOf(home), task: taskOfSession(home, input.session_id), now });
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

#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import {
  attribute, decide, expectPath, isId, lastUsage, limitOf, logLine, readJson, thresholdOf, userWindow, windowOf,
  windowSetting,
} from './compact-rules.mjs';

// The PreCompact hook (design/orchestrator.md §5). In a session started in a workspace repo whose
// own .claude/settings.local.json sets kirunak's handover window, it blocks an automatic compaction while a step the
// session started is running, and lets it through at the next step boundary (AC-1, AC-4), past the mid-step limit
// (E-1, E-8), for a manual /compact (E-4), for an agent's fire as far as the hook can tell one (E-6, R3.3), and
// whenever it cannot read kirunak's state (E-7). Outside the workspace's repos it never blocks (E-10). It exits at
// once in a k run step (E-6, O-1). A block shows nothing and costs no tokens; every decision is one line of
// compact.log, and each allow it gives the main session records `expect` for SessionStart (R5.2).
//
// It imports nothing but node: modules, lib/home.mjs and its rules; lib/steps.mjs, for the running steps, is loaded
// only when the table reaches R4.8, so no other fire pays for it. Not wired by k install until S-6.

// A file read once per run: the user's settings file is read for the window (R2.5) and again for the limit (R4.6).
function cachedReader() {
  const seen = new Map();
  return (path) => {
    if (!seen.has(path)) seen.set(path, readJson(path));
    return seen.get(path);
  };
}

// One fact, read once and only when a row asks for it; what was read is kept in `seen` for the log line.
const lazily = (seen) => (key, fn) => {
  let done = false;
  let value;
  return () => {
    if (!done) {
      done = true;
      value = fn();
      seen[key] = value;
    }
    return value;
  };
};

// The running agents of the session's records (§6: `agents` with no `ended`), each with its own transcript's context
// (R3.2), for attribution row 2.
function runningAgents(record, input) {
  const agents = record?.agents && typeof record.agents === 'object' ? record.agents : {};
  const base = join(dirname(String(input.transcript_path ?? '')), String(input.session_id), 'subagents');
  return Object.entries(agents)
    .filter(([id, a]) => isId(id) && a && a.ended == null)
    .map(([id]) => ({ id, ctx: lastUsage(join(base, `agent-${id}.jsonl`))?.ctx ?? null }));
}

// The steps of the session's chain running in its task (R1.1, R1.2); null when the task's folder cannot be found.
async function stepsRunning(config, session, id) {
  const [repo, slug] = typeof session?.task === 'string' ? session.task.split('/') : [];
  const root = config?.repos?.[repo];
  if (typeof root !== 'string' || !slug || !/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  const dir = join(root, 'kirunak', 'tasks', slug);
  if (!existsSync(dir)) return null;
  let text = '';
  try {
    text = readFileSync(join(dir, 'progress.md'), 'utf8');
  } catch {
    // no progress.md yet: no step started
  }
  const { runningBy } = await import('../lib/steps.mjs');
  return runningBy(text, [id, ...(Array.isArray(session.previous) ? session.previous : [])], dir);
}

// The facts of §4's table, each read when its row is reached, in the order the design names: config, the settings
// files, the transcript tail, the sessions file and the escalation record, progress.md, the agents' transcripts.
export function factsOf(input, home, env = process.env, now = new Date()) {
  const seen = {};
  const once = lazily(seen);
  const read = cachedReader();
  const id = input.session_id;
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const config = once('config', () => read(join(home, 'escalate', 'config.json')));
  const compact = () => config()?.compact ?? {};
  const usage = once('usage', () => lastUsage(input.transcript_path));
  const record = once('record', () => read(join(home, 'escalate', `${id}.json`)));
  const session = once('session', () => read(join(home, 'sessions', `${id}.json`)));
  const model = once('model', () => usage()?.model ?? record()?.model ?? null);
  const wModel = once('wModel', () => (Number.isFinite(session()?.window) && session().window > 0 ? session().window : windowOf(model())));
  const roots = () => (Array.isArray(compact().roots) ? compact().roots : []);
  const window = once('window', () => windowSetting({ env, cwd: input.cwd || process.cwd(), configDir, model, roots: roots(), read }));
  const T = once('T', () => thresholdOf(window().window, wModel()));
  const user = () => userWindow({ configDir, model: model(), wModel: wModel(), read }).window;
  const limit = once('limit', () => limitOf({ midStepLimit: compact().midStepLimit, user: user(), wModel: wModel() }));
  const agents = once('agents', () => runningAgents(record(), input));
  const turn = () => record()?.turn ?? null;
  const attribution = once('attribution', () => attribute({ turn: turn(), ctx: usage().ctx, T: T(), agents: agents(), now: now.getTime() }));
  const running = async () => (seen.running = await stepsRunning(config(), session(), id));
  const facts = {
    trigger: input.trigger, config, session: id, window, ctx: () => usage()?.ctx ?? null, attribution, limit,
    task: () => session()?.task ?? null, running,
  };
  return { facts, seen };
}

// compact.log's line (§4): what this fire read, null for what it did not need.
const lineOf = (input, seen, out, now) => ({
  ts: now.toISOString(), session: input.session_id ?? null, cwd: input.cwd ?? null, trigger: input.trigger ?? null,
  ctx: seen.usage?.ctx ?? null, model: seen.model ?? null,
  window: seen.window ? { value: seen.window.window, from: seen.window.from } : null, T: seen.T ?? null,
  limit: seen.limit ?? null, turn: seen.record?.turn?.state ?? null, agents: seen.agents ?? null,
  steps: seen.running ?? null, decision: out.decision, row: out.row, why: out.why,
});

// `expect` (R5.2) in compact/<session>.json, merged, written whole and renamed; a record, never a reason to fail.
function recordExpect(home, session, expect) {
  try {
    const path = expectPath(home, session);
    const next = { ...readJson(path), expect };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + '\n');
    renameSync(tmp, path);
  } catch {
    // the same
  }
}

async function main() {
  // R4.1: a k run step, nothing read and nothing written.
  if (process.env.KIRUNAK_STEP) return;
  const home = kirunakHome();
  const now = new Date();
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // unreadable input: allowed below
  }
  if (!input || typeof input !== 'object') {
    logLine(home, { ts: now.toISOString(), decision: 'allow', row: 'R4.3', why: 'state unreadable' });
    return;
  }
  if (input.hook_event_name != null && input.hook_event_name !== 'PreCompact') return;
  const { facts, seen } = factsOf(input, home, process.env, now);
  let out;
  try {
    out = await decide(facts);
  } catch {
    out = { decision: 'allow', row: 'R4.3', why: 'state unreadable', expect: false };
  }
  if (out.expect && expectPath(home, input.session_id)) {
    recordExpect(home, input.session_id, { at: now.toISOString(), why: out.why, ctx: seen.usage?.ctx ?? null });
  }
  logLine(home, lineOf(input, seen, out, now));
  if (out.decision === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: out.reason }));
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main()
    .catch(() => {
      // a hook that fails stays quiet and never stops the session (E-7)
    })
    .finally(() => {
      process.exitCode = 0;
    });
}

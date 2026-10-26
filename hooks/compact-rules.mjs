import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync,
  statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The PreCompact hook's rules (design/orchestrator.md §5), shared by hooks/kirunak-compact.mjs
// and the tests: the context and the model from the transcript, the window Claude Code uses and where it comes from,
// the threshold and the mid-step limit, whose compaction a fire is, and the rule table. It imports nothing but node:
// modules, because it runs in a hook before a request.

// ---- The constants (orchestrator.md §5, the handover's numbers) ----

// Claude Code compacts at window − min(max output, 20,000) − 13,000; every model on the ladder has max
// output ≥ 20,000.
export const SLACK = 33_000;
// The most one request adds past the transcript's last usage (R2.2): the transcript lags the request being checked.
// Measured on two weeks of main transcripts: the largest step between two usages was 89,288, so 100,000.
export const LAG = 100_000;
// An agent this far past the threshold is having its compactions blocked by us: the block is lifted (R3.3 row 2).
export const OVERSHOOT = 50_000;
// An agent record with no end counts as running for attribution only when its own transcript was written this
// recently before the fire (R3.2): a record whose end was never written is stale, its old context no sign of this fire.
export const AGENT_FRESH_S = 300;
// Idle compaction fires after about 54 minutes on the 1-hour cache, so a fire within this of a Stop is not
// the main session's (R3.3 row 4).
export const IDLE_MIN = 50;
// An additionalContext string over 10,000 characters is filed (hooks.md); 500 left for the label.
export const CAP = 9_500;
// Which folder's .claude/settings.local.json a session reads (R2.7): `main`, the repository root (the main checkout's
// for a worktree), as settings.md says, or `cwd`. Probed 2026-10-25, Claude Code 2.1.310: a root file of
// 100000 gave effectiveWindow=80000 from the root, a subdirectory and a worktree alike, so `main`.
export const PROJECT_ROOT = 'main';
// The setting's range, and the window of a model the table does not know (R2.4).
export const MIN_WINDOW = 100_000;
export const DEFAULT_WINDOW = 200_000;
const MILLION = 1_000_000;

const ID = /^[A-Za-z0-9_-]+$/;
export const isId = (x) => typeof x === 'string' && ID.test(x);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

// A JSON object from a file; null when it is missing, unreadable or not an object.
export function readJson(path) {
  try {
    const x = JSON.parse(readFileSync(path, 'utf8'));
    return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

// The last `size` bytes of a file as text; '' when it cannot be read. Private until S-5a imports escalate-state.mjs's.
function tail(path, size) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const total = fstatSync(fd).size;
    const length = Math.min(size, total);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, total - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---- The context and the model (R2.1, R2.3) ----

const FIRST_READ = 256 * 1024;
const SECOND_READ = 1024 * 1024;

// The newest main-thread assistant entry with usage in `text`, read from the end: { ctx, model }. A synthetic entry
// (an error Claude Code wrote itself, all zeros) says nothing of the context, so it is passed over. The tail's first
// line is usually cut, and fails to parse. `sidechain`: an agent's own transcript, every entry of which is marked
// `isSidechain` (R3.2), so none is passed over for it; the main transcript's are.
function usageIn(text, { sidechain = false } = {}) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    const u = x?.message?.usage;
    if (x?.type !== 'assistant' || (x.isSidechain === true && !sidechain) || !u || x.message.model === '<synthetic>') continue;
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return { ctx, model: typeof x.message.model === 'string' ? x.message.model : null };
  }
  return null;
}

// The context of a transcript's last request, the status line's own formula, and its model: 256 KB of its
// tail first, then 1 MB when the first held no usage (a few large tool results); null when 1 MB holds none.
// `opts.sidechain` for an agent's own transcript (usageIn).
export function lastUsage(path, opts = {}) {
  if (typeof path !== 'string' || !path) return null;
  const first = usageIn(tail(path, FIRST_READ), opts);
  if (first) return first;
  try {
    if (statSync(path).size <= FIRST_READ) return null;
  } catch {
    return null;
  }
  return usageIn(tail(path, SECOND_READ), opts);
}

// The model's own context window (R2.4): the 1M models of the ladder (each passed 200k in the week of 2026-10-19),
// else the documented default, which fails toward Claude Code's own behaviour (R4.6 then holds at most one request).
const MILLION_IDS = /\[1m\]|(?:haiku|opus|sonnet)-5-5|fable-5-1/;
export const windowOf = (model) => (typeof model === 'string' && MILLION_IDS.test(model) ? MILLION : DEFAULT_WINDOW);

// ---- The window Claude Code uses (R2.5, R2.7) ----

const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Claude Code keeps the local file in the starting directory when the root, its .git or its .claude entry is not the
// user's (settings.md); on Windows it always does.
function ownedRoot(root) {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  for (const p of [root, join(root, '.git'), join(root, '.claude')]) {
    try {
      if (statSync(p).uid !== uid) return false;
    } catch {
      // no .claude yet: nothing to own
    }
  }
  return true;
}

// The folder whose .claude/settings.local.json a session started in `cwd` reads (R2.7), as a real path: the git
// repository's root, the main checkout's for a worktree (its `.git` file names `<main>/.git/worktrees/<name>`), else
// `cwd` (outside git, a root that is the home directory, a root not the user's). node:fs alone, no git spawned.
export function projectRoot(cwd, { homeDir = homedir(), mode = PROJECT_ROOT } = {}) {
  const start = realOr(cwd);
  if (mode === 'cwd') return start;
  for (let dir = start; ; dir = dirname(dir)) {
    let st = null;
    try {
      st = statSync(join(dir, '.git'));
    } catch {
      // not here: one level up
    }
    if (st) {
      let root = dir;
      if (st.isFile()) {
        const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, '.git'), 'utf8'))?.[1];
        const at = gitdir && resolve(dir, gitdir);
        if (at && /[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.test(at)) root = dirname(dirname(dirname(at)));
      }
      root = realOr(root);
      return root === realOr(homeDir) || !ownedRoot(root) ? start : root;
    }
    if (dirname(dir) === dir) return start;
  }
}

// The window one settings file sets for `model`: its `modelSettings.<model>.autoCompactWindow` (a number) beats its
// top-level `autoCompactWindow`. `model` may be a function, called only when the file has modelSettings, so
// the transcript is read for it only then (R4's reading order).
function windowIn(x, model) {
  if (!x) return null;
  if (x.modelSettings && typeof x.modelSettings === 'object') {
    const m = typeof model === 'function' ? model() : model;
    const v = typeof m === 'string' ? num(x.modelSettings[m]?.autoCompactWindow) : null;
    if (v) return { value: v, key: `modelSettings.${m}.autoCompactWindow` };
  }
  const v = num(x.autoCompactWindow);
  return v ? { value: v, key: 'autoCompactWindow' } : null;
}

export const userFile = (configDir) => join(configDir, 'settings.json');

// The window Claude Code uses in a session started in `cwd` (R2.5): CLAUDE_CODE_AUTO_COMPACT_WINDOW, else the first
// file that sets one: the root's local file, a local file an earlier Claude Code left in `cwd`, the shared file of
// `cwd`, the user's. { window (the value as set, null for none; thresholdOf clamps it), from: { kind, file, key },
// kirunak, root }: `kirunak` is E-10's test (R4.3a), true only when a project file set it and the root is one of the
// workspace's `roots` (real paths). `--settings` and managed settings cannot be seen.
export function windowSetting({ env = process.env, cwd, configDir, model = null, roots = [], homeDir = homedir(), read = readJson }) {
  const root = projectRoot(cwd, { homeDir });
  const fromEnv = num(Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW));
  if (fromEnv) return { window: fromEnv, from: { kind: 'env', file: null, key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW' }, kirunak: false, root };
  const here = realOr(cwd);
  const files = [
    ['local', join(root, '.claude', 'settings.local.json')],
    ...(here === root ? [] : [['local', join(here, '.claude', 'settings.local.json')]]),
    ['shared', join(here, '.claude', 'settings.json')],
    ['user', userFile(configDir)],
  ];
  for (const [kind, file] of files) {
    const w = windowIn(read(file), model);
    if (w) return { window: w.value, from: { kind, file, key: w.key }, kirunak: kind !== 'user' && roots.includes(root), root };
  }
  return { window: null, from: { kind: 'none', file: null, key: null }, kirunak: false, root };
}

// The user's own window for `model` (D-2, R4.6), read live from their file: its per-model value, else its top-level,
// else the model's window (none set: Claude Code's own point).
export function userWindow({ configDir, model, wModel, read = readJson }) {
  const w = windowIn(read(userFile(configDir)), model);
  return w ? { window: w.value, from: { kind: 'user', key: w.key } } : { window: wModel, from: { kind: 'none', key: null } };
}

// The threshold (R2.6): the window clamped to [100,000, the model's window], less SLACK; none set, the model's own.
export const thresholdOf = (window, wModel) => Math.min(Math.max(window ?? wModel, MIN_WINDOW), wModel) - SLACK;

// The mid-step limit (R4.6, E-1, E-8), a context compared with the transcript's: the workspace's number (by default
// 167,000), else for 'user' the user's own window, and never past the point where one request more could pass Claude
// Code's own compaction.
export const limitOf = ({ midStepLimit, user, wModel }) =>
  Math.min(num(midStepLimit) ?? user ?? wModel, wModel - SLACK - LAG);

// ---- Whose compaction it is (R3.3, E-6) ----

// The records of an escalation record's agents with no `ended` (R6.3), as [id, record].
export const openAgents = (record) =>
  Object.entries(record?.agents && typeof record.agents === 'object' ? record.agents : {}).filter(([id, a]) => isId(id) && a && a.ended == null);

// An agent's own transcript, `<session>/subagents/agent-<id>.jsonl` beside the main transcript `transcript`, and when
// it was last written (R3.2): { path, written (ms, null when it is missing), fresh (within AGENT_FRESH_S of `now`) }.
export function agentTranscript(transcript, session, id, now = Date.now()) {
  const path = join(dirname(String(transcript ?? '')), String(session), 'subagents', `agent-${id}.jsonl`);
  let written = null;
  try {
    written = statSync(path).mtimeMs;
  } catch {
    // no transcript
  }
  return { path, written, fresh: written != null && now - written <= AGENT_FRESH_S * 1000 };
}

// The running agents of the session's escalation record (R3.2, R6.3), each with its own transcript's context, for
// attribution row 2. Every entry of an agent's transcript is a sidechain one, so it is read as such. A record whose
// transcript is missing or not fresh is stale: { id, ctx: null, stale: true }, its transcript not read.
export function runningAgents(record, { transcript, session, now = Date.now() } = {}) {
  return openAgents(record).map(([id]) => {
    const t = agentTranscript(transcript, session, id, now);
    return t.fresh ? { id, ctx: lastUsage(t.path, { sidechain: true })?.ctx ?? null } : { id, ctx: null, stale: true };
  });
}

// PreCompact names no agent, so a fire is attributed from the turn flag and the contexts, the first row that
// applies deciding: an unknown turn is open (1); a running agent at least OVERSHOOT past the threshold is starving
// under our blocks (2); an open turn whose context is more than LAG under the threshold cannot have crossed it (3);
// a turn closed less than IDLE_MIN ago makes no request (4); else the main session's (5). `agents`: [{ id, ctx,
// stale }], runningAgents'; a stale one never counts (R3.2).
export function attribute({ turn, ctx, T, agents = [], now = Date.now() }) {
  const closed = turn?.state === 'closed';
  const past = agents.find((a) => a?.stale !== true && num(a?.ctx) != null && a.ctx >= T + OVERSHOOT);
  if (past) return { main: false, row: 2, why: 'agent past threshold', agent: past.id ?? null };
  if (!closed && ctx < T - LAG) return { main: false, row: 3, why: 'below threshold' };
  if (closed && now - Date.parse(turn.at) < IDLE_MIN * 60_000) return { main: false, row: 4, why: 'turn closed' };
  return { main: true, row: turn ? 5 : 1, why: null };
}

// R4.7a: the main session idle, its turn closed by a Stop at least IDLE_MIN ago: the fire is Claude Code's idle
// compaction (after about 54 minutes on the 1-hour cache).
export const idleOf = (turn, now) => turn?.state === 'closed' && now - Date.parse(turn.at) >= IDLE_MIN * 60_000;

// ---- The rule table (R4) ----

const allow = (row, why, expect = false) => ({ decision: 'allow', row, why, expect });
const block = (row, why, reason) => ({ decision: 'block', row, why, reason, expect: false });

// The decision on one PreCompact fire, R4.2 to R4.9 in the table's order (R4.1, KIRUNAK_STEP, ends the hook before
// anything is read). Each fact of `f` is a value or a function (sync or async) called only when its row is reached,
// so the cheap rows end before the transcript or progress.md is read: trigger, config, session (the id), window
// (windowSetting), ctx, attribution, limit, task, idle (idleOf), running (runningBy, or null when progress.md cannot
// be read), passed (boundarySince over the first block's record).
// `expect` marks the allows attributed to the main session, which SessionStart puts the task back after (R5.2).
export async function decide(f) {
  const get = async (k) => (typeof f[k] === 'function' ? f[k]() : f[k]);
  // E-4: a manual /compact is never blocked.
  if ((await get('trigger')) === 'manual') return allow('R4.2', 'manual', true);
  // E-7: kirunak's state unreadable or switched off.
  const config = await get('config');
  if (!config || config.compact?.enabled === false || !isId(await get('session'))) return allow('R4.3', 'state unreadable');
  // E-10, E-3: the window in force is not one a workspace repo's own file set.
  if (!(await get('window'))?.kirunak) return allow('R4.3a', "user's window");
  // E-7, E-1: the context unknown, so the limit cannot be bounded.
  const ctx = await get('ctx');
  if (ctx == null) return allow('R4.4', 'ctx unknown');
  // E-6: an agent's fire.
  const who = await get('attribution');
  if (!who.main) return allow('R4.5', who.why);
  // E-1, E-3, E-8: past the mid-step limit.
  if (ctx >= (await get('limit'))) return allow('R4.6', 'limit', true);
  // E-3: no task, so no handover at a boundary; the limit and an idle compaction, as today.
  if (!(await get('task'))) {
    if (await get('idle')) return allow('R4.7a', 'idle, no task', true);
    return block('R4.7', 'no task', 'kirunak: this session holds no task; the compaction waits for the mid-step limit');
  }
  // AC-4: a step of the session is running.
  const running = await get('running');
  if (!Array.isArray(running)) return allow('R4.3', 'state unreadable');
  if (running.length) {
    // R1.4: a boundary came after the first block, though no fire saw it.
    if (await get('passed')) return allow('R4.8a', 'boundary passed', true);
    const verb = running.length > 1 ? 'are' : 'is';
    return block('R4.8', 'running', `kirunak: ${running.join(', ')} ${verb} running; the compaction waits for the step boundary`);
  }
  // AC-1, AC-4: a step boundary.
  return allow('R4.9', 'boundary', true);
}

// ---- The records (R4's log, R5.2) ----

export const logPath = (home) => join(home, 'compact.log');
export const expectPath = (home, session) => (isId(session) ? join(home, 'compact', `${session}.json`) : null);

// One line of compact.log (R4's log, which the usage review counts by `why`); a record, never a reason to fail.
export function logLine(home, line) {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(logPath(home), JSON.stringify(line) + '\n');
  } catch {
    // the same
  }
}

// A record written whole and renamed, so a reader never sees half of it; false when it could not be written.
export function saveJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value) + '\n');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

const LOCK_WAIT = 100;
const LOCK_STEP = 2;
const LOCK_STALE = 2000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The advisory lock of `path`, the folder `<path>.lock`, as the escalation hook locks its state files (approval.md
// §7): a lock older than 2 s is a crashed hook's and is taken over. → true when taken, false when it is not free within
// about 100 ms.
function lockOf(path) {
  const lock = `${path}.lock`;
  const until = Date.now() + LOCK_WAIT;
  for (;;) {
    try {
      mkdirSync(lock);
      return true;
    } catch (e) {
      if (e?.code === 'ENOENT') {
        try {
          mkdirSync(dirname(path), { recursive: true });
          continue;
        } catch {
          return false;
        }
      }
      if (e?.code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE) {
        rmdirSync(lock);
        continue;
      }
    } catch {
      continue; // released between the two calls
    }
    if (Date.now() >= until) return false;
    pause(LOCK_STEP);
  }
}

// R6.6: compact/<session>.json has two writers that can run at once, the PreCompact hook (`expect`) and SessionStart's
// state part (`fire`, `joined`), so each reads, changes and writes it under its lock. `change(record)` returns the
// record to write, or null for none; it runs even when the lock is not free, and only its write is skipped (a record,
// never a reason to hold a session). → what `change` returned, else the record as read.
export function updateRecord(path, change) {
  const locked = lockOf(path);
  try {
    const rec = readJson(path) ?? {};
    const next = change(rec);
    if (locked && next) saveJson(path, next);
    return next ?? rec;
  } finally {
    if (locked) {
      try {
        rmdirSync(`${path}.lock`);
      } catch {
        // taken over as stale: nothing left to remove
      }
    }
  }
}

// The folder of a task `<repo>/<slug>` in the workspace's config.json `repos`; null when it cannot be found.
export function taskDir(config, task) {
  const [repo, slug, extra] = typeof task === 'string' ? task.split('/') : [];
  const root = config?.repos?.[repo];
  if (typeof root !== 'string' || !slug || extra !== undefined || !/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  const dir = join(root, 'kirunak', 'tasks', slug);
  return existsSync(dir) ? dir : null;
}

// ---- After a compaction and after /clear: the task put back (R5.1-R5.5) ----

// SessionStart `compact` puts the task back when the PreCompact hook's `expect` is this recent, or the main
// transcript's compact_boundary entry is (R5.2).
export const EXPECT_S = 180;
// SessionStart `compact` starts before Claude Code writes the main transcript's compact_boundary entry (about 70 ms
// later), so a part with no `expect` and no state part's `fire` to take waits this long for either (R5.2a).
export const BOUNDARY_WAIT_S = 5;
// SessionStart `clear` joins the old id when SessionEnd wrote cleared.json this recently (R5.3).
export const CLEAR_S = 120;
// The four entries of one SessionStart run in parallel: the `state` part decides, records it and consumes `expect`
// or cleared.json; the other three take a decision this recent as theirs (the entries' timeout).
export const PARTS_S = 20;
// compact/*.json untouched this long are removed (R5.5).
export const PRUNE_DAYS = 14;
export const PARTS = ['state', 'task', 'plan', 'progress'];

const thousands = (x) => x.toLocaleString('en-US');

// A part's first line (R5.1): which of the four, after what. No part refers to another's place, since their order
// varies from run to run (hooks.md: the hooks of one event run in parallel).
export const labelOf = (name, source) =>
  `kirunak, after ${source === 'clear' ? '/clear' : 'a compaction'} (part ${PARTS.indexOf(name) + 1} of 4): ${name}`;

// `text` whole when it fits in `cap`, else cut at a line end and closed by the line naming the whole of it, all
// within `cap`: a string over 10,000 characters would be filed and only its first 2 KB shown (hooks.md).
export function cut(text, cap = CAP, whole = null) {
  if (text.length <= cap) return text;
  const last = `… cut at ${thousands(cap)} characters; the whole file: ${whole ?? 'none'}`;
  const room = cap - last.length;
  if (room < 2) return last.slice(0, cap);
  const at = text.lastIndexOf('\n', room - 1);
  return `${at > 0 ? text.slice(0, at + 1) : `${text.slice(0, room - 1)}\n`}${last}`;
}

// The end of `text` within `cap`, from a line start, after a first line naming the whole file (R5.1's progress part).
export function lastOf(text, cap = CAP, whole = null) {
  if (text.length <= cap) return text;
  const first = `… cut at ${thousands(cap)} characters, its last lines kept; the whole file: ${whole ?? 'none'}\n`;
  const from = text.length - (cap - first.length);
  const at = text.indexOf('\n', from - 1);
  return first + text.slice(at < 0 || at + 1 >= text.length ? from : at + 1);
}

// plan.md as its header (everything before the first `### `) and its `### <id>` blocks.
export function planBlocks(text) {
  const starts = [...text.matchAll(/^### /gm)].map((m) => m.index);
  const blocks = starts.map((s, i) => {
    const body = text.slice(s, starts[i + 1] ?? text.length);
    return { id: /^### (\S+)/.exec(body)[1], text: body };
  });
  return { header: text.slice(0, starts[0] ?? text.length), blocks };
}

// The steps a session can go on with: started (running, or paused on a heavy job or the owner's answer) or ready.
const OPEN = new Set(['running', 'waiting-heavy', 'waiting-owner', 'ready']);

// R5.1's plan part: the header and the blocks of the steps not finished; over `cap`, the header and the blocks of the
// running, paused and ready steps alone (OPEN), cut when still over. `states`: a Map of step id → its state (lib/steps.mjs
// stepStates' { state } or the word). A last line names the blocks left out.
export function planFor(text, states, whole = null, cap = CAP) {
  const { header, blocks } = planBlocks(text.endsWith('\n') || !text ? text : `${text}\n`);
  const stateOf = (id) => {
    const v = states?.get?.(id);
    return typeof v === 'string' ? v : v?.state ?? null;
  };
  const pick = (keep) => {
    const out = blocks.filter((b) => !keep(b)).map((b) => b.id);
    return {
      body: header + blocks.filter(keep).map((b) => b.text).join(''),
      note: out.length ? `… left out, the blocks of ${out.join(', ')}; the whole file: ${whole ?? 'none'}` : '',
    };
  };
  let { body, note } = pick((b) => stateOf(b.id) !== 'done');
  if (body.length + note.length > cap) ({ body, note } = pick((b) => OPEN.has(stateOf(b.id))));
  if (!note) return cut(body, cap, whole);
  return body.length + note.length <= cap ? body + note : `${cut(body, cap - note.length - 1, whole)}\n${note}`;
}

// R5.2: the time of a compact_boundary entry of the main thread after the transcript's last assistant entry and no
// older than `since` (ms), as the transcript writes it; null for none. The main session compacted, though no
// PreCompact allow recorded `expect`; its time tells one boundary from the next.
export function boundaryIn(text, since) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"compact_boundary"') && !line.includes('"assistant"')) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (!x || x.isSidechain === true) continue;
    if (x.type === 'assistant') return null;
    if (x.type === 'system' && x.subtype === 'compact_boundary') return Date.parse(x.timestamp) >= since ? x.timestamp : null;
  }
  return null;
}

export const boundarySeen = (path, now = Date.now()) =>
  (typeof path === 'string' && path ? boundaryIn(tail(path, FIRST_READ), now - EXPECT_S * 1000) : null);

// The task's lines of `k waiting --json`: its steps stopped for the owner (each notice's lines), and its rows to
// approve, amendments to approve and the accept row, each with what k would say of it.
export function waitingLines(w, task) {
  if (!w || typeof w !== 'object') return [];
  const mine = (rows) => (Array.isArray(rows) ? rows.filter((x) => x?.id === task) : []);
  const verdict = (why, verb) => (why ? `not yet: ${String(why).split('\n')[0]}` : `can ${verb}`);
  return [
    ...mine(w.stopped).flatMap((x) => (Array.isArray(x.lines) ? x.lines.map(String) : [])),
    ...mine(w.approve).map((x) => `to approve: ${verdict(x.why, 'approve')}`),
    ...mine(w.amendments).map((x) => `amendment ${x.amendment}${x.name ? `: ${x.name}` : ''}, ${verdict(x.refuse, 'approve')}`),
    ...mine(w.accept).map((x) => `to accept: ${verdict(x.why, 'accept')}`),
  ];
}

const indented = (lines, none) => (lines.length ? lines.map((l) => `  ${l}`) : [`  ${none}`]);

const pad2 = (x) => String(x).padStart(2, '0');

// R5.1's state part, from what the hook gathered: three sentences, the task, the running steps of the session's chain
// with their starts, `k status --session` as it printed, the task's lines of k waiting, the running agents, apart from
// them the quiet ones (no end recorded, the transcript not written for AGENT_FRESH_S: finished, or on a long tool;
// `written` in ms, shown as the local HH:MM) and the background shell tasks of the last Stop. `status` and `waiting`
// are a text and lines, or an Error-like { failed }.
export function stateText(f) {
  const after = f.source === 'clear' ? `after /clear (it was session ${f.from})` : 'after a compaction';
  const name = (a) => `${a.description ?? 'no name'}: ${a.type ?? 'agent'}, id ${a.id}`;
  const agents = (f.agents ?? []).map((a) =>
    `${name(a)}, launched ${a.at ?? 'at an unknown time'}${a.by ? `, by ${a.by}` : ''}; output ${a.outputFile ?? 'none'}`);
  const quiet = (f.quiet ?? []).map((a) => {
    const d = new Date(a.written);
    return `${name(a)}, no end recorded, quiet since ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  });
  const shells = (f.shells?.list ?? []).map((x) => `${x.id ?? 'no id'} ${x.status ?? 'unknown'}: ${x.command ?? x.description ?? ''}`);
  const lines = [
    `This is the same session, ${after}, still on ${f.task}.`,
    `The parts task, plan and progress hold its task.md, plan.md and progress.md as they are now, and this part kirunak's state: they replace re-reading those files.`,
    `Go on from progress.md's last line: start no step again, and ask the owner nothing already answered.`,
    '',
    `task: ${f.task}${f.title ? `: ${f.title}` : ''}`,
    `folder: ${f.dir}`,
    `session: ${f.session}${f.chain?.length ? `, earlier ids ${f.chain.join(', ')}` : ''}`,
    `running steps of this session: ${f.running?.length ? f.running.map((r) => `${r.step} (started ${r.since ?? 'at an unknown time'})`).join(', ') : 'none, a step boundary'}`,
    `k status --session ${f.session}:`,
    ...indented(f.status?.failed ? [`k status failed: ${f.status.failed}`] : String(f.status ?? '').split('\n').filter(Boolean), 'nothing printed'),
    'k waiting, the lines of this task:',
    ...indented(f.waiting?.failed ? [`k waiting failed: ${f.waiting.failed}`] : f.waiting ?? [], 'none'),
    'running agents:',
    ...indented(agents, 'none'),
    ...(quiet.length ? ['quiet agents (finished, or waiting on a long tool):', ...indented(quiet)] : []),
    `background shell tasks at the last Stop${f.shells?.at ? ` (${f.shells.at})` : ''}:`,
    ...indented(shells, 'none'),
  ];
  return cut(lines.join('\n'), CAP, `the records under ${f.home}`);
}

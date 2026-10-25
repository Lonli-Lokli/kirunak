import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The PreCompact hook's rules (gulnya/fresh-session-per-step S-3 design §1-§4), shared by hooks/kirunak-compact.mjs
// and the tests: the context and the model from the transcript, the window Claude Code uses and where it comes from,
// the threshold and the mid-step limit, whose compaction a fire is, and the rule table. It imports nothing but node:
// modules, because it runs in a hook before a request.

// ---- The constants (design, the table above §1) ----

// Claude Code compacts at window − min(max output, 20,000) − 13,000 (S-1 §3); every model on the ladder has max
// output ≥ 20,000.
export const SLACK = 33_000;
// The most one request adds past the transcript's last usage (R2.2): the transcript lags the request being checked.
export const LAG = 50_000;
// An agent this far past the threshold is having its compactions blocked by us: the block is lifted (R3.3 row 2).
export const OVERSHOOT = 50_000;
// Idle compaction fires after about 54 minutes on the 1-hour cache (S-1 §3), so a fire within this of a Stop is not
// the main session's (R3.3 row 4).
export const IDLE_MIN = 50;
// An additionalContext string over 10,000 characters is filed (S-1 §6); 500 left for the label (S-5b).
export const CAP = 9_500;
// Which folder's .claude/settings.local.json a session reads (R2.7): `main`, the repository root (the main checkout's
// for a worktree), as settings.md says, or `cwd`. S-4's probe, 2026-10-25, Claude Code 2.1.310: a root file of
// 100000 gave effectiveWindow=80000 from the root, a subdirectory and a worktree alike, so `main`.
export const PROJECT_ROOT = 'main';
// The setting's range (S-1 §3), and the window of a model the table does not know (R2.4).
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
// line is usually cut, and fails to parse.
function usageIn(text) {
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
    if (x?.type !== 'assistant' || x.isSidechain === true || !u || x.message.model === '<synthetic>') continue;
    const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    return { ctx, model: typeof x.message.model === 'string' ? x.message.model : null };
  }
  return null;
}

// The context of a transcript's last request, the status line's own formula (S-1 §5), and its model: 256 KB of its
// tail first, then 1 MB when the first held no usage (a few large tool results); null when 1 MB holds none.
export function lastUsage(path) {
  if (typeof path !== 'string' || !path) return null;
  const first = usageIn(tail(path, FIRST_READ));
  if (first) return first;
  try {
    if (statSync(path).size <= FIRST_READ) return null;
  } catch {
    return null;
  }
  return usageIn(tail(path, SECOND_READ));
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
// top-level `autoCompactWindow` (S-1 §3). `model` may be a function, called only when the file has modelSettings, so
// the transcript is read for it only then (§4's reading order).
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

// The mid-step limit (R4.6, E-1, E-8): the workspace's number, else the user's own window, and never past the point
// where one request more could pass Claude Code's own compaction.
export const limitOf = ({ midStepLimit, user, wModel }) =>
  Math.min(num(midStepLimit) ?? user ?? wModel, wModel - SLACK - LAG);

// ---- Whose compaction it is (R3.3, E-6) ----

// PreCompact names no agent (S-1 §4), so a fire is attributed from the turn flag and the contexts, the first row that
// applies deciding: an unknown turn is open (1); a running agent at least OVERSHOOT past the threshold is starving
// under our blocks (2); an open turn whose context is more than LAG under the threshold cannot have crossed it (3);
// a turn closed less than IDLE_MIN ago makes no request (4); else the main session's (5). `agents`: [{ id, ctx }].
export function attribute({ turn, ctx, T, agents = [], now = Date.now() }) {
  const closed = turn?.state === 'closed';
  const past = agents.find((a) => num(a?.ctx) != null && a.ctx >= T + OVERSHOOT);
  if (past) return { main: false, row: 2, why: 'agent past threshold', agent: past.id ?? null };
  if (!closed && ctx < T - LAG) return { main: false, row: 3, why: 'below threshold' };
  if (closed && now - Date.parse(turn.at) < IDLE_MIN * 60_000) return { main: false, row: 4, why: 'turn closed' };
  return { main: true, row: turn ? 5 : 1, why: null };
}

// ---- The rule table (§4) ----

const allow = (row, why, expect = false) => ({ decision: 'allow', row, why, expect });
const block = (row, why, reason) => ({ decision: 'block', row, why, reason, expect: false });

// The decision on one PreCompact fire, R4.2 to R4.9 in the table's order (R4.1, KIRUNAK_STEP, ends the hook before
// anything is read). Each fact of `f` is a value or a function (sync or async) called only when its row is reached,
// so the cheap rows end before the transcript or progress.md is read: trigger, config, session (the id), window
// (windowSetting), ctx, attribution, limit, task, running (runningBy, or null when progress.md cannot be read).
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
  // E-3: no task, so no handover at a boundary; the limit, as today.
  if (!(await get('task'))) return block('R4.7', 'no task', 'kirunak: this session holds no task; the compaction waits for the mid-step limit');
  // AC-4: a step of the session is running.
  const running = await get('running');
  if (!Array.isArray(running)) return allow('R4.3', 'state unreadable');
  if (running.length) {
    const verb = running.length > 1 ? 'are' : 'is';
    return block('R4.8', 'running', `kirunak: ${running.join(', ')} ${verb} running; the compaction waits for the step boundary`);
  }
  // AC-1, AC-4: a step boundary.
  return allow('R4.9', 'boundary', true);
}

// ---- The records (§4 the log, R5.2) ----

export const logPath = (home) => join(home, 'compact.log');
export const expectPath = (home, session) => (isId(session) ? join(home, 'compact', `${session}.json`) : null);

// One line of compact.log (§4: S-8 reads it, S-9 counts its `why`); a record, never a reason to fail.
export function logLine(home, line) {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(logPath(home), JSON.stringify(line) + '\n');
  } catch {
    // the same
  }
}

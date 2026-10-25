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

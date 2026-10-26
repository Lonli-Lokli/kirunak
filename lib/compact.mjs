import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectRoot, SLACK, userWindow } from '../hooks/compact-rules.mjs';

// The handover's workspace settings (orchestrator.md §5, R7.1-R7.4): the handover size, the mid-step limit, the
// folders besides the repos that get the handover window, and the switch; what config.json carries for the hook; the
// window a k run step runs with.

// R7.1: the handover size and the mid-step limit as measured: 167,000 of context is a 200,000 window.
export const DEFAULT_COMPACT = Object.freeze({ enabled: true, handoverSize: 150_000, midStepLimit: 167_000, alsoIn: Object.freeze([]) });

// autoCompactWindow's range (settings.md), and a 1M model's own point.
export const WINDOW_RANGE = [100_000, 1_000_000];
export const MAX_LIMIT = WINDOW_RANGE[1] - SLACK;
const MILLION = 1_000_000;

const show = (v) => JSON.stringify(v) ?? String(v);

// R7.2: the problems of a workspace's `compact` (merged with the defaults), [] when it passes.
export function checkCompact(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [`compact must be an object such as { handoverSize: 150000 }, not ${show(c)}`];
  const out = [];
  if (typeof c.enabled !== 'boolean') out.push(`compact.enabled must be true or false, not ${show(c.enabled)}`);
  const [lo, hi] = WINDOW_RANGE;
  const sized = Number.isInteger(c.handoverSize) && c.handoverSize + SLACK >= lo && c.handoverSize + SLACK <= hi;
  if (!sized) {
    out.push(`compact.handoverSize must be a whole number from ${lo - SLACK} to ${hi - SLACK}, so that the window it sets ` +
      `(handoverSize + ${SLACK}) is in autoCompactWindow's range of ${lo} to ${hi}; not ${show(c.handoverSize)}`);
  }
  if (c.midStepLimit !== 'user') {
    if (!Number.isInteger(c.midStepLimit) || c.midStepLimit > MAX_LIMIT) {
      out.push(`compact.midStepLimit must be 'user' (the user's own window) or a whole number of at most ${MAX_LIMIT} ` +
        `(a 1M model's own point), not ${show(c.midStepLimit)}`);
    } else if (sized && c.midStepLimit <= c.handoverSize) {
      out.push(`compact.midStepLimit ${c.midStepLimit} must be above compact.handoverSize ${c.handoverSize}: ` +
        'at or under it, a compaction in the middle of a step would never wait for the step boundary');
    }
  }
  if (!Array.isArray(c.alsoIn) || !c.alsoIn.every((p) => typeof p === 'string' && p)) {
    out.push(`compact.alsoIn must be a list of folders, not ${show(c.alsoIn)}`);
  }
  return out;
}

// The workspace's `compact`, defaults filled in (a workspace object written by hand, as the tests do, may have none).
export const compactOf = (ws) => ({ ...DEFAULT_COMPACT, ...ws?.compact });

// The folders that get the handover window (R7.3, R8.2): each repo's root and each `alsoIn` folder, as
// { name, root, dir }: `dir` is the folder whose .claude/settings.local.json a session there reads (R2.7), the main
// checkout's for a worktree. The first root of each `dir` is kept.
export function rootsOf(ws) {
  const seen = new Set();
  const out = [];
  const all = [...(ws?.repos ?? []).map((r) => ({ name: r.name, root: r.root })), ...compactOf(ws).alsoIn.map((p) => ({ name: p, root: p }))];
  for (const r of all) {
    const dir = projectRoot(r.root);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ ...r, dir });
  }
  return out;
}

// config.json's `compact` block (R7.3): what the hook reads in place of the workspace. `roots` are the folders whose
// local file sets the handover window, as real paths, the hook's `projectRoot(cwd)` compared with them (R4.3a);
// `window` is also how k install knows its own earlier value in a repo's file (R8.2 c).
export function compactConfig(ws = null) {
  const c = compactOf(ws);
  return {
    enabled: c.enabled, handoverSize: c.handoverSize, window: c.handoverSize + SLACK, midStepLimit: c.midStepLimit,
    roots: rootsOf(ws).map((r) => r.dir),
  };
}

// The user's settings folder, as Claude Code finds it (settings.md).
export const configDirOf = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// R7.4: k run's headless steps keep the point they had before the handover. A step runs in its repo's root, whose
// local file now sets the handover window, so the step's environment sets CLAUDE_CODE_AUTO_COMPACT_WINDOW, which beats
// every setting: the user's own window for the step's model, else 1,000,000 (Claude Code cuts a window above the
// model's to the model's, so it compacts at its own point); never the mid-step limit, which is for interactive
// sessions. null with the handover off.
export function stepWindow({ ws, model = null, configDir = configDirOf() }) {
  if (compactOf(ws).enabled === false) return null;
  return userWindow({ configDir, model, wModel: MILLION }).window;
}

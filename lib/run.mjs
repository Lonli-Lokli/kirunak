import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from './steps.mjs';
import { killTree } from '../plugins/resource-guard-local.mjs';

// `k run <id> [--once|--watch]` (orchestrator.md §2): a plain Node loop, no model. Each pass reads the files, starts
// every ready step the machine guard admits, and waits; --watch passes every 30 s and ends when no step is ready
// and nothing runs, or when the task stops (an owner's question, a step marked [escalate]).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The plan line's model and effort, else the workspace's models.<kind>, else none (Claude Code's own default).
export function modelOf(ws, s) {
  const cfg = ws.models?.[s.kind] || {};
  return { model: s.model || cfg.model || null, effort: s.effort || cfg.effort || null };
}

export const budgetOf = (ws, s) => ({ calls: 100, minutes: 40, usd: 3, ...ws.budget, ...s.budget });

// The calls and money a conversation has used: its results' turns add up; its cost is its latest result's.
export function usedBy(p, step, sessionId) {
  const dir = steps.stepDir(p, step);
  let turns = 0;
  let usd = 0;
  for (const f of readdirSync(dir).filter((x) => /^run-\d+\.json$/.test(x))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (r.session_id !== sessionId) continue;
    turns += Number(r.num_turns) || 0;
    usd = Math.max(usd, Number(r.total_cost_usd) || 0);
  }
  return { turns, usd };
}

// The session a waiting step's conversation runs in: its latest run record's.
export function lastSession(p, step) {
  const dir = steps.stepDir(p, step);
  const runs = readdirSync(dir).filter((x) => /^run-\d+\.json$/.test(x)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)));
  return runs.length ? JSON.parse(readFileSync(join(dir, runs.at(-1)), 'utf8')).session_id : null;
}

// The run's end, or the budget's minutes: then its process tree is killed (TERM, then KILL) and it failed.
export async function timed(handle, minutes) {
  let timer;
  const late = new Promise((r) => (timer = setTimeout(() => r('late'), minutes * 60000)));
  const first = await Promise.race([handle.done, late]);
  clearTimeout(timer);
  if (first !== 'late') return first;
  if (handle.pid) await killTree(handle.pid);
  const after = await Promise.race([handle.done, sleep(15000).then(() => ({}))]);
  return { ...after, exitCode: 124, timedOut: true };
}

export function failureOf(o, minutes) {
  if (o.timedOut) return `no end within the budget's ${minutes} minutes`;
  const sub = o.result?.subtype && o.result.subtype !== 'success' ? ` (${o.result.subtype})` : '';
  if (o.exitCode !== 0) return `exit ${o.exitCode}${sub}`;
  if (!o.result) return 'no JSON result';
  if (o.result.is_error) return `the run ended in error (${o.result.subtype || 'is_error'})`;
  return null;
}

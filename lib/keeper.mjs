import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kirunakHome } from './home.mjs';

// The cache keeper (orchestrator.md §5, R11, D9). Each live conversation has $KIRUNAK_HOME/sessions/<id>.json: its
// last call, context, cache lifetime and expiry, what it waits for and for how long. The keeper keeps a cache warm
// while the expected wait stays under the break-even, and records every keep-alive, miss, hit and skip in
// keeper.jsonl. Only node: modules and lib/home.mjs are imported at the top: the status line's hook loads this file.

// Per cache lifetime: under the 1-hour cache a keep-alive goes at expires_at − 5 min and the threshold counts
// keeper.intervalMinutes; under the 5-minute cache, one every 4.5 minutes.
export const TTL = {
  '1h': { minutes: 60, margin: 5 },
  '5m': { minutes: 5, interval: 4.5, margin: 0.5 },
};

const exact = (x) => Math.round(x * 1e9) / 1e9;
const homeOf = (ws) => ws?.home || kirunakHome();

// The break-even in keep-alive intervals: (write − read) / read, a keep-alive reading the context once and a miss
// writing it again.
export function breakEven(w, ttl) {
  const write = ttl === '5m' ? w.write5m : w.write1h;
  return exact((write - w.cacheRead) / w.cacheRead);
}

// The rule for one lifetime, from the prices seam: { ttl, breakEven, intervalMinutes, thresholdMinutes,
// marginMinutes, weights }. The model's multiplier cancels in the break-even; its weights price the records.
export async function ruleFor(ws, ttl, model = null) {
  const t = TTL[ttl];
  if (!t) return null;
  const weights = await ws.seams.prices.weights(model);
  const intervalMinutes = t.interval ?? ws.keeper?.intervalMinutes ?? 50;
  const be = breakEven(weights, ttl);
  return { ttl, breakEven: be, intervalMinutes, thresholdMinutes: exact(be * intervalMinutes), marginMinutes: t.margin, weights };
}

// decide(conversation, now, rule) → { action: keepalive | skip | none, kind, at?, reason }. `kind` is what
// keeper.jsonl records: keepalive, skip, miss (the cache has expired: the next call writes it again), or null.
// A keep-alive goes only to a conversation that will resume, and only while its expected wait is under the threshold;
// one that waits for the owner is never kept.
export function decide(c, now, rule) {
  const expires = c?.expiresAt ? Date.parse(c.expiresAt) : NaN;
  if (!Number.isFinite(expires) || !rule) return { action: 'none', kind: null, reason: 'no warm cache is tracked' };
  if (now.getTime() >= expires) return { action: 'none', kind: 'miss', reason: `the cache expired at ${c.expiresAt}` };
  if (c.waitsFor === 'owner') return { action: 'skip', kind: 'skip', reason: 'owner' };
  if (!c.waitsFor) return { action: 'none', kind: null, reason: 'it waits for nothing' };
  if (!c.willResume) return { action: 'none', kind: null, reason: `nothing will resume it after ${c.waitsFor}` };
  const wait = c.expectedWaitMin;
  if (wait == null) return { action: 'skip', kind: 'skip', reason: 'the expected wait is unknown' };
  if (wait >= rule.thresholdMinutes) {
    return { action: 'skip', kind: 'skip', reason: `the expected wait, ${wait} min, is over the break-even, ${rule.thresholdMinutes} min` };
  }
  const at = new Date(expires - rule.marginMinutes * 60000);
  return { action: 'keepalive', kind: 'keepalive', at, reason: `${c.waitsFor}: ${wait} min expected, under ${rule.thresholdMinutes} min` };
}

// What a miss costs (writing the context again) and what a keep-alive or a hit costs (reading it), in weight.
export const costOf = (kind, context, rule) =>
  !rule || !(context > 0) ? null : kind === 'miss' ? (rule.ttl === '5m' ? rule.weights.write5m : rule.weights.write1h) * context : kind === 'skip' ? 0 : rule.weights.cacheRead * context;

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sessionPath(home, id) {
  if (!SESSION.test(id || '')) throw new Error(`not a session id: ${id}`);
  return join(home, 'sessions', `${id}.json`);
}

export function readSession(home, id) {
  try {
    const x = JSON.parse(readFileSync(sessionPath(home, id), 'utf8'));
    return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

// Merges `patch` into the session's file, written whole and renamed, so a reader never sees half of it.
export function updateSession(home, id, patch) {
  const path = sessionPath(home, id);
  const next = { ...readSession(home, id), ...patch };
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
  return next;
}

export function removeSession(home, id) {
  try {
    unlinkSync(sessionPath(home, id));
  } catch {}
}

// One line of keeper.jsonl: { ts, session, task, step, kind, context, ttl, expectedWaitMin, reason, costWeight }.
export function record(home, line) {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'keeper.jsonl'), JSON.stringify(line) + '\n');
  return line;
}

export const readLines = (home) =>
  existsSync(join(home, 'keeper.jsonl'))
    ? readFileSync(join(home, 'keeper.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean)
    : [];

export { homeOf };

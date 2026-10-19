import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';

// The cache keeper (orchestrator.md §5, R11, D9). Each live conversation has $KIRUNAK_HOME/sessions/<id>.json: its
// last call, context, cache lifetime and expiry, what it waits for and for how long. The keeper keeps a cache warm
// while the expected wait stays under the break-even, and records every keep-alive, miss, hit and skip in
// keeper.jsonl. Only node: modules and two small lib files are imported at the top: the status line's hook loads it.

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

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// A keeper.jsonl line about conversation `c`, as its file stands.
export const lineOf = (c, session, { kind, reason, costWeight = null, now }) => ({
  ts: now.toISOString(), session, task: c.task ?? null, step: c.step ?? null, kind, context: c.context ?? null, ttl: c.ttl ?? null,
  expectedWaitMin: c.expectedWaitMin ?? null, reason, costWeight,
});

// What a headless run's record says of its conversation: the run's end is its last call, the lifetime the one its
// cache writes went to. The context is one call's input, writes and reads; over several calls (the record holds
// totals) the tokens written, each of which entered the cache once, and never less than the context known before.
export function fromRun(result, end, prev = null) {
  const u = result?.usage || {};
  const cc = u.cache_creation || {};
  const ttl = n(cc.ephemeral_1h_input_tokens) > 0 ? '1h' : n(cc.ephemeral_5m_input_tokens) > 0 ? '5m' : prev?.ttl ?? null;
  const [input, write, read] = [n(u.input_tokens), n(u.cache_creation_input_tokens), n(u.cache_read_input_tokens)];
  const context = n(result?.num_turns) <= 1 ? input + write + read : Math.max(input + write, n(prev?.context));
  const expiresAt = ttl ? new Date(end.getTime() + TTL[ttl].minutes * 60000).toISOString() : null;
  // The conversation's model, for the weights: the one that read and wrote the most cache.
  const cached = (m) => n(m.cacheReadInputTokens ?? m.cache_read_input_tokens) + n(m.cacheCreationInputTokens ?? m.cache_creation_input_tokens);
  const model = Object.entries(result?.modelUsage || result?.model_usage || {}).sort(([, a], [, b]) => cached(b) - cached(a))[0]?.[0] ?? prev?.model ?? null;
  return { kind: 'headless', lastCall: end.toISOString(), context, ttl, expiresAt, model };
}

// The session file of a headless conversation after a run: fromRun, and what it waits for.
export function track(ws, { session, result, end, ...rest }) {
  const home = homeOf(ws);
  return updateSession(home, session, { ...fromRun(result, end, readSession(home, session)), ...rest });
}

// Reads the file, decides, and records a skip or a miss; the decision is returned.
export async function judge(ws, session, now) {
  const home = homeOf(ws);
  const c = readSession(home, session);
  if (!c) return null;
  const rule = await ruleFor(ws, c.ttl, c.model);
  const d = decide(c, now, rule);
  if (d.kind === 'skip' || d.kind === 'miss') record(home, lineOf(c, session, { ...d, costWeight: costOf(d.kind, c.context, rule), now }));
  return d;
}

// At a resume: a miss when the cache expired during the wait, else a hit. A run record holds totals, so its first
// call cannot be read alone: the lifetime says which it was. The file then says the conversation works again.
export async function atResume(ws, session, now) {
  const home = homeOf(ws);
  const c = readSession(home, session);
  if (!c?.expiresAt) return null;
  const rule = await ruleFor(ws, c.ttl, c.model);
  const expired = now.getTime() >= Date.parse(c.expiresAt);
  const kind = expired ? 'miss' : 'hit';
  updateSession(home, session, { waitsFor: null, willResume: false, expectedWaitMin: null });
  const reason = expired ? `the cache expired at ${c.expiresAt}` : `resumed before the cache expired at ${c.expiresAt}`;
  return record(home, lineOf(c, session, { kind, reason, costWeight: costOf(kind, c.context, rule), now }));
}

export const forget = (ws, session) => removeSession(homeOf(ws), session);

// The minutes until a guard job of one of `sessions` ends: its estimate left when it holds the lock; else the held
// job's estimate left and every queued estimate up to its own; null when the guard has no such job.
export function jobWait(status, sessions, now) {
  const left = (j) => Math.max(0, n(j.estimateMinutes) - (Number.isFinite(Date.parse(j.since)) ? (now.getTime() - Date.parse(j.since)) / 60000 : 0));
  const r2 = (x) => Math.round(x * 100) / 100;
  const h = status?.held;
  if (h && sessions.includes(h.session)) return r2(left(h));
  const queued = status?.queued || [];
  const i = queued.findIndex((q) => sessions.includes(q.session));
  return i < 0 ? null : r2((h ? left(h) : 0) + queued.slice(0, i + 1).reduce((s, q) => s + n(q.estimateMinutes), 0));
}

export const CLOCK = {
  now: () => new Date(),
  // After `ms`, or as soon as `until` settles; no timer is left behind.
  sleep: (ms, until) => new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    const stop = () => (clearTimeout(t), resolve());
    until?.then(stop, stop);
  }),
};

const event = (home, e) => appendFileSync(join(home, 'events.jsonl'), JSON.stringify(e) + '\n');

// A keep-alive is one turn: past these minutes its tree is killed, as a run past its budget is, and the keeping ends.
export const KEEP_ALIVE_MINUTES = 5;

// keepWarm({ ws, session, until, keepAlive, expectedWait, clock, out, deadlineMinutes }): while `until` (a heavy job) is
// pending, it decides on the conversation's file, and at the keep-alive time runs keepAlive() → { pid, done }, held to
// deadlineMinutes; its { exitCode, result } moves the file on and is recorded with its weight. A skip is recorded once and decided again at the keep-alive time, when
// the wait left may be under the threshold; an expired cache ends it, and the resume records the miss. A keep-alive
// whose call wrote more than it read found the cache gone: a miss too.
export async function keepWarm({ ws, session, until, keepAlive, expectedWait, clock = CLOCK, out = () => {}, deadlineMinutes = KEEP_ALIVE_MINUTES }) {
  const home = homeOf(ws);
  let settled = false;
  const done = until.then(() => (settled = true), () => (settled = true));
  let kept = 0;
  let skipped = false;
  for (;;) {
    if (settled) return { kept, ended: 'the wait ended' };
    const now = clock.now();
    let wait = null;
    try {
      wait = await expectedWait(now);
    } catch {}
    const c = updateSession(home, session, { expectedWaitMin: wait });
    const rule = await ruleFor(ws, c.ttl, c.model);
    const d = decide(c, now, rule);
    if (d.action === 'skip') {
      if (!skipped) record(home, lineOf(c, session, { ...d, costWeight: 0, now }));
      skipped = true;
      const last = Date.parse(c.expiresAt) - rule.marginMinutes * 60000;
      if (last <= now.getTime()) return { kept, ended: d.reason };
      await clock.sleep(last - now.getTime(), done);
      continue;
    }
    if (d.action !== 'keepalive') return { kept, ended: d.reason };
    if (d.at > now) {
      await clock.sleep(d.at - now, done);
      continue;
    }
    const { timed } = await import('./run.mjs');
    const r = await timed(keepAlive(), deadlineMinutes);
    const at = clock.now();
    if (r.timedOut || !r.result) {
      const reason = r.timedOut ? `the keep-alive did not end within ${deadlineMinutes} minutes` : `the keep-alive gave no result (exit ${r.exitCode ?? '?'})`;
      record(home, lineOf(c, session, { kind: 'keepalive', reason, now: at }));
      return { kept, ended: 'the keep-alive failed' };
    }
    kept++;
    const next = updateSession(home, session, fromRun(r.result, at, c));
    const { runFields, weightOf } = await import('./cost.mjs');
    const models = runFields(r.result).models;
    const costWeight = models.length ? await weightOf(models, ws.seams.prices) : costOf('keepalive', next.context, rule);
    record(home, lineOf({ ...next, expectedWaitMin: wait }, session, { kind: 'keepalive', reason: d.reason, costWeight, now: at }));
    const u = r.result.usage || {};
    if (n(u.cache_creation_input_tokens) > n(u.cache_read_input_tokens)) {
      record(home, lineOf(next, session, { kind: 'miss', reason: 'the keep-alive wrote the context again', costWeight: costOf('miss', next.context, rule), now: at }));
    }
    event(home, { time: at.toISOString(), kind: 'keep-alive', task: c.task ?? null, step: c.step ?? null, session });
    out(`keep-alive: session ${session}, ${next.context} tokens, warm until ${next.expiresAt}`);
  }
}

const NOT_WAITING = { waitsFor: null, willResume: false, expectedWaitMin: null };

// What an interactive session waits for, from its task's state on this machine; orchestrator.md §5 names the waits a
// conversation resumes from. A guard job of the session or of its task's k run: the guard's estimate. A step of its
// task running under k run: at most the budget minutes it has left, the orchestrator's timeout. A step of its task
// waiting for the owner. A headless conversation's file is k run's, and is taken as it is.
export async function waitOf(ws, c, session, now) {
  if (c.kind === 'headless') return {};
  const task = c.task || null;
  try {
    const w = jobWait(await ws.seams.resourceGuard.status(), [session, ...(task ? [`kirunak:${task}`] : [])], now);
    if (w != null) return { waitsFor: 'heavy', willResume: true, expectedWaitMin: w };
  } catch {}
  if (!task) return NOT_WAITING;
  let t = null;
  try {
    t = (await import('./steps.mjs')).load(ws, task);
  } catch {}
  const running = (await ws.seams.machineGuard.running()).filter((r) => r.task === task);
  if (running.length) {
    const { budgetOf } = await import('./run.mjs');
    const left = running.map((r) => {
      const minutes = budgetOf(ws, t?.plan.steps.find((x) => x.id === r.step) || {}).minutes;
      const since = Date.parse(r.since);
      return Math.max(0, minutes - (Number.isFinite(since) ? (now.getTime() - since) / 60000 : 0));
    });
    return { waitsFor: 'k run', willResume: true, expectedWaitMin: Math.round(Math.max(...left) * 100) / 100 };
  }
  if (t && [...t.states.values()].some((x) => x.state === 'waiting-owner')) return { waitsFor: 'owner', willResume: false, expectedWaitMin: null };
  return NOT_WAITING;
}

function keepText(d, c, session) {
  if (d.kind === 'keepalive') {
    return `keep-alive: session ${session}'s cache (${c.context ?? '?'} tokens, ${c.ttl}) would go cold at ${c.expiresAt}; this ` +
      `wake-up reads it again. While the wait goes on (${c.waitsFor}, about ${c.expectedWaitMin} min), run ` +
      `\`k keep --session ${session}\` in the background again.`;
  }
  if (d.kind === 'miss') return `session ${session}'s cache went cold at ${c.expiresAt}: the next turn writes its ${c.context ?? '?'} tokens again`;
  if (d.kind === 'skip') return `no keep-alive for session ${session}: ${d.reason === 'owner' ? 'it waits for the owner' : d.reason}`;
  return `nothing to keep for session ${session}: ${d.reason}`;
}

// `k keep --session <id>` (orchestrator.md §5), run by an interactive session as a background command. When the
// expected wait justifies a keep-alive it ends at the keep-alive time, so the session's wake-up turn reads its cache
// again; otherwise it ends at once and says why. While it waits it reads the session's file and its waits again
// every `pollMs`. dryRun: the decision now, nothing recorded and no wait.
export async function keep({ ws, session, clock = CLOCK, pollMs = 30000, dryRun = false }) {
  const home = homeOf(ws);
  for (;;) {
    const c = readSession(home, session);
    if (!c) throw refuse(`no session file for ${session}: the status line's tracker writes it (k install --print)`);
    const now = clock.now();
    const conv = { ...c, ...(await waitOf(ws, c, session, now)) };
    const rule = await ruleFor(ws, conv.ttl, conv.model);
    const d = decide(conv, now, rule);
    if (!dryRun && d.action === 'keepalive' && d.at > now) {
      await clock.sleep(Math.min(d.at - now, pollMs));
      continue;
    }
    if (!dryRun && d.kind) {
      record(home, lineOf(conv, session, { ...d, costWeight: costOf(d.kind, conv.context, rule), now }));
      if (d.kind === 'keepalive') event(home, { time: now.toISOString(), kind: 'keep-alive', task: conv.task ?? null, step: conv.step ?? null, session });
    }
    const text = dryRun && d.action === 'keepalive' ? `would end at ${d.at.toISOString()} for a keep-alive (${d.reason})` : keepText(d, conv, session);
    return { ...d, conversation: conv, text };
  }
}

// The ISO week of a local date: 2026-W45.
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const first = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - first) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

// `k keeper report` (orchestrator.md §5): keeper.jsonl summed per task and per week, keep-alives and misses with
// their weight, hits and skips. A line written without a weight (the SessionStart hook's) is priced here from its
// context and lifetime with the prices seam; one that has neither is counted as unpriced. A line's task is its own,
// else its session file's.
export async function report(ws) {
  const home = homeOf(ws);
  const tasks = new Map();
  const weeks = new Map();
  const row = (map, key) => map.get(key) || map.set(key, { key, keepalives: 0, keepWeight: 0, misses: 0, missWeight: 0, hits: 0, skips: 0, unpriced: 0 }).get(key);
  for (const l of readLines(home)) {
    let task = l.task;
    try {
      task ??= readSession(home, l.session)?.task;
    } catch {}
    const priced = l.kind === 'keepalive' || l.kind === 'miss';
    const weight = l.costWeight ?? (priced ? costOf(l.kind, l.context, await ruleFor(ws, l.ttl, l.model)) : null);
    const ts = new Date(l.ts);
    for (const r of [row(tasks, task || '(no task)'), row(weeks, Number.isFinite(ts.getTime()) ? isoWeek(ts) : '(no date)')]) {
      if (l.kind === 'keepalive') [r.keepalives, r.keepWeight] = [r.keepalives + 1, r.keepWeight + (weight ?? 0)];
      else if (l.kind === 'miss') [r.misses, r.missWeight] = [r.misses + 1, r.missWeight + (weight ?? 0)];
      else if (l.kind === 'hit') r.hits++;
      else if (l.kind === 'skip') r.skips++;
      if (priced && weight == null) r.unpriced++;
    }
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  return { tasks: [...tasks.values()].sort(byKey), weeks: [...weeks.values()].sort(byKey) };
}

const big = (x) => (x >= 1e4 ? x.toExponential(2).replace('e+', 'e') : String(Math.round(x)));
const count = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const rowText = (r) =>
  `  ${r.key}: ${count(r.keepalives, 'keep-alive')}, weight ${big(r.keepWeight)}; ${count(r.misses, 'miss', 'misses')}, weight ${big(r.missWeight)}; ` +
  `${count(r.hits, 'hit')}; ${count(r.skips, 'skip')}${r.unpriced ? ` (${r.unpriced} without a context to price)` : ''}`;

export function formatReport(r) {
  if (!r.tasks.length) return 'no keep-alive, miss, hit or skip recorded yet';
  return ['per task', ...r.tasks.map(rowText), 'per week', ...r.weeks.map(rowText)].join('\n');
}

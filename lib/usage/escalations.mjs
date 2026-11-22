// escalations.txt: the week's escalations per trigger, with whether each step then passed and the tokens it cost
// (gulnya/enforced-escalation AC-22), from $KIRUNAK_HOME/events.jsonl (k run) and escalate.log (the hook).
// k run's rows carry their own tokens and `passed`; the hook's `rung agent ended` rows carry the tokens of each rung agent
// run after a fire or a block, and a step passed after a trigger when no later failure of its signature followed.
// Then the steps stopped for the owner by reason and task (gulnya/usage-improve-11-22 AC-10), from readTasks's tasks.
import { join } from 'node:path';
import { jsonLines, mult, printer } from './common.mjs';
import { localZone, zoned } from './week.mjs';

// A stop's reason, by its why's words (lib/steps.mjs's escalate and repeatStop, lib/run.mjs's because): `unchanged
// checkout` (steps.unchangedFailure), `unfinished after its resume` (run.mjs's resume stop), `failed on every rung`
// (the ladder's top), `not met in review-<a> and review-<b>` (repeatStop), `passed but wrote no` (steps.missingWhy);
// any other why, a heavy step's `failed N times` among them, is `other`.
export const STOP_REASONS = [
  ['heavy, unchanged checkout', /unchanged checkout/],
  ['unfinished after its resume', /unfinished after its resume/],
  ['failed on every rung', /failed on every rung/],
  ['not met in two reviews', /not met in review-\d+ and review-\d+/],
  ['missing outputs', /passed but wrote no /],
];
export const stopReason = (why) => STOP_REASONS.find(([, re]) => re.test(why))?.[0] ?? 'other';
const ORDER = [...STOP_REASONS.map(([r]) => r), 'other'];

// A stop's progress line (lib/steps.mjs's STOP_LINE after note's `escalated:`), the colon optional.
const STOP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (S-[A-Za-z0-9-]+) escalated:? stopped for the owner, (.*)$/;

// The week's stops: `tasks` are readTasks's, whose `lines` are a Set over every checkout's copy of progress.md, so a
// task with several worktrees counts each stop once. Lines read in `zone`, as readTasks reads them.
// → the section's lines: the count, a line per reason, a line per task (most stops first) with its stops by reason.
export function stopsSection(tasks, from, to, zone = localZone()) {
  const [lo, hi] = [Date.parse(from), Date.parse(to)];
  const byReason = new Map(), byTask = [];
  let n = 0;
  for (const t of tasks.values()) {
    const mine = new Map();
    for (const l of t.lines ?? []) {
      const m = STOP.exec(l);
      if (!m) continue;
      const at = zoned(m[1], m[2], zone);
      if (at < lo || at >= hi) continue;
      const r = stopReason(m[4]);
      mine.set(r, (mine.get(r) || 0) + 1);
      byReason.set(r, (byReason.get(r) || 0) + 1);
      n++;
    }
    if (mine.size) byTask.push({ id: t.id, mine, n: [...mine.values()].reduce((s, x) => s + x, 0) });
  }
  const sorted = (m) => [...m].sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  const out = [`stops for the owner: ${n}`];
  for (const [r, c] of sorted(byReason)) out.push(`  ${r}: ${c}`);
  for (const t of byTask.sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))) {
    out.push(`  ${t.id}: ${t.n} (${sorted(t.mine).map(([r, c]) => `${r} ${c}`).join(', ')})`);
  }
  return out;
}

const M = (n) => `${(n / 1e6).toFixed(1)}M`;

// `tasks` (readTasks's) give the stops section; without them it is left out.
export function escalations(home, from, to, { tasks = null, zone = localZone() } = {}) {
  const rows = (f) => jsonLines(f).filter((r) => r.time >= from && r.time < to);

  // k run: a climb, a stop, and each rung run's end (passed, tokens; a cache write is counted as a 5-minute one).
  const ev = rows(join(home, 'events.jsonl'));
  // Only rows with a trigger: an `escalate` row written before the ladder (models.escalate's mark) was a stop, not a climb.
  const ours = ev.filter((e) => e.kind === 'escalate' && e.trigger);
  const climbs = ours.filter((e) => e.to), stops = ours.filter((e) => e.stopped);
  const runs = ev.filter((e) => e.kind === 'escalated-run');
  // A design run passes once its design is written; the step passed only if the build after it did, so only builds count.
  const builds = runs.filter((e) => e.phase !== 'design');
  const runW = (e) => { const t = e.tokens || {}; return mult(e.rung?.model || '') * ((t.input || 0) + 1.25 * (t.cacheWrite || 0) + 0.1 * (t.cacheRead || 0) + 5 * (t.output || 0)); };
  const out = [
    `k run failure count: ${climbs.length} climbs, ${stops.length} stopped for the owner; rung runs ${runs.length} (${runs.length - builds.length} designs), builds passed ${builds.filter((e) => e.passed).length} of ${builds.length}, weight ${M(runs.reduce((s, e) => s + runW(e), 0))}`,
  ];

  // The hook: per trigger, the count, whether the step then passed (no later failure of the same signature in that
  // session: a block, a repeat, a fire), and the tokens of the rung agents run for it (`rung agent ended` rows, by `for`).
  const log = rows(join(home, 'escalate.log'));
  const FAILS = new Set(['hook fired', 'hook blocked', 'repeat after fire']);
  const passedAfter = (r) => !log.some((x) => x.session === r.session && x.time > r.time && FAILS.has(x.trigger) && x.signature?.hash && x.signature.hash === r.signature?.hash);
  const tokW = (r) => { const t = r.tokens || {}; return mult(r.model || '') * ((t.input || 0) + 1.25 * (t.cacheWrite || 0) + 0.1 * (t.cacheRead || 0) + 5 * (t.output || 0)); };
  // An agent that ended twice (a hand-back after an unfinished stop) has two rows; the newest is its whole run.
  const ended = Object.values(Object.fromEntries(log.filter((r) => r.trigger === 'rung agent ended').map((r) => [`${r.session} ${r.agent}`, r])));
  for (const t of ['hook fired', 'hook blocked', 'block lifted', '/k-go-on override']) {
    const rs = log.filter((r) => r.trigger === t);
    const mine = ended.filter((r) => r.for === t);
    const spent = t === 'hook fired' || t === 'hook blocked' ? `, rung agents ${mine.length} (weight ${M(mine.reduce((s, r) => s + tokW(r), 0))})`
      : t === '/k-go-on override' ? ', no agent (0 tokens)' : '';
    out.push(`${t}: ${rs.length}, passed after it ${rs.filter(passedAfter).length}${spent}`);
  }
  const by = {};
  for (const r of log) if (!['hook fired', 'hook blocked', 'block lifted', '/k-go-on override', 'rung agent ended'].includes(r.trigger)) by[r.trigger] = (by[r.trigger] || 0) + 1;
  for (const [t, n] of Object.entries(by).sort()) out.push(`${t}: ${n}`);
  if (tasks) out.push(...stopsSection(tasks, from, to, zone));
  const p = printer();
  p.log(out.join('\n'));
  return p.text();
}

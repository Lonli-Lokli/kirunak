// escalations.txt: the week's escalations per trigger, with whether each step then passed and the tokens it cost
// (gulnya/enforced-escalation AC-22), from $KIRUNAK_HOME/events.jsonl (k run) and escalate.log (the hook).
// k run's rows carry their own tokens and `passed`; the hook's `rung agent ended` rows carry the tokens of each rung agent
// run after a fire or a block, and a step passed after a trigger when no later failure of its signature followed.
import { join } from 'node:path';
import { jsonLines, mult, printer } from './common.mjs';

const M = (n) => `${(n / 1e6).toFixed(1)}M`;

export function escalations(home, from, to) {
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
  const p = printer();
  p.log(out.join('\n'));
  return p.text();
}

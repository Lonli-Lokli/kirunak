// ttl.txt, a counterfactual: the same calls, the same timing, under a 5-minute and a 1-hour cache.
// A call hits when the previous call of the same conversation came within the TTL (each read refreshes it).
// Hit: read the previous context (0.1x), write only what is new. Miss: write the whole context.
import { mult, printer } from './common.mjs';

export function ttl(rows) {
  const p = printer();
  const calls = rows.filter((r) => r.kind === 'call');
  const g = {};
  for (const c of calls) { c.ctx = c.inp + c.cw5 + c.cw1h + c.cr; (g[`${c.session}/${c.sub || 'main'}`] ??= []).push(c); }
  const res = {};
  const gaps = { main: [], sub: [] };
  for (const [k, xs] of Object.entries(g)) {
    xs.sort((a, b) => a.ts.localeCompare(b.ts));
    const kind = k.endsWith('/main') ? 'main' : 'sub';
    for (const [name, minutes, wp] of [['5m', 5, 1.25], ['1h', 60, 2]]) {
      const r = (res[`${kind} ${name}`] ??= { w: 0, misses: 0 });
      let prev = null;
      for (const c of xs) {
        const m = mult(c.model);
        const gap = prev ? (Date.parse(c.ts) - Date.parse(prev.ts)) / 60000 : Infinity;
        const base = prev && gap <= minutes ? Math.min(prev.ctx, c.ctx) : 0; // a compaction shrinks ctx: nothing beyond it is reused
        if (prev && gap > minutes) r.misses++;
        r.w += m * (0.1 * base + wp * (c.ctx - base) + 5 * c.out);
        prev = c;
      }
    }
    for (let i = 1; i < xs.length; i++) gaps[kind].push((Date.parse(xs[i].ts) - Date.parse(xs[i - 1].ts)) / 60000);
  }
  const actual = { main: 0, sub: 0 };
  for (const c of calls) actual[c.sub ? 'sub' : 'main'] += mult(c.model) * (c.inp + 1.25 * c.cw5 + 2 * c.cw1h + 0.1 * c.cr + 5 * c.out);
  const T = actual.main + actual.sub;
  for (const kind of ['main', 'sub']) {
    const a = res[`${kind} 5m`], b = res[`${kind} 1h`];
    // A week with no calls of a kind (no agents ran) has nothing to simulate: weekly.mjs's ttl.mjs failed there.
    if (!a || !b) continue;
    p.log(kind, 'actual', `${(100 * actual[kind] / T).toFixed(1)}%`, '| simulated 5m', `${(100 * a.w / T).toFixed(1)}%`, `${a.misses} misses`, '| simulated 1h',
      `${(100 * b.w / T).toFixed(1)}%`, `${b.misses} misses`, '| 1h saves', `${(100 * (a.w - b.w) / a.w).toFixed(1)}% of`, kind);
    const gs = gaps[kind];
    p.log('   gaps between calls: >5min', gs.filter((x) => x > 5).length, ' 5-60min', gs.filter((x) => x > 5 && x <= 60).length, ' >60min',
      gs.filter((x) => x > 60).length, ' of', gs.length);
  }
  // The whole week under one cache for main sessions and agents alike (gulnya/k-usage S-4: the script's two fixed
  // weeks of 2026-10-04 and 2026-10-11 read NaN on any other week). A week with nothing to compare gets no line.
  {
    let w5 = 0, w1 = 0;
    for (const ys of Object.values(g)) {
      if (!ys.length) continue;
      for (const [minutes, wp, acc] of [[5, 1.25, 'a'], [60, 2, 'b']]) {
        let prev = null, s = 0;
        for (const c of ys) {
          const gap = prev ? (Date.parse(c.ts) - Date.parse(prev.ts)) / 60000 : Infinity;
          const base = prev && gap <= minutes ? Math.min(prev.ctx, c.ctx) : 0;
          s += mult(c.model) * (0.1 * base + wp * (c.ctx - base) + 5 * c.out);
          prev = c;
        }
        if (acc === 'a') w5 += s; else w1 += s;
      }
    }
    if (w5 > 0) p.log('the week: 1h vs 5m for everything:', `${(100 * (w1 - w5) / w5).toFixed(1)}%`);
  }
  return p.text();
}

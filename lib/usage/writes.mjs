// writes.txt: where the cache writes went: the first call, after a compaction, after the cache expired, a break with
// no visible cause (the cache read fell while the gap was short), or plain growth.
import { contextOf as ctx, mult, printer, weight as w } from './common.mjs';

const ww = (c) => mult(c.model) * (1.25 * c.cw5 + 2 * c.cw1h);

export function writes(rows) {
  const p = printer();
  const conv = {};
  let total = 0;
  for (const r of rows) {
    if (r.kind === 'call' && r.model === '<synthetic>') continue;
    (conv[`${r.session}/${r.sub || ''}`] ??= []).push(r);
    if (r.kind === 'call') total += w(r);
  }
  const agg = {}, breaks = [];
  const add = (k, x) => { const a = (agg[k] ??= { n: 0, w: 0 }); a.n++; a.w += x; };
  for (const xs of Object.values(conv)) {
    xs.sort((a, b) => a.ts.localeCompare(b.ts));
    let prev = null, compacted = false;
    for (const c of xs) {
      if (c.kind === 'compact') { compacted = true; continue; }
      const kind = c.sub ? 'agent' : 'main', ttl = (c.cw1h > c.cw5 ? 60 : 5) * 6e4;
      const gap = prev ? Date.parse(c.ts) - Date.parse(prev.ts) : 0;
      let k;
      if (!prev) k = 'first call';
      else if (compacted) k = 'after compaction';
      else if (gap > ttl) k = 'cache expired';
      else if (c.cr < 0.8 * ctx(prev) && ctx(prev) - c.cr > 20000) { k = 'break, short gap'; breaks.push({ c, prev, gap, lost: ctx(prev) - c.cr }); }
      else k = 'growth';
      add(`${kind} ${k}`, ww(c)); prev = c; compacted = false;
    }
  }
  const allw = Object.values(agg).reduce((s, a) => s + a.w, 0);
  p.log('cache writes', `${(100 * allw / total).toFixed(1)}% of the week`);
  for (const [k, a] of Object.entries(agg).sort((x, y) => y[1].w - x[1].w)) {
    p.log(k.padEnd(28), String(a.n).padStart(6), `${(100 * a.w / total).toFixed(2).padStart(6)}% of week`);
  }
  // What breaks have in common: a model change, the hour, the gap.
  const g = {};
  for (const b of breaks) {
    const k = (b.c.model !== b.prev.model ? `model ${b.prev.model.replace('claude-', '')}→${b.c.model.replace('claude-', '')}` : 'same model')
      + (b.gap > 300e3 ? ', gap 5-60m' : ', gap <5m');
    (g[k] ??= { n: 0, lost: 0 }); g[k].n++; g[k].lost += b.lost;
  }
  p.log('-- breaks with a short gap');
  for (const [k, a] of Object.entries(g).sort((x, y) => y[1].lost - x[1].lost)) p.log(k.padEnd(40), a.n, `rewrote ~${Math.round(a.lost / 1e6)}M tokens`);
  return p.text();
}

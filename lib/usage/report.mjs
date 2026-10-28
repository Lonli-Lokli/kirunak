// report.txt: where the week's weight went, by day, model, token category, context size, agent and session.
import { mult, printer, weight } from './common.mjs';

export function report(rows) {
  const p = printer();
  const calls = rows.filter((r) => r.kind === 'call');
  for (const c of calls) { c.w = weight(c); c.ctx = c.inp + c.cw5 + c.cw1h + c.cr; c.day = c.ts.slice(0, 10); }
  const total = calls.reduce((s, c) => s + c.w, 0);
  const pct = (x) => `${(100 * x / total).toFixed(1)}%`;
  const group = (xs, key) => { const g = {}; for (const x of xs) (g[key(x)] ??= []).push(x); return g; };
  const sumw = (xs) => xs.reduce((s, c) => s + c.w, 0);
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const line = (...a) => p.log(a.join('\t'));

  p.log('== days covered', calls[0] && [...new Set(calls.map((c) => c.day))].sort().join(' '));
  p.log('\n== by day: weight share, main vs sub');
  for (const [d, xs] of Object.entries(group(calls, (c) => c.day)).sort()) {
    const m = sumw(xs.filter((c) => !c.sub)), s = sumw(xs.filter((c) => c.sub));
    line(d, pct(m + s), `main ${pct(m)}`, `sub ${pct(s)}`, `calls ${xs.length}`);
  }
  p.log('\n== by model (main/sub)');
  for (const [k, xs] of Object.entries(group(calls, (c) => (c.sub ? 'sub ' : 'main ') + c.model))) line(k, pct(sumw(xs)), `${xs.length} calls`);

  p.log('\n== weight by token category');
  const cat = { input: 0, cw5: 0, cw1h: 0, cacheRead: 0, output: 0 };
  for (const c of calls) {
    const k = mult(c.model);
    cat.input += k * c.inp; cat.cw5 += k * 1.25 * c.cw5; cat.cw1h += k * 2 * c.cw1h; cat.cacheRead += k * 0.1 * c.cr; cat.output += k * 5 * c.out;
  }
  for (const [k, v] of Object.entries(cat)) line(k, pct(v));
  const thinkW = calls.reduce((s, c) => s + mult(c.model) * 5 * c.think, 0);
  line('  of which thinking output', pct(thinkW));

  p.log('\n== main-session calls by context size bucket');
  const buckets = [0, 50e3, 100e3, 200e3, 300e3, 400e3, 500e3, 700e3, 1e9];
  const mains = calls.filter((c) => !c.sub);
  for (let i = 0; i < buckets.length - 1; i++) {
    const xs = mains.filter((c) => c.ctx >= buckets[i] && c.ctx < buckets[i + 1]);
    line(`${fmt(buckets[i])}-${fmt(buckets[i + 1])}`, `${xs.length} calls`, pct(sumw(xs)));
  }

  p.log('\n== fresh-context baseline: first call of each main session, by project (median ctx)');
  const sessions = group(mains, (c) => c.session);
  const firsts = Object.values(sessions).map((xs) => xs.sort((a, b) => a.ts.localeCompare(b.ts))[0]);
  for (const [pr, xs] of Object.entries(group(firsts, (c) => c.proj))) {
    line(pr, `n=${xs.length}`, `median ${fmt(med(xs.map((c) => c.ctx)))}`, `max ${fmt(Math.max(...xs.map((c) => c.ctx)))}`);
  }

  p.log('\n== subagents');
  const subs = Object.values(group(calls.filter((c) => c.sub), (c) => `${c.session}/${c.sub}`)).map((xs) => {
    xs.sort((a, b) => a.ts.localeCompare(b.ts));
    const later = xs.slice(1).filter((c) => c.cw5 + c.cw1h > 20000);
    return {
      type: xs[0].agentType, desc: xs[0].desc, proj: xs[0].proj, model: xs[0].model, n: xs.length, w: sumw(xs), first: xs[0].ctx,
      firstW: xs[0].w, last: xs.at(-1).ctx, rewrites: later.length, rewriteW: sumw(later),
      cw1h: xs.reduce((s, c) => s + mult(c.model) * c.cw1h, 0), out: xs.reduce((s, c) => s + c.out, 0), day: xs[0].day,
    };
  });
  line('count', subs.length, 'total share', pct(subs.reduce((s, a) => s + a.w, 0)));
  for (const [t, xs] of Object.entries(group(subs, (a) => a.type || '?')).sort((a, b) => sumw(b[1]) - sumw(a[1]))) {
    line(t, `${xs.length} agents`, pct(sumw(xs)), `median calls ${med(xs.map((a) => a.n))}`, `median first ctx ${fmt(med(xs.map((a) => a.first)))}`,
      `median last ctx ${fmt(med(xs.map((a) => a.last)))}`);
  }
  p.log('-- size of agents by number of calls');
  for (const [lo, hi] of [[1, 5], [5, 15], [15, 40], [40, 100], [100, 1e9]]) {
    const xs = subs.filter((a) => a.n >= lo && a.n < hi);
    line(`${lo}-${hi === 1e9 ? '∞' : hi - 1} calls`, `${xs.length} agents`, pct(sumw(xs)));
  }
  const startup = subs.reduce((s, a) => s + a.firstW, 0);
  line('first-call cost of all agents (startup)', pct(startup));
  line('mid-agent cache rewrites >20k (TTL expiry / compaction)', `${subs.reduce((s, a) => s + a.rewrites, 0)} rewrites`, pct(subs.reduce((s, a) => s + a.rewriteW, 0)));
  const cw1hSub = subs.reduce((s, a) => s + a.cw1h, 0);
  line('subagent 1h cache writes: extra over 5m price (0.75x)', pct(0.75 * cw1hSub));
  p.log('-- top 15 agents by weight');
  for (const a of subs.sort((x, y) => y.w - x.w).slice(0, 15)) {
    line(a.day, a.proj, a.type, a.model.replace('claude-', ''), `${a.n} calls`, `ctx ${fmt(a.first)}→${fmt(a.last)}`, pct(a.w), (a.desc || '').slice(0, 50));
  }

  p.log('\n== main-session cache rewrites mid-session (>20k written, not first call)');
  let rw = 0, rwn = 0;
  for (const xs of Object.values(sessions)) for (const c of xs.slice(1)) if (c.cw5 + c.cw1h > 20000) { rw += c.w; rwn++; }
  line(`${rwn} rewrites`, pct(rw));

  p.log('\n== top 12 main sessions by weight');
  const sess = Object.entries(sessions).map(([s, xs]) => ({
    s, proj: xs[0].proj, model: xs[0].model, n: xs.length, w: sumw(xs), avgctx: xs.reduce((a, c) => a + c.ctx, 0) / xs.length,
    maxctx: Math.max(...xs.map((c) => c.ctx)), day: xs[0].day, subw: sumw(calls.filter((c) => c.sub && c.session === s)),
    subn: new Set(calls.filter((c) => c.sub && c.session === s).map((c) => c.sub)).size,
  }));
  for (const x of sess.sort((a, b) => b.w - a.w).slice(0, 12)) {
    line(x.day, x.proj, x.s.slice(0, 8), x.model.replace('claude-', ''), `${x.n} calls`, `avg ctx ${fmt(x.avgctx)}`, `max ${fmt(x.maxctx)}`, `main ${pct(x.w)}`,
      `its agents ${x.subn} ${pct(x.subw)}`);
  }
  p.log('\n== by project');
  for (const [pr, xs] of Object.entries(group(calls, (c) => c.proj)).sort((a, b) => sumw(b[1]) - sumw(a[1]))) line(pr, pct(sumw(xs)));
  p.log('\n== compactions', rows.filter((r) => r.kind === 'compact').length);
  return p.text();
}

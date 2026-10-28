// The handover's replay (gulnya/fresh-session-per-step S-2, AC-10): the handover size, from a replay of the week's main
// sessions; replay.txt and replay.tsv (the weekly review's `measured:` line is the handover's saving, AC-9).
//
// Every main session (a top-level transcript, never subagents/) with calls in the window whose id a progress.md step
// line in any repo's kirunak/tasks names. Each call's context is input + cache writes + cache reads, as calls.jsonl
// holds it. The step boundary is E-2's: a moment when no step the session started is still running. For today (no
// handover, the 500k window) and for each candidate handover size from 100k to 300k in steps of 25k, a compaction is
// simulated at the first call past the size made at a boundary (and, for every scenario, past the mid-step limit's
// threshold, D-2/E-1), charged as one call reading the whole context and writing the summary, plus a fresh start; the
// later calls' context is lowered by what it removed. The weight is lib/cost.mjs weightOf with the workspace's `prices`
// seam. Returns the summary and the markdown table; writes one TSV row per session per scenario, plus totals.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { weightOf } from '../../cost.mjs';
import { jsonLines, printer } from '../common.mjs';
import { CANDIDATES, HOOK_CHARS, IDLE, k, median, MID_WINDOW, OFFSET, readWindow, T_MID } from './read.mjs';
import { readTranscripts } from './transcripts.mjs';

// `rows` are calls.jsonl's rows, `tasks` readTasks's, `projects` the transcripts' folder, `skipped` the transcripts
// the scan left out, `home` $KIRUNAK_HOME (its compact.log), `prices` the workspace's prices seam, `tsv` where the rows go.
export async function replayWeek({ rows: all, tasks, from: FROM, to: TO, projects, skipped, home, prices, tsv: TSV }) {
  const p = printer();
  const { rows, bySession, undated } = readWindow(all, tasks, FROM, TO);
  const { meta, refined, unrefined, fit, CPT, HOOK_TOKENS } = await readTranscripts(projects, bySession, skipped);

  // 4. Each chosen session's calls in order, the real compactions between them, and the uncompacted context u: across a
  // real compaction the context is taken to grow by nothing, so u carries on from the call before it.
  const sessions = [];
  for (const [id, ivs] of bySession) {
    const rs = rows.filter((r) => r.session === id).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const info = meta.get(id);
    const calls = [];
    let pending = null, C = 0;
    for (const r of rs) {
      if (r.kind === 'compact') { const b = info.boundaries.get(r.ts); if (b) pending = b; continue; }
      if (r.kind !== 'call') continue;
      const cw = r.cw5 + r.cw1h, ctx = r.inp + cw + r.cr;
      const c = { t: Date.parse(r.ts), model: r.model, inp: r.inp, cw5: r.cw5, cw1h: r.cw1h, cw, cr: r.cr, out: r.out, ctx, real: null };
      const q = calls[calls.length - 1];
      if (pending && q) { c.real = pending; C = q.u - ctx; }
      pending = null;
      c.u = ctx + C;
      c.g = q ? Math.min(Math.max(0, c.u - q.u), c.inp + cw) : 0;
      calls.push(c);
    }
    if (!calls.length) continue;
    const w1 = calls.reduce((s, c) => s + c.cw1h, 0), wAll = calls.reduce((s, c) => s + c.cw, 0);
    const firstStart = Math.min(...ivs.map((iv) => iv.start));
    sessions.push({ id, proj: rs[0].proj, entry: info.entry || '?', interactive: info.entry === 'cli', ivs, firstStart, calls, p1h: wAll ? w1 / wAll : 1 });
  }

  // 4a. A week with the handover (gulnya/fresh-session-per-step S-9): a real compaction compact.log let through at a step
  // boundary (R4.9, R4.8a) is the handover's, not an idle one, so today's scenario does not compact there. The session's
  // last PreCompact line in the 10 minutes before the boundary decides.
  const clog = jsonLines(join(home, 'compact.log')).filter((l) => !l.event && l.session);
  for (const s of sessions) {
    for (const [ts, b] of meta.get(s.id).boundaries) {
      const t = Date.parse(ts), fire = clog.filter((l) => l.session === s.id && Date.parse(l.ts) <= t && t - Date.parse(l.ts) < 600000).pop();
      if (fire?.decision === 'allow' && /^boundary/.test(fire.why || '')) b.handover = true;
    }
  }

  // 5. The fresh start, measured from the real compactions of these sessions: the first call after each boundary (its
  // cache reads are the prefix that stayed cached, its writes the rest), plus what the SessionStart hook will put back.
  const reals = sessions.flatMap((s) => s.calls.filter((c) => c.real).map((c) => ({ ...c.real, ctx: c.ctx, cr: c.cr, cw: c.cw })));
  const F_FIRST = median(reals.map((r) => r.ctx)) ?? 40000;
  const F_READ = median(reals.map((r) => r.cr)) ?? 20000;
  const F = F_FIRST + HOOK_TOKENS; // with kirunak's put-back; today's sessions had none (the SessionStart hook acts on resume only)
  const SUMMARY = Math.round(median(reals.filter((r) => r.summaryChars).map((r) => r.summaryChars / CPT)) ?? median(reals.map((r) => r.post)) ?? 12000);

  // The re-reading after a real compaction (a diagnostic, not charged): growth over the 20 calls after it against the
  // session's own mean growth per call.
  const reread = [];
  for (const s of sessions) {
    const gs = s.calls.map((c) => c.g), mean = gs.reduce((a, b) => a + b, 0) / gs.length;
    s.calls.forEach((c, i) => { if (c.real && i + 20 <= s.calls.length) reread.push(gs.slice(i + 1, i + 21).reduce((a, b) => a + b, 0) - 20 * mean); });
  }

  // 6. The replay.
  const running = (s, t) => s.ivs.some((iv) => iv.start <= t && t < iv.end);
  function replay(s, H, F, summary = SUMMARY, TM = T_MID) {
    const acc = new Map(), add = (model, f) => {
      const a = acc.get(model) || { model, input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 };
      for (const [key, v] of Object.entries(f)) a[key] += v;
      acc.set(model, a);
    };
    let D = 0, comps = 0, ctxSum = 0, max = 0, handovers = 0;
    s.calls.forEach((c, i) => {
      let sim = c.u - D;
      const handover = H && s.interactive && c.t >= s.firstStart && sim >= H && !running(s, c.t);
      const kind = c.real?.trigger === 'manual' ? 'manual' : c.real && !c.real.handover && c.real.pre < T_MID - 20000 ? 'idle' : null;
      const compact = i > 0 && (kind === 'manual' || (kind === 'idle' && sim >= IDLE) || sim >= TM || handover);
      if (compact && handover && sim < TM && !kind) handovers++;
      if (compact) {
        const q = s.calls[i - 1];
        add(c.model, { cacheRead: q.u - D + q.out, output: summary }); // one call reading the whole context
        D = c.u - (F + c.g); sim = F + c.g; comps++;
        const gw = Math.min(c.cw, Math.max(0, c.g - c.inp)) + (F - F_READ);
        add(c.model, { input: c.inp, cacheRead: F_READ, write1h: gw * s.p1h, write5m: gw * (1 - s.p1h), output: c.out });
      } else {
        const old = c.ctx - c.g, oldS = Math.max(0, sim - c.g);
        const f = c.real ? 1 : old > 0 ? Math.min(c.cr, old) / old : 1;
        const gw = c.real ? 0 : Math.min(c.cw, Math.max(0, c.g - c.inp));
        const w = gw + (1 - f) * oldS, p1h = c.cw ? c.cw1h / c.cw : s.p1h;
        add(c.model, { input: c.inp, cacheRead: f * oldS, write1h: w * p1h, write5m: w * (1 - p1h), output: c.out });
      }
      ctxSum += sim; max = Math.max(max, sim);
    });
    return { comps, handovers, ctxSum, max, models: [...acc.values()] };
  }
  const actualOf = async (s) => weightOf([...s.calls.reduce((m, c) => {
    const a = m.get(c.model) || { model: c.model, input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 };
    a.input += c.inp; a.write5m += c.cw5; a.write1h += c.cw1h; a.cacheRead += c.cr; a.output += c.out; m.set(c.model, a); return m;
  }, new Map()).values()], prices);

  const scenarios = [{ name: 'today', H: null, F: F_FIRST }, ...CANDIDATES.map((H) => ({ name: k(H), H, F }))];
  const tsv = [['scenario', 'handover_size', 'auto_compact_window', 'session', 'repo', 'entrypoint', 'calls', 'real_compactions', 'compactions', 'mean_context', 'max_context', 'weight', 'change_vs_today'].join('\t')];
  const totals = [];
  const todayBy = new Map();
  for (const sc of scenarios) {
    let W = 0, comps = 0, ctxSum = 0, n = 0, Wi = 0, handed = 0;
    for (const s of sessions) {
      const r = replay(s, sc.H, sc.F, SUMMARY, sc.TM);
      if (r.handovers) handed++;
      const w = await weightOf(r.models, prices);
      if (sc.name === 'today') todayBy.set(s.id, w);
      const base = todayBy.get(s.id);
      W += w; comps += r.comps; ctxSum += r.ctxSum; n += s.calls.length; if (s.interactive) Wi += w;
      tsv.push([sc.name, sc.H ?? '', sc.H ? sc.H + OFFSET : MID_WINDOW, s.id, s.proj, s.entry, s.calls.length, s.calls.filter((c) => c.real).length, r.comps,
        Math.round(r.ctxSum / s.calls.length), Math.round(r.max), Math.round(w), base ? ((w / base - 1) * 100).toFixed(2) + '%' : ''].join('\t'));
    }
    totals.push({ ...sc, W, Wi, comps, handed, mean: ctxSum / n, n });
  }
  const today = totals[0];
  for (const t of totals) {
    tsv.push([t.name, t.H ?? '', t.H ? t.H + OFFSET : MID_WINDOW, 'TOTAL', '', '', t.n, reals.length, t.comps, Math.round(t.mean), '', Math.round(t.W),
      ((t.W / today.W - 1) * 100).toFixed(2) + '%'].join('\t'));
  }
  writeFileSync(TSV, tsv.join('\n') + '\n');

  // 7. The summary.
  const inter = sessions.filter((s) => s.interactive);
  let actual = 0;
  for (const s of sessions) actual += await actualOf(s);
  const ranked = totals.slice(1).sort((a, b) => a.W - b.W), best = ranked[0], second = ranked[1];
  const trig = reals.reduce((m, r) => { const x = r.handover ? 'auto, handover' : r.trigger === 'auto' && r.pre < T_MID - 20000 ? 'auto, idle' : r.trigger; return { ...m, [x]: (m[x] || 0) + 1 }; }, {});
  p.log(`window ${FROM} .. ${TO}`);
  p.log(`sessions ${sessions.length} (interactive ${inter.length}, headless ${sessions.length - inter.length}), calls ${today.n} (interactive ${inter.reduce((x, s) => x + s.calls.length, 0)}); step lines without a date ${undated}`);
  p.log(`steps ${refined + unrefined} started by these sessions, ${refined} timed to the second from the session's own k step commands`);
  p.log(`real compactions ${reals.length} ${JSON.stringify(trig)}; preTokens median ${k(median(reals.map((r) => r.pre)) || 0)}, postTokens median ${k(median(reals.map((r) => r.post)) || 0)}, summary median ${median(reals.map((r) => r.summaryChars).filter(Boolean)) || 0} chars`);
  p.log(`first call after a boundary: context median ${k(F_FIRST)} (cache read ${k(F_READ)}), range ${k(Math.min(...reals.map((r) => r.ctx)))}..${k(Math.max(...reals.map((r) => r.ctx)))}`);
  p.log(`characters per token ${CPT.toFixed(2)}: slope over ${fit?.n} Bash results of .md files (4,000-60,000 chars) alone between two calls, intercept ${Math.round(fit?.rest)} tokens, plain median ratio ${fit?.ratio.toFixed(2)}; hook ${HOOK_CHARS} chars = ${HOOK_TOKENS} tokens`);
  p.log(`fresh start today ${F_FIRST}; with the put-back F = ${F} tokens (cache read ${F_READ}, written ${F - F_READ}); summary output charged ${SUMMARY} tokens per compaction`);
  p.log(`re-reading after a real compaction, growth over 20 calls beyond the session's mean: median ${k(median(reread) || 0)} (n ${reread.length}; not charged)`);
  p.log(`actual weight ${(actual / 1e6).toFixed(1)}M; today replayed ${(today.W / 1e6).toFixed(1)}M (${((today.W / actual - 1) * 100).toFixed(1)}%)`);
  p.log(`measured: the transcripts' weight against today replayed ${((actual / today.W - 1) * 100).toFixed(1)}% with ${reals.filter((r) => r.handover).length} handover compactions`);
  p.log('\n| candidate | autoCompactWindow | sessions (handing over) | compactions | mean context | weight | against today |');
  p.log('|---|---|---|---|---|---|---|');
  for (const t of totals) {
    p.log(`| ${t.H ? k(t.H) : 'today (467k)'} | ${(t.H ? t.H + OFFSET : MID_WINDOW).toLocaleString('en-GB')} | ${sessions.length} (${t.handed}) | ${t.comps} | ${k(t.mean)} | ${(t.W / 1e6).toFixed(1)}M | ${t.H ? ((t.W / today.W - 1) * 100).toFixed(1) + '%' : ''} |`);
  }
  p.log(`\ninteractive only, today ${(today.Wi / 1e6).toFixed(1)}M; best ${best.name} ${(best.Wi / 1e6).toFixed(1)}M (${((best.Wi / today.Wi - 1) * 100).toFixed(1)}%)`);
  p.log(`chosen ${best.name} (${((best.W / today.W - 1) * 100).toFixed(1)}%), runner-up ${second.name} (${((second.W / today.W - 1) * 100).toFixed(1)}%), gap ${((second.W / best.W - 1) * 100).toFixed(2)}%${second.W / best.W - 1 < 0.01 ? ' (within 1%)' : ''}`);
  // How the choice moves when the softest numbers move (candidates only; today keeps its own fresh start).
  const POST = median(reals.map((r) => r.post)), REREAD = Math.max(0, Math.round(median(reread) || 0));
  const variants = [
    ['summary charged at postTokens', F, POST],
    ['fresh start + the measured re-reading', F + REREAD, SUMMARY],
    ['put-back of 60,000 characters', F + HOOK_TOKENS, SUMMARY],
    ['put-back at 3.5 characters per token', F_FIRST + Math.round(HOOK_CHARS / 3.5), SUMMARY],
  ];
  for (const [label, f, summary] of variants) {
    const ws2 = [];
    for (const H of CANDIDATES) {
      let W = 0;
      for (const s of sessions) W += await weightOf(replay(s, H, f, summary).models, prices);
      ws2.push([k(H), W]);
    }
    ws2.sort((a, b) => a[1] - b[1]);
    p.log(`if ${label}: best ${ws2[0][0]} (${((ws2[0][1] / today.W - 1) * 100).toFixed(1)}%), next ${ws2[1][0]} (${((ws2[1][1] / today.W - 1) * 100).toFixed(1)}%)`);
  }
  p.log(`tsv ${TSV}`);
  return p.text();
}

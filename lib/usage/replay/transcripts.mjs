// The handover's replay, part 2: what each chosen session's transcript adds to its calls (entrypoint, real compactions,
// the summary's length, characters per token) and the steps timed to the second.
import { readTranscript, transcriptsOf } from '../calls.mjs';
import { FALLBACK_CPT, HOOK_CHARS, median } from './read.mjs';

// `projects` is the transcripts' folder, `bySession` read.mjs's, `skipped` the transcripts the week's scan left out.
export async function readTranscripts(projects, bySession, skipped = new Set()) {
  const transcriptOf = new Map();
  for (const f of transcriptsOf(projects)) if (!f.sub) transcriptOf.set(f.session, f.fp);
  const meta = new Map(); // session -> { entry, boundaries: Map(ts -> {...}), kev }
  const cptSamples = [];
  for (const id of bySession.keys()) {
    const fp = transcriptOf.get(id);
    const info = { entry: null, boundaries: new Map(), kev: [] };
    meta.set(id, info);
    if (!fp || skipped.has(fp)) continue;
    let last = null, prev = null, between = null;
    const outOf = new Map(), cmdOf = new Map(), kOf = new Map();
    await readTranscript(fp, (line) => {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      if (!info.entry && r.entrypoint) info.entry = r.entrypoint;
      if (r.type === 'system' && r.subtype === 'compact_boundary') {
        const c = r.compactMetadata || {};
        last = { trigger: c.trigger, pre: c.preTokens, post: c.postTokens, ms: c.durationMs, summaryChars: null };
        info.boundaries.set(r.timestamp, last);
        between = null;
        return;
      }
      if (r.type === 'user' && r.isCompactSummary && last) {
        const c = r.message?.content;
        last.summaryChars = typeof c === 'string' ? c.length : (c || []).reduce((s, b) => s + (b.text?.length || 0), 0);
        return;
      }
      if (r.type === 'assistant' && r.message?.usage) {
        const m = r.message, id2 = m.id || r.requestId, u = m.usage;
        outOf.set(id2, Math.max(outOf.get(id2) || 0, u.output_tokens || 0));
        for (const b of m.content || []) {
          if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
          const cmd = String(b.input?.command || '');
          cmdOf.set(b.id, cmd);
          const ks = [...cmd.matchAll(/\bk step (start|finish|fail)\s+\S+\s+(S-\d+[a-z]?)\b/g)].map((x) => ({ verb: x[1], step: x[2] }));
          if (ks.length) kOf.set(b.id, ks);
        }
        if (prev && prev.id === id2) return;
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (prev && between && !between.taint && between.n === 1 && between.chars >= 4000) {
          const o = outOf.get(prev.id) || 0, delta = ctx - prev.ctx - o;
          if (delta > 0 && o <= delta) cptSamples.push([between.chars, delta]);
        }
        prev = { id: id2, ctx }; between = { n: 0, chars: 0, taint: false };
        return;
      }
      if (r.type === 'user' && Array.isArray(r.message?.content)) {
        for (const b of r.message.content) for (const e of (b.type === 'tool_result' && kOf.get(b.tool_use_id)) || []) info.kev.push({ ...e, t: Date.parse(r.timestamp) });
      }
      if (!between) return;
      if (r.type === 'user') {
        const c = r.message?.content;
        if (!Array.isArray(c)) { between.taint = true; return; }
        for (const b of c) {
          if (b.type !== 'tool_result') { between.taint = true; continue; }
          between.n++;
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
          between.chars += text.length;
          if (!/\.md\b/.test(cmdOf.get(b.tool_use_id) || '')) between.taint = true;
        }
      }
    });
  }
  // The step lines have minute resolution; `k step start|finish|fail` run by the session itself gives the second.
  let refined = 0, unrefined = 0;
  for (const [id, ivs] of bySession) {
    const kev = meta.get(id)?.kev || [];
    const near = (verbs, step, t) => kev.filter((e) => verbs.includes(e.verb) && e.step === step && e.t >= t - 60000 && e.t < t + 120000)
      .sort((a, b) => Math.abs(a.t - t - 30000) - Math.abs(b.t - t - 30000))[0];
    for (const iv of ivs) {
      const a = near(['start'], iv.step, iv.start);
      if (a) iv.start = a.t;
      const b = iv.endMinute != null && near(['finish', 'fail'], iv.step, iv.endMinute);
      if (b) iv.end = b.t;
      if (a && (iv.endMinute == null || b)) refined++; else unrefined++;
    }
  }
  // Each sample's delta is the result's tokens plus whatever else entered between the calls (reminders, the tool_use),
  // so the characters per token are the slope of a least-squares line, not a plain ratio; its intercept is that rest.
  const fit = (() => {
    const xs = cptSamples.filter(([c]) => c <= 60000), n = xs.length;
    if (n < 10) return null;
    const mx = xs.reduce((s, [c]) => s + c, 0) / n, my = xs.reduce((s, [, d]) => s + d, 0) / n;
    const b = xs.reduce((s, [c, d]) => s + (c - mx) * (d - my), 0) / xs.reduce((s, [c]) => s + (c - mx) ** 2, 0);
    return { n, cpt: 1 / b, rest: my - b * mx, ratio: median(xs.map(([c, d]) => c / d)) };
  })();
  const CPT = fit && fit.cpt > 1.5 && fit.cpt < 6 ? fit.cpt : FALLBACK_CPT;
  return { meta, refined, unrefined, fit, CPT, HOOK_TOKENS: Math.round(HOOK_CHARS / CPT) };
}

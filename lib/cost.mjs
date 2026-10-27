import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { big, interactiveText, tokens, usd } from './cost-md.mjs';
import { kirunakHome } from './home.mjs';
import { taskPaths } from './workspace.mjs';

// Token records (orchestrator.md §6, R12). Every run record under steps/<step>/ (run-<k>.json, keep-<k>.json) is the
// runner's JSON result; its weight, with the `prices` seam, is
//   Σ_model w.input × input + w.write5m × cw5m + w.write1h × cw1h + w.cacheRead × cr + w.output × out,
// in units of one base input token of the reference model.

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const parseLine = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// The documented fields of a result, named once. The per-model breakdown is `model_usage` or `modelUsage`, its
// fields snake or camel case. A model's cache writes not split by lifetime are split as the result's `usage` splits
// them, else counted as 1-hour writes.
export function runFields(rec) {
  const u = rec.usage || {};
  const cc = u.cache_creation || {};
  const usage = {
    input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens), write5m: n(cc.ephemeral_5m_input_tokens), write1h: n(cc.ephemeral_1h_input_tokens),
  };
  const split = usage.write5m + usage.write1h;
  const models = Object.entries(rec.model_usage || rec.modelUsage || {}).map(([model, m]) => {
    const write = n(m.cache_creation_input_tokens ?? m.cacheCreationInputTokens);
    const c = m.cache_creation || {};
    let write5m = c.ephemeral_5m_input_tokens;
    let write1h = c.ephemeral_1h_input_tokens;
    if (write5m == null && write1h == null) {
      write5m = split ? Math.round((write * usage.write5m) / split) : 0;
      write1h = write - write5m;
    }
    return {
      model, input: n(m.input_tokens ?? m.inputTokens), output: n(m.output_tokens ?? m.outputTokens),
      cacheRead: n(m.cache_read_input_tokens ?? m.cacheReadInputTokens), write5m: n(write5m), write1h: n(write1h),
    };
  });
  return { sessionId: rec.session_id ?? null, turns: n(rec.num_turns), isError: !!rec.is_error, subtype: rec.subtype ?? null, costUsd: n(rec.total_cost_usd), usage, models };
}

export async function weightOf(models, prices) {
  let total = 0;
  for (const m of models) {
    const w = await prices.weights(m.model);
    total += w.input * m.input + w.write5m * m.write5m + w.write1h * m.write1h + w.cacheRead * m.cacheRead + w.output * m.output;
  }
  return total;
}

const stepOrder = (a, b) => {
  const [x, y] = [a, b].map((s) => /^S-(\d+)$/.exec(s));
  return x && y ? Number(x[1]) - Number(y[1]) : x ? -1 : y ? 1 : a.localeCompare(b);
};

// Every run record of the task that holds a result: [{ step, file, kind: 'run' | 'keep', k, run: runFields(...) }]. A
// run record written before its run, whose run never gave a result (`kirunak.result` false), counts no run.
export function records(taskDir) {
  const dir = join(taskDir, 'steps');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const step of readdirSync(dir).filter((s) => /^S-/.test(s)).sort(stepOrder)) {
    for (const file of readdirSync(join(dir, step))) {
      const m = /^(run|keep)-(\d+)\.json$/.exec(file);
      const rec = m && readJson(join(dir, step, file));
      if (rec && rec.kirunak?.result !== false) out.push({ step, file, kind: m[1], k: Number(m[2]), run: runFields(rec) });
    }
  }
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p90(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

// A run's calls, each at the run's mean context: the result has totals, not one figure per call.
const contextsOf = (run) => (run.turns ? Array(run.turns).fill((run.usage.input + run.usage.cacheWrite + run.usage.cacheRead) / run.turns) : []);

// A resumed conversation's result reports its whole spend, earlier runs included (cost-tracking.md), so weight and
// money count each conversation once, at its latest record; calls and contexts count every run.
async function fold(recs, prices) {
  const latest = new Map();
  for (const r of recs) {
    const key = r.run.sessionId || `${r.step}/${r.file}`;
    const cur = latest.get(key);
    if (!cur || r.run.costUsd > cur.run.costUsd || (r.run.costUsd === cur.run.costUsd && r.k > cur.k)) latest.set(key, r);
  }
  let weight = 0;
  let usd = 0;
  for (const r of latest.values()) {
    weight += await weightOf(r.run.models, prices);
    usd += r.run.costUsd;
  }
  const contexts = recs.flatMap((r) => contextsOf(r.run));
  return { weight, usd, calls: recs.reduce((s, r) => s + r.run.turns, 0), contexts, runs: recs.length, sessions: [...latest.keys()] };
}

const jsonLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').map(parseLine).filter(Boolean) : []);

// costOf(ws, id) → { id, repo, steps: [...], total, keeper: { keepalives, misses, hits }, interactive, days }
export async function costOf(ws, id) {
  const p = taskPaths(ws, id);
  const home = ws.home || kirunakHome();
  const all = records(p.dir);
  const steps = [];
  for (const step of [...new Set(all.map((r) => r.step))]) {
    const f = await fold(all.filter((r) => r.step === step), ws.seams.prices);
    steps.push({ step, ...f, medianContext: median(f.contexts) });
  }
  const total = await fold(all, ws.seams.prices);
  const sessions = new Set(total.sessions);
  const keeper = { keepalives: 0, misses: 0, hits: 0 };
  for (const e of jsonLines(join(home, 'keeper.jsonl'))) {
    if (!sessions.has(e.session) && e.task !== id) continue;
    if (e.kind === 'keepalive') keeper.keepalives++;
    else if (e.kind === 'miss') keeper.misses++;
    else if (e.kind === 'hit') keeper.hits++;
  }
  // `tracked` counts the sessions whose file holds a cost, which only the status line's tracker writes.
  const interactive = { sessions: 0, usd: 0, tracked: 0 };
  const sdir = join(home, 'sessions');
  for (const f of existsSync(sdir) ? readdirSync(sdir).filter((x) => x.endsWith('.json')) : []) {
    const s = readJson(join(sdir, f));
    if (s?.task !== id || s.kind === 'headless') continue;
    interactive.sessions++;
    if (Number.isFinite(s.cost?.total_cost_usd)) interactive.tracked++;
    interactive.usd += n(s.cost?.total_cost_usd);
  }
  const progress = existsSync(join(p.dir, 'progress.md')) ? readFileSync(join(p.dir, 'progress.md'), 'utf8') : '';
  const days = new Set(progress.split('\n').map((l) => /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} S-\S+ /.exec(l)?.[1]).filter(Boolean)).size;
  return { id, repo: p.repo, steps, total: { ...total, medianContext: median(total.contexts), p90Context: p90(total.contexts) }, keeper, interactive, days };
}

const pct = (x) => `${Math.round(x * 100)}%`;

// The task's own numbers, per step and in total.
export function format(c) {
  const t = c.total;
  const out = [`${c.id}: weight ${big(t.weight)}, ${usd(t.usd)} USD, ${t.calls} calls, median context ${tokens(t.medianContext)}`];
  for (const s of c.steps) {
    out.push(`  ${s.step.padEnd(6)} weight ${big(s.weight).padStart(8)}  ${usd(s.usd).padStart(6)} USD  ${String(s.calls).padStart(4)} calls  ${s.runs} runs  median context ${tokens(s.medianContext)}`);
  }
  if (!c.steps.length) out.push('  no run record yet');
  out.push(`  keep-alives ${c.keeper.keepalives}, misses ${c.keeper.misses}`);
  if (c.interactive.sessions) out.push(`  interactive sessions ${interactiveText(c.interactive)}`);
  return out.join('\n');
}

// done.json's `cost` (k accept, orchestrator.md §6): the numbers k cost prints (tokens to whole numbers, USD to four
// places) and the baseline's comparisons; cost.md is rendered from these alone (cost-md.mjs), so a later change of
// prices or baseline never changes it, and the run records can stay out of git.
export function summary(c, comparisons = []) {
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const nums = (x) => ({ weight: Math.round(x.weight), usd: r4(x.usd), calls: x.calls, runs: x.runs, medianContext: x.medianContext == null ? null : Math.round(x.medianContext) });
  return {
    steps: c.steps.map((x) => ({ step: x.step, ...nums(x) })),
    total: nums(c.total),
    keeper: { keepalives: c.keeper.keepalives, misses: c.keeper.misses },
    interactive: { sessions: c.interactive.sessions, usd: r4(c.interactive.usd), tracked: c.interactive.tracked },
    comparisons,
  };
}

// Only the comparisons the baseline and the task both have numbers for (orchestrator.md §6).
export function compare(c, b) {
  const out = [];
  const t = c.total;
  const cpc = b.contextPerCall || {};
  if (t.calls && (cpc.median != null || cpc.p90 != null)) {
    const parts = [];
    if (cpc.median != null) parts.push(`median ${tokens(t.medianContext)} against ${tokens(cpc.median)}`);
    if (cpc.p90 != null) parts.push(`p90 ${tokens(t.p90Context)} against ${tokens(cpc.p90)}`);
    out.push(`context per call: ${parts.join(', ')}`);
  }
  if (t.calls && b.over?.threshold != null && b.over?.share != null) {
    const share = t.contexts.filter((x) => x > b.over.threshold).length / t.contexts.length;
    out.push(`calls over ${tokens(b.over.threshold)}: ${pct(share)} against ${pct(b.over.share)}`);
  }
  const perDay = b.weightPerRepoDay?.[c.repo];
  if (perDay != null && c.days && t.weight) {
    out.push(`weight: ${big(t.weight)} over ${c.days} working day${c.days > 1 ? 's' : ''} against ${big(perDay * c.days)} (${c.repo}, ${big(perDay)} a day)`);
  }
  const resumes = c.keeper.misses + c.keeper.hits;
  if (resumes && b.missRate != null) {
    out.push(`misses: ${c.keeper.misses} of ${resumes} resumes (${pct(c.keeper.misses / resumes)}) against a miss rate of ${pct(b.missRate)}; keep-alives ${c.keeper.keepalives}`);
  }
  return out;
}

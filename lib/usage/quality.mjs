// quality.txt and quality.tsv: the handover's quality numbers for one limit week (gulnya/fresh-session-per-step AC-9,
// design §10 R10.1, R10.2).
// Main sessions working kirunak tasks (a progress.md step line names them): their calls and average context per call,
// interactive and headless apart, and their compactions; their agents', and the agents' in the repos that hand over
// (they inherit the handover's window; fable-step and music-deep keep 500000, so they stand apart). Per task with a step
// finished in the week: the reviews dated in the week and their findings, and the fix commits. The summary lines stand
// beside the baseline's (usage.baseline, an earlier week's quality.tsv), and the rows are written as TSV.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { printer } from './common.mjs';
import { entryOf, findingsOf, isFix, readTasks, resolver } from './tasks.mjs';

const COLS = ['scope', 'name', 'sessions', 'calls', 'avg_ctx', 'compactions', 'reviews', 'not_met', 'needs_owner', 'findings', 'B', 'S', 'N', 'fix_commits'];
const FABLE = /^(fable-step|music-deep)$/;

const git = (dir, args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const added = (dir, rel) => Number(git(dir, ['log', '--all', '--diff-filter=A', '--format=%ct', '--', rel]).trim().split('\n').pop()) * 1000 || null;

function reviewsOf(t) {
  const seen = new Map();
  for (const dir of t.dirs) {
    const rels = readdirSync(dir).filter((f) => /^review.*\.md$/.test(f));
    const sd = join(dir, 'steps');
    if (existsSync(sd)) {
      for (const s of readdirSync(sd)) {
        const at = join(sd, s);
        for (const f of existsSync(at) && statSync(at).isDirectory() ? readdirSync(at) : []) if (/^review.*\.md$/.test(f)) rels.push(`steps/${s}/${f}`);
      }
    }
    for (const rel of rels) {
      if (seen.has(rel)) continue;
      const fp = join(dir, rel);
      seen.set(rel, { rel, at: added(dir, rel) ?? statSync(fp).mtimeMs, ...findingsOf(readFileSync(fp, 'utf8')) });
    }
  }
  return [...seen.values()];
}

// Every commit of the handover's repos in the week (worktrees share their repo's history), with its files.
function commitsOf(roots, FROM, TO) {
  const commits = new Map();
  for (const r of roots.all) {
    if (!existsSync(join(r.path, '.git'))) continue;
    for (const ch of git(r.path, ['log', '--all', `--since=${FROM}`, `--until=${TO}`, '--format=@@%H%x09%ct%x09%s', '--name-only']).split('@@').slice(1)) {
      const [head, ...files] = ch.split('\n');
      const [h, ct, subject] = head.split('\t');
      if (!commits.has(h)) commits.set(h, { root: r.base, at: Number(ct) * 1000, subject, files: files.filter(Boolean) });
    }
  }
  return commits;
}

// The baseline's label: the week its rows were measured in, named by the Monday it holds, read from the first instant
// its header names (the generating command's --from).
export function baselineLabel(text) {
  const m = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec((text.split('\n').find((l) => l.startsWith('#')) || ''));
  if (!m) return 'baseline';
  const d = new Date(`${m[0].slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return `week of ${d.toISOString().slice(0, 10)}`;
}

// `rows` are calls.jsonl's rows; `roots` is rootsOf(ws); `projects` the transcripts' folder (each session's entrypoint);
// `skipped` the transcripts left out. Writes `tsv` when given; returns the summary lines' text.
export function quality({ rows, from: FROM, to: TO, roots, projects, skipped = new Set(), tasks = readTasks(roots), tsv = null, baseline = null }) {
  const t0 = Date.parse(FROM), t1 = Date.parse(TO);
  rows = rows.filter((r) => r.ts >= FROM && r.ts < TO);
  const calls = rows.filter((r) => r.kind === 'call' && r.model !== '<synthetic>');
  const ctx = (c) => c.inp + c.cw5 + c.cw1h + c.cr;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, c) => s + ctx(c), 0) / xs.length) : 0);
  const commits = commitsOf(roots, FROM, TO);

  const mains = new Set(calls.filter((c) => !c.sub).map((c) => c.session)), resolve = resolver(mains);
  const all = [...tasks.values()];
  const kSessions = new Set(all.flatMap((t) => t.steps.map((s) => resolve(s.named)).filter(Boolean)));
  const entry = new Map([...kSessions].map((s) => [s, entryOf(projects, s, skipped)]));
  const of = (set) => calls.filter((c) => !c.sub && set.has(c.session));
  const agents = (xs) => new Set(xs.map((c) => `${c.session}/${c.sub}`)).size;
  const out = [];
  // Compactions of main sessions; calls.jsonl before 2026-10-26 wrote a row for the boundary and one for the summary.
  const compactions = (set) => rows.filter((r) => r.kind === 'compact' && !r.sub && set.has(r.session)).sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .filter((r, i, a) => !a.slice(0, i).some((p) => p.session === r.session && Date.parse(r.ts) - Date.parse(p.ts) < 120000)).length;
  const main = (name, set) => {
    const xs = of(set);
    out.push({ scope: 'main', name, sessions: new Set(xs.map((c) => c.session)).size, calls: xs.length, avg_ctx: avg(xs), compactions: compactions(set) });
  };
  main('kirunak sessions', kSessions);
  main('interactive', new Set([...kSessions].filter((s) => entry.get(s) === 'cli')));
  main('headless', new Set([...kSessions].filter((s) => entry.get(s) !== 'cli')));
  for (const [name, xs] of [
    ['of kirunak sessions', calls.filter((c) => c.sub && kSessions.has(c.session))],
    ['in the handover repos', calls.filter((c) => c.sub && roots.inRoots(c.proj) && !FABLE.test(c.agentType || ''))],
    ['fable-step and music-deep', calls.filter((c) => c.sub && FABLE.test(c.agentType || ''))],
  ]) out.push({ scope: 'agents', name, sessions: agents(xs), calls: xs.length, avg_ctx: avg(xs) });
  for (const t of all.filter((t) => t.steps.some((s) => s.finished >= t0 && s.finished < t1)).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const set = new Set(t.steps.map((s) => resolve(s.named)).filter(Boolean)), xs = of(set);
    // Rework: the fixes after the task's own review (a top-level review*.md, the [review] step's), whose commits are records.
    const rv = reviewsOf(t), first = Math.min(...rv.filter((r) => !r.rel.includes('/')).map((r) => r.at)), rs = rv.filter((r) => r.at >= t0 && r.at < t1);
    const sum = (k) => rs.reduce((s, r) => s + r[k], 0);
    out.push({ scope: 'task', name: t.id, sessions: new Set(xs.map((c) => c.session)).size, calls: xs.length, avg_ctx: avg(xs), compactions: '',
      reviews: rs.length, not_met: sum('notMet'), needs_owner: sum('needsOwner'), findings: sum('findings'), B: sum('B'), S: sum('S'), N: sum('N'),
      fix_commits: [...commits.values()].filter((c) => c.at > first && c.at >= t0 && c.at < t1 && isFix(t, c)).length });
  }
  const ts = out.filter((r) => r.scope === 'task');
  const tot = Object.fromEntries(['reviews', 'not_met', 'needs_owner', 'findings', 'B', 'S', 'N', 'fix_commits'].map((k) => [k, ts.reduce((s, r) => s + r[k], 0)]));
  out.push({ scope: 'tasks', name: `${ts.length} tasks`, sessions: '', calls: '', avg_ctx: '', compactions: '', ...tot });
  if (tsv) {
    writeFileSync(tsv, [`# generated by k usage --from ${FROM} --to ${TO} (gulnya/k-usage, from gulnya/fresh-session-per-step AC-9); never edited by hand`,
      COLS.join('\t'), ...out.map((r) => COLS.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n');
  }

  // The summary lines, each beside the baseline's row of the same name.
  let bl = [], label = 'baseline';
  if (baseline && existsSync(baseline)) {
    const text = readFileSync(baseline, 'utf8');
    label = baselineLabel(text);
    bl = text.split('\n').filter((l) => l && !l.startsWith('#')).slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [COLS[i], v])));
  }
  const k = (n) => `${Math.round(Number(n) / 1000)}k`;
  const line = (r) => r.scope === 'tasks'
    ? `${r.name}: reviews ${r.reviews} (not met ${r.not_met}, needs owner ${r.needs_owner}, findings ${r.findings}, B/S/N ${r.B}/${r.S}/${r.N}), fix commits ${r.fix_commits}; per task ${(r.findings / (parseInt(r.name, 10) || 1)).toFixed(1)} findings, ${(r.fix_commits / (parseInt(r.name, 10) || 1)).toFixed(1)} fix commits`
    : `${r.scope} ${r.name}: ${r.sessions} ${r.scope === 'agents' ? 'agents' : 'sessions'}, ${r.calls} calls, avg context ${k(r.avg_ctx)}${r.compactions !== '' && r.compactions != null ? `, compactions ${r.compactions}` : ''}`;
  const p = printer();
  for (const r of out.filter((r) => r.scope !== 'task')) {
    const b = bl.find((x) => x.scope === r.scope && (x.name === r.name || r.scope === 'tasks'));
    p.log(line(r) + (b ? `  | ${label}: ${line(b).replace(/^[^:]*: /, '')}` : ''));
  }
  return p.text();
}

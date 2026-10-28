// k usage (gulnya/k-usage): the weekly usage review's numbers for one limit week, from every Claude Code transcript on
// this machine (<config dir>/projects), the workspace's repos and kirunak's own logs. Writes calls.jsonl, report.txt,
// ttl.txt, carry.txt, writes.txt, escalations.txt, quality.txt (and .tsv), compact.txt, replay.txt (and .tsv),
// summary.txt and tasks.txt (and .tsv) into `out`, and returns the summary the review starts from with the week's
// weight per task and step after it (gulnya/k-usage AC-2). Every part runs in this process.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDirOf } from '../compact.mjs';
import { scanCalls } from './calls.mjs';
import { byTask } from './bytask.mjs';
import { carry } from './carry.mjs';
import { mult } from './common.mjs';
import { compactLog } from './compactlog.mjs';
import { escalations } from './escalations.mjs';
import { quality } from './quality.mjs';
import { replayWeek } from './replay/replay.mjs';
import { report } from './report.mjs';
import { readTasks, rootsOf } from './tasks.mjs';
import { ttl } from './ttl.mjs';
import { writes } from './writes.mjs';

const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// The limit's own clock, from the statusline's log (a line per reading: time, week %, 5-hour %, label, tab-separated):
// when the week reached 100%, and how far it rose while no transcript moved.
function limitLine(log, FROM, TO, xs) {
  if (!existsSync(log)) return `weekly limit: no ${tilde(log)} yet (the statusline writes it)`;
  const rl = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('\t')).filter(([t]) => t >= FROM && t < TO);
  const full = rl.find(([, wk]) => Number(wk) >= 100);
  const times = xs.map((c) => Date.parse(c.ts)).sort((a, b) => a - b);
  const quiet = (t0, t1) => {
    let lo = 0, hi = times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t0) lo = m + 1; else hi = m; }
    return !(times[lo] <= t1);
  };
  let silent = 0;
  for (let i = 1; i < rl.length; i++) if (Number(rl[i][1]) > Number(rl[i - 1][1]) && quiet(Date.parse(rl[i - 1][0]), Date.parse(rl[i][0]))) silent += Number(rl[i][1]) - Number(rl[i - 1][1]);
  return rl.length ? `weekly limit: ${full ? 'reached 100% at ' + full[0] : 'peaked at ' + Math.max(...rl.map((r) => Number(r[1]))) + '%'}; ${silent} points rose with no local call (claude.ai, cloud, another machine)` : 'weekly limit: no statusline log lines in this week';
}

// `from` and `to` are ISO instants (the week [from, to)); `projects` the transcripts' folder.
export async function runUsage(ws, { from: FROM, to: TO, out: OUT, projects = join(configDirOf(), 'projects') }) {
  mkdirSync(OUT, { recursive: true });
  const roots = rootsOf(ws);
  // A project folder is named after its cwd; the roots' parent folder is dropped from it (`-Users-me-sources-katyafm` is katyafm).
  const prefixes = roots.parents.map((p) => `${p.replace(/[^a-zA-Z0-9]/g, '-')}-`);
  const { lines, skipped } = await scanCalls(projects, Date.parse(FROM), { prefixes });
  const kept = lines.filter((l) => { const t = JSON.parse(l).ts; return t >= FROM && t < TO; });
  writeFileSync(join(OUT, 'calls.jsonl'), kept.join('\n') + '\n');
  const rows = () => kept.map((l) => JSON.parse(l)); // each part its own copy: some mark the rows they read
  const put = (f, text) => writeFileSync(join(OUT, f), text);

  put('report.txt', report(rows()));
  put('ttl.txt', ttl(rows()));
  put('carry.txt', await carry(projects, FROM, TO, skipped.files));
  put('writes.txt', writes(rows()));
  put('escalations.txt', escalations(ws.home, FROM, TO));
  // The handover (gulnya/fresh-session-per-step AC-9): kirunak main sessions and each task's quality beside the
  // baseline's week (usage.baseline), compact.log's counts, and S-2's replay over this week (its `measured:` line).
  const tasks = readTasks(roots);
  put('quality.txt', quality({ rows: rows(), from: FROM, to: TO, roots, projects, skipped: skipped.files, tasks, tsv: join(OUT, 'quality.tsv'), baseline: ws.usage.baseline }));
  put('compact.txt', compactLog(ws.home, FROM, TO, roots, { tasks }));
  try {
    put('replay.txt', await replayWeek({ rows: rows(), tasks, from: FROM, to: TO, projects, skipped: skipped.files, home: ws.home, prices: ws.seams.prices, tsv: join(OUT, 'replay.tsv') }));
  } catch (e) {
    put('replay.txt', `measured: the replay failed (${String(e.message).split('\n')[0]})\n`);
  }

  const xs = rows().filter((c) => c.kind === 'call' && c.model !== '<synthetic>');
  const sum = (a, f) => a.reduce((s, c) => s + f(c), 0), ctx = (c) => c.inp + c.cw5 + c.cw1h + c.cr;
  const w = (c) => mult(c.model) * (c.inp + 1.25 * c.cw5 + 2 * c.cw1h + 0.1 * c.cr + 5 * c.out);
  const main = xs.filter((c) => !c.sub), sub = xs.filter((c) => c.sub);
  const summary = [
    `limit week ${FROM} .. ${TO}  →  ${OUT}`,
    `calls ${xs.length} (main ${main.length}, agents ${sub.length}), weight ${(sum(xs, w) / 1e6).toFixed(0)}M Opus-input tokens`,
    `cache read : output ${(sum(xs, (c) => c.cr) / sum(xs, (c) => c.out)).toFixed(0)}:1, avg context per call main ${(sum(main, ctx) / main.length / 1e3).toFixed(0)}k, agents ${(sum(sub, ctx) / sub.length / 1e3).toFixed(0)}k`,
    // E-1: a transcript cut short or unreadable is left out whole and counted.
    `transcripts skipped: ${skipped.cut + skipped.unreadable} (cut short ${skipped.cut}, unreadable ${skipped.unreadable})`,
    limitLine(ws.usage.limitsLog, FROM, TO, xs),
  ];
  const txt = (f) => readFileSync(join(OUT, f), 'utf8').trim().split('\n');
  const ttlLines = readFileSync(join(OUT, 'ttl.txt'), 'utf8').split('\n').filter((l) => /^(main|sub) actual/.test(l));
  // The escalations per trigger (gulnya/enforced-escalation AC-22): k run's climbs and rung runs, the hook's fires and blocks.
  const esc = txt('escalations.txt').map((l) => `escalations: ${l}`);
  const hand = [...txt('quality.txt').map((l) => `kirunak: ${l}`), ...txt('compact.txt').map((l) => `compact.log: ${l}`),
    ...txt('replay.txt').filter((l) => /^measured:/.test(l)).map((l) => `handover ${l}`)];
  const all = [...summary, ...ttlLines, ...esc, ...hand].join('\n');
  writeFileSync(join(OUT, 'summary.txt'), all + '\n');
  // Each task's and step's share of the weight above (gulnya/k-usage AC-2, D-3): the same calls, joined to the steps.
  const bt = byTask({ rows: rows(), tasks, home: ws.home, from: FROM, to: TO, tsv: join(OUT, 'tasks.tsv') });
  put('tasks.txt', bt.text);
  // Where the weekly reviews are kept (usage.reviews, gulnya/k-usage AC-6), printed only: the usage-review skill reads it.
  const reviews = `reviews: ${ws.usage.reviews ?? `none named (usage.reviews in ${ws.modulePath})`}`;
  return { from: FROM, to: TO, out: OUT, reviews: ws.usage.reviews, skipped: { cut: skipped.cut, unreadable: skipped.unreadable },
    text: `${all}\n\n${bt.text.trimEnd()}\n\n${reviews}` };
}

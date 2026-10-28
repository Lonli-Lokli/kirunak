// compact.txt: the handover's own counts for one limit week (gulnya/fresh-session-per-step AC-9, design §10 R10.3, §12's
// S-9 line), from $KIRUNAK_HOME/compact.log, kirunak's PreCompact, SessionStart and SessionEnd hooks' log: a PreCompact
// line carries `decision` (allow or block), `row` and `why` (R4's table); the other two carry `event`. It counts the
// fires let through per `why`, the blocks, the fires put down to an agent, the user's window inside and outside the
// handover's repos, the spells a session was held to its step boundary and how each ended, the boundaries no compaction
// came at (a step finished and the next started with nothing let through: S-7 N-2), and what SessionStart put back.
import { join } from 'node:path';
import { jsonLines, printer } from './common.mjs';
import { readTasks, resolver } from './tasks.mjs';

const ENDS = new Set(['boundary', 'boundary passed', 'limit', 'manual']); // the main's allows: a spell held at a boundary ends
const tally = (xs, key) => xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] || 0) + 1 }), {});
const list = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

// `lines` are the window's log lines in order; `stepsOf(session)` the session's steps as { start, end, finished } in ms;
// `inRoots(cwd)` whether a folder is in the handover's repos (rootsOf(ws).inRoots).
export function summarise(lines, stepsOf = () => [], inRoots = () => false) {
  const fires = lines.filter((l) => !l.event), allow = fires.filter((l) => l.decision === 'allow'), block = fires.filter((l) => l.decision === 'block');
  const agent = fires.filter((l) => l.row === 'R4.5'), user = fires.filter((l) => l.why === "user's window");
  const outside = fires.filter((l) => l.cwd && !inRoots(l.cwd));
  const out = [
    `fires ${fires.length}: let through ${allow.length} (${list(tally(allow, (l) => l.why))}); blocked ${block.length} (${list(tally(block, (l) => l.why))})`,
    `put down to an agent ${agent.length} in ${new Set(agent.map((l) => l.session)).size} sessions (${list(tally(agent, (l) => l.why))}); ctx unknown ${fires.filter((l) => l.why === 'ctx unknown').length}, state unreadable ${fires.filter((l) => l.why === 'state unreadable').length} (expected 0)`,
    `user's window ${user.length}, inside the handover's repos ${user.filter((l) => l.cwd && inRoots(l.cwd)).length} (expected 0); outside the repos ${outside.length} fires, blocked ${outside.filter((l) => l.decision === 'block').length} (a block there is a bug)`,
  ];
  // Held spells: from a session's first block to the main's next allow, or the window's end.
  const spells = [];
  for (const s of new Set(block.map((l) => l.session))) {
    let cur = null;
    for (const l of fires.filter((x) => x.session === s)) {
      if (l.decision === 'block' && !cur) spells.push(cur = { s, from: Date.parse(l.ts), to: Infinity, blocks: 0, end: 'still held' });
      if (l.decision === 'block') cur.blocks++;
      else if (cur && ENDS.has(l.why)) { cur.to = Date.parse(l.ts); cur.end = l.why; cur = null; }
    }
  }
  let missed = 0, seen = 0;
  for (const sp of spells) {
    const steps = stepsOf(sp.s), lets = allow.filter((l) => l.session === sp.s && ENDS.has(l.why)).map((l) => Date.parse(l.ts));
    for (const iv of steps) {
      const b = iv.finished ?? iv.end;
      if (!(b > sp.from && b < sp.to) || steps.some((o) => o !== iv && o.start <= b && b < o.end)) continue;
      const next = Math.min(...steps.filter((o) => o.start > b).map((o) => o.start));
      seen++;
      if (!lets.some((t) => t >= b && t <= next + 60000)) missed++;
    }
  }
  out.push(`held at a step: ${spells.length} spells in ${new Set(spells.map((x) => x.s)).size} sessions, ${block.length} blocks; ended by ${list(tally(spells, (x) => x.end))}; boundaries inside them ${seen}, with no compaction before the next step started ${missed}`);
  const starts = lines.filter((l) => l.event === 'SessionStart');
  for (const src of [...new Set(starts.map((l) => l.source))].sort()) {
    const xs = starts.filter((l) => l.source === src), put = xs.filter((l) => l.put);
    out.push(`SessionStart ${src}: put back ${put.length} of ${xs.length} (${list(tally(put, (l) => l.why || '-'))}; not: ${list(tally(xs.filter((l) => !l.put), (l) => l.why || '-'))})`);
  }
  out.push(`SessionEnd clear ${lines.filter((l) => l.event === 'SessionEnd').length}, holding a task ${lines.filter((l) => l.event === 'SessionEnd' && l.task).length}`);
  return out;
}

// The window's lines of $KIRUNAK_HOME/compact.log, summarised; `roots` is rootsOf(ws).
export function compactLog(home, FROM, TO, roots, { tasks = readTasks(roots) } = {}) {
  const lines = jsonLines(join(home, 'compact.log')).filter((l) => l.ts >= FROM && l.ts < TO);
  const steps = [...tasks.values()].flatMap((t) => t.steps), resolve = resolver(new Set(lines.map((l) => l.session).filter(Boolean)));
  const p = printer();
  p.log(summarise(lines, (s) => steps.filter((iv) => resolve(iv.named) === s), roots.inRoots).join('\n'));
  return p.text();
}

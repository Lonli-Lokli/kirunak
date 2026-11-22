// The kirunak tasks behind the week's sessions (gulnya/fresh-session-per-step AC-9): every repo's
// kirunak/tasks/*/progress.md, the steps it started and finished, the sessions its step lines name, and what counts
// as a review finding and a fix commit; and the task and step behind each of the week's calls (joinOf, k usage's
// tasks.txt, gulnya/k-usage AC-2).
// Worktree checkouts (`<root>-*` beside a repo, such as gulnya-themes or katyafm-capture) merge with their repo's task,
// and a step runs from its `started` line to its `finished` or `failed` line (to that minute's end) or to the same
// step's next `started`. Step lines are stamped in the machine's own time (lib/steps.mjs), read in `zone`.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { compactOf } from '../compact.mjs';
import { progressText } from '../held.mjs';
import { records } from '../cost.mjs';
import { readSession } from '../keeper.mjs';
import { readLinks } from '../links.mjs';
import { localZone, zoned } from './week.mjs';

// The repos that hand over (k install writes the handover window there): the workspace's and compact.alsoIn, their
// worktrees too. `names` are the roots' folder names, longest first; a root is known by its folder name.
export function rootsOf(ws) {
  const all = [...ws.repos.map((r) => ({ name: r.name, path: r.root })), ...compactOf(ws).alsoIn.map((p) => ({ name: null, path: p }))]
    .map((r) => ({ ...r, base: basename(r.path), parent: dirname(r.path) }))
    .sort((a, b) => b.base.length - a.base.length);
  const rootOf = (dir) => all.find((r) => dir === r.base || dir.startsWith(`${r.base}-`))?.base ?? null;
  // A Claude Code project folder (calls.jsonl's `proj`, its parent folder's prefix gone) or a cwd, in the roots.
  const inRoots = (where) => {
    if (!where.startsWith('/')) return !!rootOf(where);
    return all.some((r) => {
      const first = relative(r.parent, where).split(sep)[0];
      return rootOf(first) === r.base;
    });
  };
  const nameOf = Object.fromEntries(all.filter((r) => r.name).map((r) => [r.base, r.name]));
  // The folders the checkouts sit in, each once, in the roots' order.
  const parents = [...new Set(all.map((r) => r.parent))];
  return { all, names: all.map((r) => r.base), rootOf, inRoots, nameOf, parents };
}

// A step id as plans and step lines write it (lib/plan.mjs, lib/steps.mjs), sub-steps such as S-14-M3 included.
export const RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (S-[A-Za-z0-9-]+) (started|finished|failed)\b(.*)/;

// Each kirunak task folder of the roots' checkouts, in each parent folder's own order: { dir, d, r, slug, progress }.
export function taskFolders(roots) {
  const out = [];
  for (const parent of roots.parents) {
    let ds;
    try {
      ds = readdirSync(parent);
    } catch {
      continue;
    }
    for (const d of ds) {
      const r = roots.rootOf(d);
      if (!r || !roots.all.some((x) => x.base === r && x.parent === parent)) continue;
      const tdir = join(parent, d, 'kirunak/tasks');
      if (!existsSync(tdir)) continue;
      for (const slug of readdirSync(tdir)) {
        const dir = join(tdir, slug), progress = join(dir, 'progress.md');
        if (existsSync(progress)) out.push({ dir, d, r, slug, progress });
      }
    }
  }
  return out;
}

// Each task by its id (`<repo name>/<slug>`): its folders (every checkout's copy), and its steps as intervals
// { task, step, named, start, end, finished, endMinute } where `named` is the session the started line names, or, for
// a line that names none while the step is open, the open interval's.
export function readTasks(roots, { zone = localZone() } = {}) {
  const tasks = new Map();
  for (const { dir, d, r, slug, progress } of taskFolders(roots)) {
    const id = `${roots.nameOf[r] || r}/${slug}`;
    if (!tasks.has(id)) tasks.set(id, { id, slug, root: r, dirs: [], lines: new Set(), steps: [] });
    const t = tasks.get(id);
    if (d === r) t.dirs.unshift(dir); else t.dirs.push(dir); // the repo's own checkout first
    for (const l of (progressText(dir) ?? '').split('\n')) t.lines.add(l);
  }
  for (const t of tasks.values()) t.steps = stepsOf(t.id, t.lines, zone);
  return tasks;
}

export function stepsOf(task, lines, zone = localZone()) {
  const evs = [];
  for (const l of lines) {
    const m = RE.exec(l);
    if (!m) continue;
    const named = m[4] === 'started' ? (/session ([^)\s,]+)/.exec(m[5]) || [])[1] || null : null;
    evs.push({ t: zoned(m[1], m[2], zone), step: m[3], verb: m[4], named });
  }
  evs.sort((a, b) => a.t - b.t); // stable: lines of one minute keep the file's order (started, then finished)
  const open = new Map(), out = [];
  for (const e of evs) {
    const cur = open.get(e.step);
    if (e.verb === 'started') {
      if (cur) cur.end = e.t;
      // A step started again for its agent ("started (agent, opus)") names no session: the open interval's session
      // goes on running it, so its calls and the agents it starts stay the step's (gulnya/step-started-for-agent).
      const iv = { task, step: e.step, named: e.named ?? cur?.named ?? null, start: e.t, end: Infinity, finished: null };
      out.push(iv); open.set(e.step, iv);
    } else if (cur) {
      // To the minute's end; endMinute is the line's own minute, which the replay refines to the second.
      cur.end = e.t + 60000; cur.endMinute = e.t;
      if (e.verb === 'finished') cur.finished = e.t;
      open.delete(e.step);
    }
  }
  return out;
}

// A step line's session is a full id, a short one, or a name ending in one (katyafm-settings-fc223c79).
export function resolver(ids) {
  const all = [...ids];
  return (n) => {
    if (!n) return null;
    if (ids.has(n)) return n;
    const hex = (n.match(/[0-9a-f]{8}/g) || []).pop();
    const hits = hex ? all.filter((s) => s.startsWith(hex)) : [];
    return hits.length === 1 ? hits[0] : null;
  };
}

// The sessions' live files that name a task (<home>/sessions/<id>.json): k start's link { task, step: null, since }
// (lib/handoff.mjs, carried over a /clear by the compact hook), and the keeper's file of a k run step's headless
// session { kind: 'headless', task, step }. Session id → the file. The release deletes k start's file, so the links
// that ended are read from the log beside it, links.jsonl (lib/links.mjs; gulnya/usage-improve-11-22 AC-1).
export function linksOf(home) {
  const out = new Map();
  let fs;
  try {
    fs = readdirSync(join(home, 'sessions'));
  } catch {
    return out;
  }
  for (const f of fs.filter((x) => x.endsWith('.json'))) {
    const s = readSession(home, f.slice(0, -5));
    if (s && typeof s.task === 'string' && s.task) out.set(f.slice(0, -5), s);
  }
  return out;
}

// The task and step of a session's call at `at` (ms), from three records (gulnya/k-usage D-3). A headless step's
// session, named by the step's run records (steps/S-n/run-k.json and keep-k.json, lib/cost.mjs's records) or by the
// keeper's file, is that step's whole. Any other session is in a step while it runs and its started line names the
// session (the latest started first); a step holds the session only while it runs, whatever task the step is of
// (gulnya/usage-improve-11-22 AC-4, AC-5, D-1). Outside every step the session holds its k start link's task under no
// step (step null): of its links, from links.jsonl (the log, which keeps them after the release; lib/links.mjs) and
// from the live files, the one whose `since` came last (E-2), until its `until` (the release). Only a session no link
// holds at the call falls back to the task of the step it last started, and a release after that step's start still
// ends it, so a call after the release is in no task until the session's next link or step (AC-1, AC-2).
// `sessions` are the ids the step lines' names resolve against. (session, at) → { task, step }, both null for a call
// in no task; the function's `skipped` is the count of the log's lines that could not be read (E-1).
export function joinOf({ tasks, home, sessions }) {
  // links: k start's link events, { at, task } for a since and task null for an until; started: steps' starts.
  const resolve = resolver(sessions), headless = new Map(), ivs = new Map(), links = new Map(), started = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const t of tasks.values()) {
    for (const dir of t.dirs) for (const r of records(dir)) if (r.run.sessionId) headless.set(r.run.sessionId, { task: t.id, step: r.step });
    for (const iv of t.steps) {
      const s = resolve(iv.named);
      if (!s) continue;
      push(ivs, s, iv);
      push(started, s, { at: iv.start, task: t.id });
    }
  }
  const log = readLinks(home);
  for (const l of log.links) {
    if (Number.isFinite(l.since)) push(links, l.session, { at: l.since, task: l.task });
    if (Number.isFinite(l.until)) push(links, l.session, { at: l.until, task: null });
  }
  for (const [s, f] of linksOf(home)) {
    if (f.kind === 'headless' && f.step) {
      if (!headless.has(s)) headless.set(s, { task: f.task, step: f.step });
    } else {
      const since = Date.parse(f.since);
      push(links, s, { at: Number.isFinite(since) ? since : -Infinity, task: f.task });
    }
  }
  const of = (session, at) => {
    const h = headless.get(session);
    if (h) return h;
    let iv = null, link = null, last = null;
    for (const x of ivs.get(session) || []) if (x.start <= at && at < x.end && (!iv || x.start >= iv.start)) iv = x;
    if (iv) return { task: iv.task, step: iv.step };
    for (const x of links.get(session) || []) if (x.at <= at && (!link || x.at >= link.at)) link = x;
    if (link?.task) return { task: link.task, step: null };
    for (const x of started.get(session) || []) if (x.at <= at && (!last || x.at >= last.at)) last = x;
    // The step started last, unless the release (link, an until) came after it or at the same moment.
    return { task: last && (!link || last.at > link.at) ? last.task : null, step: null };
  };
  of.skipped = log.skipped;
  // The ends of the steps the session ran (finished or failed), for bytask.mjs's step follow-up (AC-11).
  of.stepEnds = (session) => (ivs.get(session) || []).map((x) => x.end).filter(Number.isFinite);
  return of;
}

// The session's entrypoint (`cli` interactive, `sdk-cli` a headless k run step), from its transcript's first lines;
// null when no project folder holds it, or it is skipped or cannot be read.
export function entryOf(projects, session, skipped = new Set()) {
  for (const p of readdirSync(projects)) {
    const f = join(projects, p, `${session}.jsonl`);
    if (!existsSync(f)) continue;
    if (skipped.has(f)) return null;
    let fd;
    try {
      fd = openSync(f, 'r');
      const buf = Buffer.alloc(65536), n = readSync(fd, buf, 0, buf.length, 0);
      const m = /"entrypoint":"([^"]+)"/.exec(buf.toString('utf8', 0, n));
      return m ? m[1] : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return null;
}

// Review findings, by the two grammars on record: a kirunak task review (a verdict table `| AC-n | not met | ...` and
// `## Findings` bullets) and a Fable step review (`**B-1.**` or `### B-1` for blocking, should fix and notes).
export function findingsOf(text) {
  const f = { notMet: 0, needsOwner: 0, findings: 0, B: 0, S: 0, N: 0 };
  let inFindings = false;
  for (const l of text.split('\n')) {
    if (/^## /.test(l)) inFindings = /^## Findings\b/.test(l);
    else if (inFindings && /^- /.test(l)) f.findings++;
    const v = /^\| *[A-Z]+-\d+ *\| *(not met|needs owner) *\|/.exec(l);
    if (v && v[1] === 'not met') f.notMet++;
    else if (v) f.needsOwner++;
    const k = /^(?:\*\*|#{2,4} )([BSN])-\d+\b/.exec(l);
    if (k) f[k[1]]++;
  }
  return f;
}

// A fix commit names the task (`<repo>/<slug>` anywhere in its subject, or in the task's own repo `<slug> S-n`) and
// changes more than the task's own records (its folder, approvals, drafts, the queue); a merge, listing no files, is none.
const RECORD = /^kirunak\/(tasks|approvals|drafts)\/|^kirunak\/queue\.md$/;
const esc = (x) => x.replace(/[/-]/g, '\\$&');
export const isFix = (t, c) => (new RegExp(`(^|[^\\w/-])${esc(t.id)}(?![\\w-])`).test(c.subject)
  || (c.root === t.root && new RegExp(`(^|[^\\w/-])${esc(t.slug)} S-\\d`).test(c.subject))) && c.files.some((f) => !RECORD.test(f));

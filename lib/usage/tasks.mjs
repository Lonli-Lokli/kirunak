// The kirunak tasks behind the week's sessions (gulnya/fresh-session-per-step AC-9): every repo's
// kirunak/tasks/*/progress.md, the steps it started and finished, the sessions its step lines name, and what counts
// as a review finding and a fix commit.
// Worktree checkouts (`<root>-*` beside a repo, such as gulnya-themes or katyafm-capture) merge with their repo's task,
// and a step runs from its `started` line to its `finished` or `failed` line (to that minute's end) or to the same
// step's next `started`. Step lines are stamped in the machine's own time (lib/steps.mjs), read in `zone`.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { compactOf } from '../compact.mjs';
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

export const RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (S-\d+[a-z]?) (started|finished|failed)\b(.*)/;

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
// { task, step, named, start, end, finished, endMinute } where `named` is the session the started line names.
export function readTasks(roots, { zone = localZone() } = {}) {
  const tasks = new Map();
  for (const { dir, d, r, slug, progress } of taskFolders(roots)) {
    const id = `${roots.nameOf[r] || r}/${slug}`;
    if (!tasks.has(id)) tasks.set(id, { id, slug, root: r, dirs: [], lines: new Set(), steps: [] });
    const t = tasks.get(id);
    if (d === r) t.dirs.unshift(dir); else t.dirs.push(dir); // the repo's own checkout first
    for (const l of readFileSync(progress, 'utf8').split('\n')) t.lines.add(l);
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
      const iv = { task, step: e.step, named: e.named, start: e.t, end: Infinity, finished: null };
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

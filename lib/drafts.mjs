import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { localDate } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { commit, git, head, toplevel } from './git.mjs';
import { validDate } from './source.mjs';
import { parseId, taskPaths } from './workspace.mjs';

// Drafts (kirunak-drafts AC-1, AC-5, AC-12): a prepared intake for a future task, in the repo the task is for, at
// kirunak/drafts/<slug>.md, its id <repo>/<slug> from the start. A draft is not a task: any session writes one without
// the owner's approval, nothing freezes it, and nothing in it is a ruling (the intake still asks every line).
// A bug (kirunak-spikes D-1, AC-2, AC-4) is a draft whose front matter names the accepted task it was found in,
// `bug-of: <task id>`, in any repo of the workspace; one section more, Fix written, holds a fix that exists already.
// It has no state field (AC-5): it is parked while it waits here, taken once an intake moves it, closed by a drop.

const TEMPLATE = new URL('../templates/draft.md', import.meta.url);
const BUG_TEMPLATE = new URL('../templates/bug.md', import.meta.url);
export const SECTIONS = ['Who raised it', 'Why', 'What was found', 'Questions'];
export const FIX = 'Fix written';
// A bug's sections in their order; Fix written alone may be left out, when no fix exists.
export const BUG_SECTIONS = ['Who raised it', 'Why', 'What was found', FIX, 'Questions'];
export const SOURCE_KINDS = ['file', 'command', 'commit', 'research'];
export const TITLE_MAX = 80;
const PLACEHOLDER = /<!--\s*fill in\b/;
const SOURCE = new RegExp(`\\[(${SOURCE_KINDS.join('|')}) [^[\\]]*\\S[^[\\]]*\\]$`);
const SOURCES_HINT = SOURCE_KINDS.map((k) => `[${k} ...]`).join(', ');
const FIX_SOURCE = /\[commit [0-9a-f]{7,64}\]$|\[file [^[\]]*\S[^[\]]*\]$/;
const FIX_COMMIT = /\[commit ([0-9a-f]{7,64})\]/g;
const FIX_HINT = '[commit <sha>] or [file <patch path>]';
const NO_STATE = 'a draft has no state field: a bug is parked while it waits in kirunak/drafts/, taken once an intake ' +
  'moves it, and closed by `k draft drop --why`';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Where a draft is. A repo the workspace does not know is refused (E-1): only the owner adds a repo.
export function draftPaths(ws, id) {
  let parsed;
  try {
    parsed = parseId(id);
  } catch (e) {
    throw usage(e.message.replace('not a task id', 'not a draft id'));
  }
  const { repo, slug } = parsed;
  const r = ws.repos.find((x) => x.name === repo);
  if (!r) {
    throw refuse(`unknown repo ${repo}: kirunak's workspace lists ${ws.repos.map((x) => x.name).join(', ')}. ` +
      `Ask the owner to add ${repo} to kirunak's workspace first (${ws.modulePath}), then write the draft`);
  }
  const rel = `kirunak/drafts/${slug}.md`;
  return { id, repo, slug, root: r.root, rel, path: join(r.root, rel) };
}

// `k draft new <id> --title "..."`: the skeleton, its placeholders refused by the check until filled. Commits nothing:
// the session that writes the draft commits it. An id that is already a draft or a task is refused (E-2).
// With `bugOf`, a bug's skeleton (kirunak-spikes AC-2, AC-4): the task must exist (E-1) and be accepted (E-2), and is
// only read, so its folder stays byte for byte as it was (AC-3); the bug's repo may be another than the task's.
export function newDraft({ ws, id, title, bugOf = null, session = null, now = new Date(), dryRun = false }) {
  const name = oneLine(title);
  if (!name) throw usage('a draft needs its title, a few words that name it in every list: --title "<title>"');
  if (name.length > TITLE_MAX) throw usage(`a draft's title is a few words, at most ${TITLE_MAX} characters: ${name}`);
  const p = draftPaths(ws, id);
  if (existsSync(p.path)) throw refuse(`${id} is already a draft: ${p.path}`);
  const t = taskPaths(ws, id);
  if (existsSync(t.dir) || existsSync(t.record)) throw refuse(`${id} is already a task: ${existsSync(t.dir) ? t.dir : t.record}`);
  const of = bugOf === null || bugOf === undefined ? null : oneLine(bugOf);
  if (of === '') throw usage('--bug-of names the accepted task the bug was found in: --bug-of <repo>/<slug>');
  if (of) {
    parseId(of);
    const why = notAccepted(ws, of);
    if (why) throw refuse(why);
  }
  if (dryRun) return { ...p, title: name, bugOf: of };
  const fill = { id, title: name, written: localDate(now), session: oneLine(session) || '<session id>', bugOf: of };
  const text = readFileSync(of ? BUG_TEMPLATE : TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  mkdirSync(dirname(p.path), { recursive: true });
  writeFileSync(p.path, text);
  return { ...p, title: name, bugOf: of };
}

// Why a bug cannot name `task` (kirunak-spikes E-1, E-2, E-4), or null when it is an accepted task: it exists, in any
// repo of the workspace, and its folder holds done.json (k accept). Reads only; `task` has a task id's shape.
export function notAccepted(ws, task) {
  let t;
  try {
    t = taskPaths(ws, task);
  } catch (e) {
    return e.message;
  }
  if (!existsSync(t.task)) return `unknown task ${task}: ${t.task} does not exist; a bug names the accepted task it was found in`;
  if (!existsSync(join(t.dir, 'done.json'))) {
    return `${task} is not accepted yet: a bug found while a task is open goes into that task, through its review or ` +
      `an amendment (k amend new ${task} --title "...")`;
  }
  return null;
}

const isTaskId = (s) => {
  try {
    parseId(s);
    return true;
  } catch {
    return false;
  }
};

// { front, frontLine, frontEnd, length, sections: [{ name, line, lines: [{ line, text }], placeholder }],
// stray: [{ line, text }] }, `frontLine` the line of each front-matter key. HTML comments are blanked first, so neither
// a placeholder nor a hint counts as a section's content.
export function parseDraft(text) {
  const raw = text.replace(/\r/g, '').split('\n');
  const front = {};
  const frontLine = {};
  let frontEnd = 0;
  if (raw[0] === '---') {
    const close = raw.indexOf('---', 1);
    frontEnd = close < 0 ? raw.length : close + 1;
    raw.slice(1, close < 0 ? raw.length : close).forEach((l, n) => {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(l);
      if (m) [front[m[1]], frontLine[m[1]]] = [m[2].trim(), n + 2];
    });
  }
  const body = raw.slice(frontEnd).join('\n');
  const bare = body.replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => c.replace(/[^\n]/g, '')).split('\n');
  const sections = [];
  const stray = [];
  let fence = false;
  body.split('\n').forEach((l, n) => {
    const line = frontEnd + n + 1;
    const text = bare[n];
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    const h = !fence && /^##\s+(.+?)\s*$/.exec(text);
    if (h) return sections.push({ name: h[1], line, lines: [], placeholder: false });
    const at = sections[sections.length - 1];
    if (at && PLACEHOLDER.test(l)) at.placeholder = true;
    if (text.trim()) (at ? at.lines : stray).push({ line, text });
  });
  return { front, frontLine, frontEnd, length: raw.length, sections, stray };
}

// [{ line, problem }]: every way the draft misses AC-5's shape, and a bug kirunak-spikes AC-4's. `id` is the id its
// place gives it. Only the shape: whether a bug's task and its fix's commits exist is check()'s (E-4).
export function checkDraft(text, id = null) {
  const d = parseDraft(text);
  const problems = [];
  const add = (line, problem) => problems.push({ line, problem });
  const f = d.front;
  const bug = 'bug-of' in f;
  if (!d.frontEnd) add(1, 'no front matter: the draft starts with --- and id, title, written');
  for (const k of ['id', 'title', 'written']) if (d.frontEnd && !f[k]) add(1, `front matter has no ${k}`);
  if (f.id && id && f.id !== id) add(1, `id ${f.id} is not this draft's id ${id}`);
  if (f.title && f.title.length > TITLE_MAX) add(1, `the title is a few words, at most ${TITLE_MAX} characters`);
  if (f.written && !validDate(f.written)) add(1, `written ${f.written} is not a date YYYY-MM-DD`);
  if (bug && !isTaskId(f['bug-of'])) {
    const named = f['bug-of'] ? `bug-of ${f['bug-of']} is not a task id` : 'bug-of is empty';
    add(d.frontLine['bug-of'], `${named}: name the accepted task the bug was found in, <repo>/<slug>`);
  }
  if ('state' in f) add(d.frontLine.state, NO_STATE);
  for (const s of d.stray) add(s.line, `text before the first section: it belongs under a ## heading`);

  // A bug's order holds Fix written; a plain draft has no fix to name, so the section is refused there.
  const order = bug ? BUG_SECTIONS : SECTIONS;
  const end = d.length;
  let last = -1;
  const seen = new Map();
  for (const s of d.sections) {
    const at = order.indexOf(s.name);
    if (s.name === FIX && !bug) add(s.line, `## ${FIX} is a bug's: only a draft with bug-of: <task> holds the fix already written`);
    else if (at < 0) add(s.line, `unknown section "## ${s.name}": the sections are ${order.join(', ')}`);
    else if (seen.has(s.name)) add(s.line, `section ${s.name} appears twice`);
    else if (at < last) add(s.line, `section ${s.name} is out of order: ${order.join(', ')}`);
    if (at >= 0 && !seen.has(s.name)) seen.set(s.name, s);
    last = Math.max(last, at);
  }
  for (const name of SECTIONS) {
    const s = seen.get(name);
    if (!s) add(end, `missing section ## ${name}`);
    else if (!s.lines.length) add(s.line, `## ${name} is empty${s.placeholder ? ': it still holds its placeholder' : ''}`);
    else if (s.placeholder) add(s.line, `## ${name} still holds its placeholder: remove the <!-- fill in ... --> comment`);
    else RULES[name](s, (line, p) => add(line, `## ${name}: ${p}`));
  }
  // Fix written's placeholder is refused like the others, so the writer either names the fix or deletes the section.
  const fix = seen.get(FIX);
  if (fix && (!fix.lines.length || fix.placeholder)) {
    const left = fix.placeholder ? 'still holds its placeholder' : 'is empty';
    add(fix.line, `## ${FIX} ${left}: name the fix's commits or patch file, or delete the section when no fix exists`);
  } else if (fix) RULES[FIX](fix, (line, p) => add(line, `## ${FIX}: ${p}`));
  return problems.sort((a, b) => a.line - b.line);
}

// The `- ` items of a section with their indented continuation lines; any other line is reported to `stray`.
function items(s, start, stray) {
  const out = [];
  for (const l of s.lines) {
    const m = start.exec(l.text);
    if (m) out.push({ line: l.line, m, text: l.text.trim() });
    else if (out.length && /^\s+\S/.test(l.text)) out[out.length - 1].text += ' ' + l.text.trim();
    else stray(l);
  }
  return out;
}

const RULES = {
  'Who raised it'(s, add) {
    const text = s.lines.map((l) => l.text).join('\n');
    const agent = /found by the agent\b/i.exec(text);
    if (agent) {
      const rest = text.slice(agent.index + agent[0].length).replace(/^[\s:,.-]+/, '');
      if (!rest.trim()) add(s.line, 'say what the agent saw, after "found by the agent:"');
      return;
    }
    const why = 'the owner\'s words as typed, each line starting with "> ", or "found by the agent:" and what it saw';
    if (!s.lines.some((l) => /^>\s*\S/.test(l.text))) add(s.line, `no quoted words: ${why}`);
    const dates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
    if (!dates.some(validDate)) add(s.line, 'no date: say when the owner said it, YYYY-MM-DD');
    if (!/(?:^|[^<\w])session\s+[^\s<>]+/im.test(text)) add(s.line, 'no session: name the session the owner said it in, "session <id>"');
  },
  Why() {},
  'What was found'(s, add) {
    const found = items(s, /^- \S/, (l) => {
      if (!/^###\s/.test(l.text)) add(l.line, `write each finding as a "- " line ending with its source (${SOURCES_HINT})`);
    });
    if (!found.length) add(s.line, `no finding: one "- " line each, ending with its source (${SOURCES_HINT})`);
    for (const it of found) if (!SOURCE.test(it.text)) add(it.line, `this finding names no source: end it with ${SOURCES_HINT}`);
  },
  // kirunak-spikes AC-4: a fix that exists already, each a "- " line ending with its commit or its patch file.
  [FIX](s, add) {
    const fixes = items(s, /^- \S/, (l) => add(l.line, `write each fix as a "- " line ending with ${FIX_HINT}`));
    if (!fixes.length) add(s.line, `no fix: one "- " line each, ending with ${FIX_HINT}`);
    for (const it of fixes) if (!FIX_SOURCE.test(it.text)) add(it.line, `this fix names no commit or patch file: end it with ${FIX_HINT}`);
  },
  Questions(s, add) {
    const qs = items(s, /^(\d+)\.\s+\S/, (l) => add(l.line, 'a question is a numbered line, "1. <question>"'));
    if (!qs.length) add(s.line, 'no question: number them "1. ", "2. ", one a line');
    qs.forEach((q, i) => {
      if (Number(q.m[1]) !== i + 1) add(q.line, `question ${q.m[1]} is out of turn: number them 1, 2, 3 in order`);
    });
  },
};

// `k draft check <id>`: the draft's problems, an empty list when it holds AC-5's shape. A bug's too, what its shape
// cannot show (kirunak-spikes E-4): its task exists and is accepted, and every commit its Fix written names is in the
// bug's repo or the task's, the two repos its fix can be in.
export function check(ws, id) {
  const p = draftPaths(ws, id);
  if (!existsSync(p.path)) throw refuse(`no draft ${id}: ${p.path} does not exist (k draft new ${id} --title "...")`);
  const text = readFileSync(p.path, 'utf8');
  const problems = checkDraft(text, id);
  const d = parseDraft(text);
  const task = d.front['bug-of'];
  if (!task || !isTaskId(task)) return problems;
  const why = notAccepted(ws, task);
  if (why) problems.push({ line: d.frontLine['bug-of'], problem: `bug-of: ${why}` });
  // The bug's repo, then the task's when the workspace knows it and it is another.
  const repos = [ws.repos.find((r) => r.name === p.repo), ws.repos.find((r) => r.name === parseId(task).repo)]
    .filter((r, i, all) => r && all.indexOf(r) === i);
  const where = repos.length > 1 ? `neither ${repos[0].name} nor ${repos[1].name}` : repos[0].name;
  const fix = d.sections.find((s) => s.name === FIX);
  for (const l of fix?.lines ?? []) {
    for (const [, sha] of l.text.matchAll(FIX_COMMIT)) {
      if (repos.some((r) => hasCommit(r.root, sha))) continue;
      problems.push({ line: l.line, problem: `## ${FIX}: commit ${sha} is ${repos.length > 1 ? '' : 'not '}found in ${where}` });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

function hasCommit(root, sha) {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// `k draft drop <id> --why "..."`: removes the draft in a commit of that one path, the reason in its message; other
// staged changes stay staged and out of it (AC-7). A draft never committed is only deleted: no commit can carry it.
export function drop({ ws, id, why, dryRun = false }) {
  const reason = oneLine(why);
  if (!reason) throw usage('dropping a draft needs its reason: --why "<why>"');
  const p = draftPaths(ws, id);
  const tracked = isTracked(p.root, p.rel);
  if (!tracked && !existsSync(p.path)) throw refuse(`no draft ${id}: ${p.path} does not exist`);
  const message = `kirunak: drop the draft ${id}: ${reason}`;
  const out = { id, repo: p.repo, path: p.path, rel: p.rel, message, commit: null };
  if (dryRun) return { ...out, tracked };
  if (!tracked) {
    unlinkSync(p.path);
    return out;
  }
  const kept = existsSync(p.path) ? readFileSync(p.path) : null;
  try {
    git(p.root, ['rm', '-q', '-f', '--', p.rel]);
    git(p.root, ['commit', '-q', '-m', message, '--', p.rel]);
  } catch (e) {
    // Put the draft back as it was, so a refused commit loses nothing.
    try {
      git(p.root, ['reset', '-q', '--', p.rel]);
    } catch {
      // a repo with no commit yet has nothing to reset to
    }
    if (kept) {
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileSync(p.path, kept);
    }
    throw refuse(`git commit in ${p.root} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  return { ...out, commit: head(p.root) };
}

// An intake started from a draft takes it (AC-6): `git mv`, staged and not committed, when git knows the draft, so its
// history follows it; a plain rename when it was never added. True when the move is staged.
export function moveDraft(root, fromRel, toRel) {
  if (isTracked(root, fromRel)) {
    git(root, ['mv', '--', fromRel, toRel]);
    return true;
  }
  mkdirSync(dirname(join(root, toRel)), { recursive: true });
  renameSync(join(root, fromRel), join(root, toRel));
  return false;
}

function isTracked(root, rel) {
  try {
    git(root, ['ls-files', '--error-unmatch', '--', rel]);
    return true;
  } catch {
    return false;
  }
}

// The drafts' order (owner, 2026-10-27: the drafts that need a longer intake wait at the end): one file beside the
// queue, `ws.draftOrder`, one draft id a line, first first; `#` lines are comments. An id that is no longer a draft
// (taken by an intake, dropped) is passed over, and the next move leaves it out.
const ORDER_HEAD = [
  "# The order the drafts wait in for the owner's intake: one draft id a line, first first (k drafts move).",
  '# A draft not named here follows these, by the date written.',
];

function readOrder(ws) {
  if (!ws.draftOrder || !existsSync(ws.draftOrder)) return [];
  return readFileSync(ws.draftOrder, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// `k drafts`: every draft in every repo of the workspace in the drafts' order: the drafts its file names, as it names
// them, then the others by the date written, then by id, a draft with no date last. A bug's row names its task in
// `bugOf`, null for a plain draft (kirunak-spikes AC-6).
export function list(ws) {
  const rows = [];
  for (const r of ws.repos) {
    const dir = join(r.root, 'kirunak', 'drafts');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = /^([a-z0-9-]{1,40})\.md$/.exec(name);
      if (!m) continue;
      const path = join(dir, name);
      const { front } = parseDraft(readFileSync(path, 'utf8'));
      const written = validDate(front.written ?? '') ? front.written : null;
      const bugOf = oneLine(front['bug-of']) || null;
      rows.push({ id: `${r.name}/${m[1]}`, repo: r.name, slug: m[1], title: oneLine(front.title) || m[1], written, bugOf, path });
    }
  }
  const rank = new Map();
  for (const id of readOrder(ws)) if (!rank.has(id)) rank.set(id, rank.size);
  const place = (x) => rank.get(x.id) ?? rank.size;
  const key = (x) => x.written ?? '9999-99-99';
  return rows.sort((a, b) => place(a) - place(b) || key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
}

// `k drafts move <id>... [--first|--last|--before <id>|--after <id>]` (owner, 2026-10-27): the drafts named, in the
// order named, to that place, last with no flag, as `k queue move` places a task. Any session runs it: a draft is not
// the owner's (R25). The file is written whole, every draft in the order k drafts then shows and no id that is no
// longer one, and committed alone in the repo that holds it; a refused commit puts the file back as it was.
export function move({ ws, ids, place = {}, dryRun = false, env }) {
  if (!ids.length) throw usage('k drafts move names one draft or more: k drafts move <id>... [--first|--last|--before <id>|--after <id>]');
  const order = list(ws).map((r) => r.id);
  const known = (id) => {
    if (!order.includes(id)) throw refuse(`no draft ${id}: k drafts lists every draft`);
  };
  ids.forEach(known);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw usage(`${twice} is named twice`);
  const target = place.before ?? place.after ?? null;
  if (target !== null) {
    known(target);
    if (ids.includes(target)) throw refuse(`${target} cannot move relative to itself`);
  }
  const rest = order.filter((id) => !ids.includes(id));
  const at = place.first ? 0 : place.before ? rest.indexOf(place.before) : place.after ? rest.indexOf(place.after) + 1 : rest.length;
  const next = [...rest.slice(0, at), ...ids, ...rest.slice(at)];
  const path = ws.draftOrder;
  const message = ids.length === 1 ? `kirunak: drafts move ${ids[0]}` : `kirunak: drafts move ${ids.length} drafts\n\n${ids.join('\n')}`;
  const text = [...ORDER_HEAD, ...next].join('\n') + '\n';
  const kept = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const out = { order: next, path, message, commit: null };
  if (dryRun || kept === text) return out;
  const root = toplevel(dirname(path));
  if (!root) throw refuse(`the drafts' order ${path} is not in a git repo`);
  writeFileSync(path, text);
  try {
    return { ...out, commit: commit(root, [relative(root, path)], message, env) };
  } catch (e) {
    try {
      git(root, ['reset', '-q', '--', relative(root, path)]);
    } catch {
      // a repo with no commit yet has nothing to reset to
    }
    if (kept === null) unlinkSync(path);
    else writeFileSync(path, kept);
    throw e;
  }
}

// One line a draft: id, title, date written, and on a bug's line `bug of <task>` (kirunak-spikes D-2).
export function format(rows) {
  if (!rows.length) return 'no drafts';
  const wId = Math.max(...rows.map((r) => r.id.length));
  const wTitle = Math.min(48, Math.max(...rows.map((r) => r.title.length)));
  const cut = (s) => (s.length > wTitle ? s.slice(0, wTitle - 3) + '...' : s);
  const date = (r) => r.written ?? 'no date';
  const tail = (r) => (r.bugOf ? `${date(r).padEnd(10)}  bug of ${r.bugOf}` : date(r));
  return rows.map((r) => `${r.id.padEnd(wId)}  ${cut(r.title).padEnd(wTitle)}  ${tail(r)}`).join('\n');
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localDate } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { validDate } from './source.mjs';
import { parseId, taskPaths } from './workspace.mjs';

// Drafts (kirunak-drafts AC-1, AC-5, AC-12): a prepared intake for a future task, in the repo the task is for, at
// kirunak/drafts/<slug>.md, its id <repo>/<slug> from the start. A draft is not a task: any session writes one without
// the owner's approval, nothing freezes it, and nothing in it is a ruling (the intake still asks every line).

const TEMPLATE = new URL('../templates/draft.md', import.meta.url);
export const SECTIONS = ['Who raised it', 'Why', 'What was found', 'Questions'];
export const SOURCE_KINDS = ['file', 'command', 'commit', 'research'];
export const TITLE_MAX = 80;
const PLACEHOLDER = /<!--\s*fill in\b/;
const SOURCE = new RegExp(`\\[(${SOURCE_KINDS.join('|')}) [^[\\]]*\\S[^[\\]]*\\]$`);
const SOURCES_HINT = SOURCE_KINDS.map((k) => `[${k} ...]`).join(', ');

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
export function newDraft({ ws, id, title, session = null, now = new Date(), dryRun = false }) {
  const name = oneLine(title);
  if (!name) throw usage('a draft needs its title, a few words that name it in every list: --title "<title>"');
  if (name.length > TITLE_MAX) throw usage(`a draft's title is a few words, at most ${TITLE_MAX} characters: ${name}`);
  const p = draftPaths(ws, id);
  if (existsSync(p.path)) throw refuse(`${id} is already a draft: ${p.path}`);
  const t = taskPaths(ws, id);
  if (existsSync(t.dir) || existsSync(t.record)) throw refuse(`${id} is already a task: ${existsSync(t.dir) ? t.dir : t.record}`);
  if (dryRun) return { ...p, title: name };
  const fill = { id, title: name, written: localDate(now), session: oneLine(session) || '<session id>' };
  const text = readFileSync(TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  mkdirSync(dirname(p.path), { recursive: true });
  writeFileSync(p.path, text);
  return { ...p, title: name };
}

// { front, frontEnd, length, sections: [{ name, line, lines: [{ line, text }], placeholder }], stray: [{ line, text }] }.
// HTML comments are blanked first, so neither a placeholder nor a hint counts as a section's content.
export function parseDraft(text) {
  const raw = text.replace(/\r/g, '').split('\n');
  const front = {};
  let frontEnd = 0;
  if (raw[0] === '---') {
    const close = raw.indexOf('---', 1);
    frontEnd = close < 0 ? raw.length : close + 1;
    for (const l of raw.slice(1, close < 0 ? raw.length : close)) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(l);
      if (m) front[m[1]] = m[2].trim();
    }
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
  return { front, frontEnd, length: raw.length, sections, stray };
}

// [{ line, problem }]: every way the draft misses AC-5's shape. `id` is the id its place gives it.
export function checkDraft(text, id = null) {
  const d = parseDraft(text);
  const problems = [];
  const add = (line, problem) => problems.push({ line, problem });
  const f = d.front;
  if (!d.frontEnd) add(1, 'no front matter: the draft starts with --- and id, title, written');
  for (const k of ['id', 'title', 'written']) if (d.frontEnd && !f[k]) add(1, `front matter has no ${k}`);
  if (f.id && id && f.id !== id) add(1, `id ${f.id} is not this draft's id ${id}`);
  if (f.title && f.title.length > TITLE_MAX) add(1, `the title is a few words, at most ${TITLE_MAX} characters`);
  if (f.written && !validDate(f.written)) add(1, `written ${f.written} is not a date YYYY-MM-DD`);
  for (const s of d.stray) add(s.line, `text before the first section: it belongs under a ## heading`);

  const end = d.length;
  let last = -1;
  const seen = new Map();
  for (const s of d.sections) {
    const at = SECTIONS.indexOf(s.name);
    if (at < 0) add(s.line, `unknown section "## ${s.name}": the sections are ${SECTIONS.join(', ')}`);
    else if (seen.has(s.name)) add(s.line, `section ${s.name} appears twice`);
    else if (at < last) add(s.line, `section ${s.name} is out of order: ${SECTIONS.join(', ')}`);
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
  Questions(s, add) {
    const qs = items(s, /^(\d+)\.\s+\S/, (l) => add(l.line, 'a question is a numbered line, "1. <question>"'));
    if (!qs.length) add(s.line, 'no question: number them "1. ", "2. ", one a line');
    qs.forEach((q, i) => {
      if (Number(q.m[1]) !== i + 1) add(q.line, `question ${q.m[1]} is out of turn: number them 1, 2, 3 in order`);
    });
  },
};

// `k draft check <id>`: the draft's problems, an empty list when it holds AC-5's shape.
export function check(ws, id) {
  const p = draftPaths(ws, id);
  if (!existsSync(p.path)) throw refuse(`no draft ${id}: ${p.path} does not exist (k draft new ${id} --title "...")`);
  return checkDraft(readFileSync(p.path, 'utf8'), id);
}

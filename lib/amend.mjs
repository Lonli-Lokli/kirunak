import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { commit } from './git.mjs';
import { isSourced, splitTags, validDate } from './source.mjs';
import { idsOf, parseTask, SECTIONS } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// Amendments (task-files.md §5): a proposed change to a frozen task, as operations on its lines.

const NUMBERED = '(?:AC|E|O|D)-[1-9]\\d*';
const OP_LINE = new RegExp(`^- (replace|add) (${NUMBERED}|[a-z0-9][a-z0-9-]*): (.+)$`);
const OP_REMOVE = new RegExp(`^- remove (${NUMBERED})\\s*$`);
const KEY_OF_PREFIX = { AC: 'ac', E: 'e', O: 'o', D: 'd' };

// 'A-1', 'a-1', '1' or 1 → 'A-1'.
export function amendmentId(a) {
  const m = /^(?:A-)?([1-9]\d*)$/i.exec(String(a ?? '').trim());
  if (!m) throw usage(`not an amendment id: ${a} (want A-n)`);
  return `A-${m[1]}`;
}

// { front, frontEnd, why, changes: [{ op, id, text, line }], bad: [{ line, problem }] }
export function parseAmendment(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const front = {};
  let i = 0;
  let frontEnd = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
      if (m) front[m[1]] = m[2].trim();
    }
    frontEnd = i + 1;
    i++;
  }
  const why = [];
  const changes = [];
  const bad = [];
  let section = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = h[1];
      continue;
    }
    if (line.trim() === '') continue;
    if (section === 'Why') why.push(line.trim());
    else if (section === 'Changes') {
      let m;
      if ((m = OP_LINE.exec(line))) changes.push({ op: m[1], id: m[2], text: m[3].trim(), line: i + 1 });
      else if ((m = OP_REMOVE.exec(line))) changes.push({ op: 'remove', id: m[1], line: i + 1 });
      else bad.push({ line: i + 1, problem: 'not an operation: "- replace <id>: <line>", "- add <id>: <line>" or "- remove <id>"' });
    } else {
      bad.push({ line: i + 1, problem: 'text outside ## Why and ## Changes' });
    }
  }
  return { front, frontEnd, why: why.join(' '), changes, bad };
}

const VERB_OF = { replace: 'replaces', add: 'adds', remove: 'removes' };

// What an amendment goes by in a list (kirunak-phone A-8): its title, or with none the lines it changes, as
// "replaces AC-2, AC-3; adds AC-17".
export function amendmentName(amendment) {
  const a = typeof amendment === 'string' ? parseAmendment(amendment) : amendment;
  if (a.front.title) return a.front.title;
  const parts = Object.entries(VERB_OF).map(([op, verb]) => {
    const ids = [...new Set(a.changes.filter((c) => c.op === op).map((c) => c.id))];
    return ids.length ? `${verb} ${ids.join(', ')}` : null;
  });
  return parts.filter(Boolean).join('; ') || 'changes nothing yet';
}

const numberOf = (id) => Number(id.split('-')[1]);
const prefixOf = (id) => id.split('-')[0];

// [{ line, problem }], the lines being the amendment's. opts.removed: ids earlier applied amendments removed.
export function checkAmendment(taskText, amendmentText, { removed = new Set() } = {}) {
  const task = parseTask(taskText);
  const a = parseAmendment(amendmentText);
  const problems = [...a.bad];
  const add = (line, problem) => problems.push({ line, problem });

  if (!a.frontEnd) add(1, 'no front matter: the amendment starts with --- and task, proposed, title, by');
  for (const k of ['task', 'proposed', 'by']) if (a.frontEnd && !a.front[k]) add(1, `front matter has no ${k}`);
  // Its name in every list (kirunak-phone A-8); an applied or declined amendment is history and keeps what it had.
  if (a.frontEnd && !a.front.title && !a.front.applied && !a.front.declined) {
    add(1, 'front matter has no title: add `title: <a few words>` to its front matter, the name it goes by in every list');
  }
  if (a.front.task && task.front.id && a.front.task !== task.front.id) add(1, `task ${a.front.task} is not ${task.front.id}`);
  if (a.front.proposed && !validDate(a.front.proposed)) add(1, `proposed ${a.front.proposed} is not a date YYYY-MM-DD`);
  if (a.front.applied) add(1, `already applied on ${a.front.applied}`);
  if (a.front.declined) add(1, `already declined: ${a.front.declined}`);
  if (!a.why) add(a.frontEnd || 1, 'Why is empty: say why the task must change');
  if (!a.changes.length) add(a.frontEnd || 1, 'Changes has no operation');

  // Played in order against the task's ids, so an id removed earlier in the amendment no longer exists.
  const ids = idsOf(task);
  const aspects = new Set(task.sections.aspects.filter((x) => x.aspect).map((x) => x.aspect));
  const highest = {};
  for (const id of [...ids, ...removed]) {
    const p = prefixOf(id);
    if (KEY_OF_PREFIX[p]) highest[p] = Math.max(highest[p] || 0, numberOf(id));
  }
  for (const c of a.changes) {
    const isAspect = !/^[A-Z]/.test(c.id);
    if (c.op === 'replace') {
      if (isAspect ? !aspects.has(c.id) : !ids.has(c.id)) add(c.line, `replace ${c.id}: the task has no ${c.id}`);
    } else if (c.op === 'remove') {
      if (!ids.has(c.id)) add(c.line, `remove ${c.id}: the task has no ${c.id}`);
      ids.delete(c.id);
    } else if (isAspect) {
      add(c.line, `add ${c.id}: an added line is AC-n, E-n, O-n or D-n`);
    } else {
      const p = prefixOf(c.id);
      const next = (highest[p] || 0) + 1;
      if (numberOf(c.id) !== next) {
        const why = removed.has(c.id) ? `${c.id} was removed and a number is never reused` : `${c.id} is taken or skips a number`;
        add(c.line, `add ${c.id}: ${why}; the next free is ${p}-${next}`);
      } else {
        highest[p] = next;
        ids.add(c.id);
      }
    }
    if (c.text !== undefined) {
      const { tags, bad } = splitTags(c.text);
      for (const b of bad) add(c.line, `${c.op} ${c.id}: malformed tag ${b}`);
      if (!isSourced(tags)) add(c.line, `${c.op} ${c.id}: the new line names no source: [owner ...], [research ...] or [default ...]`);
    }
  }
  return problems.sort((x, y) => x.line - y.line);
}

// The line an operation writes: `- AC-4 <text>`, or `- <aspect>: <ruling>` for an aspect.
function newLine(c) {
  if (!/^[A-Z]/.test(c.id)) return `- ${c.id}: ${c.text}`;
  return c.text.startsWith(c.id + ' ') ? `- ${c.text}` : `- ${c.id} ${c.text}`;
}

// The 0-based [start, end) span of an item: its line and its indented continuation lines.
function span(lines, item) {
  const start = item.line - 1;
  let end = start + 1;
  while (end < lines.length && /^\s{2,}\S/.test(lines[end])) end++;
  return [start, end];
}

// Applies the operations in order; throws a refusal on one that does not fit (run checkAmendment first).
export function applyAmendment(taskText, amendment) {
  const a = typeof amendment === 'string' ? parseAmendment(amendment) : amendment;
  let lines = taskText.split('\n');
  for (const c of a.changes) {
    const task = parseTask(lines.join('\n'));
    const all = SECTIONS.flatMap(([, k]) => task.sections[k]);
    if (c.op === 'add') {
      const key = KEY_OF_PREFIX[prefixOf(c.id)];
      const h = task.headings.find((x) => x.key === key);
      if (!key || !h) throw refuse(`add ${c.id}: the task has no section for it`);
      const items = task.sections[key];
      const at = items.length ? span(lines, items[items.length - 1])[1] : h.line;
      lines.splice(at, 0, newLine(c));
      continue;
    }
    const item = all.find((x) => (/^[A-Z]/.test(c.id) ? x.id === c.id : x.aspect === c.id));
    if (!item) throw refuse(`${c.op} ${c.id}: the task has no ${c.id}`);
    const [start, end] = span(lines, item);
    if (c.op === 'replace') lines.splice(start, end - start, newLine(c));
    else lines.splice(start, end - start);
  }
  return lines.join('\n');
}

// Adds a stamp line (`applied: <date>`, `declined: <date> <why>`) before the front matter's closing ---.
export function stamp(text, line) {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw refuse('the amendment has no front matter to stamp');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw refuse('the amendment front matter has no closing ---');
  lines.splice(close, 0, line);
  return lines.join('\n');
}

function amendmentsDir(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  return { p, dir: join(p.dir, 'amendments') };
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Writes the skeleton of the next amendment, A-<highest + 1>.md, for the model to fill, under the title it is given.
export function newAmendment({ ws, id, title, by = 'session', now = new Date() }) {
  const name = oneLine(title);
  if (!name) throw usage('an amendment needs its title, a few words that name it in every list: --title "<title>"');
  const { dir } = amendmentsDir(ws, id);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).map((f) => /^A-(\d+)\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  const n = Math.max(0, ...taken) + 1;
  const path = join(dir, `A-${n}.md`);
  const by1 = oneLine(by) || 'session';
  writeFileSync(path, `---\ntask: ${id}\nproposed: ${localDate(now)}\ntitle: ${name}\nby: ${by1}\n---\n\n## Why\n\n## Changes\n`);
  return { path, n };
}

// Reads an amendment of a task: { aid, path, rel, text, parsed }.
export function readAmendment(ws, id, amendment) {
  const { p, dir } = amendmentsDir(ws, id);
  const aid = amendmentId(amendment);
  const path = join(dir, `${aid}.md`);
  if (!existsSync(path)) throw refuse(`${id} has no amendment ${aid}: ${path} does not exist`);
  const text = readFileSync(path, 'utf8');
  return { aid, path, rel: p.rel(`amendments/${aid}.md`), text, parsed: parseAmendment(text) };
}

export function refuseIfStamped(id, am) {
  if (am.parsed.front.applied) throw refuse(`${id} ${am.aid} was already applied on ${am.parsed.front.applied}`);
  if (am.parsed.front.declined) throw refuse(`${id} ${am.aid} was already declined: ${am.parsed.front.declined}`);
}

// The owner declines an amendment: stamps it `declined: <date> <why>` and commits it.
export function decline({ ws, id, amendment, why, now = new Date() }) {
  const reason = String(why ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) throw usage('a decline needs its reason: --why "<why>"');
  const am = readAmendment(ws, id, amendment);
  refuseIfStamped(id, am);
  writeFileSync(am.path, stamp(am.text, `declined: ${localDate(now)} ${reason}`));
  const { p } = amendmentsDir(ws, id);
  const sha = commit(p.root, [am.rel], `kirunak: decline ${id} ${am.aid}`, { KIRUNAK_APPROVING: id });
  return { amendment: am.aid, commit: sha };
}

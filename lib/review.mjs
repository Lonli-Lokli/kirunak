import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { refuse } from './errors.mjs';
import { git, show } from './git.mjs';
import { latestReview } from './state.mjs';
import { parseTask } from './task.mjs';
import { taskPaths } from './workspace.mjs';

// The review record (review.md §2, R14): front matter, a table with one row per AC and E of the frozen task, the
// findings, and the verdict on the last line. `checkReview` is the grammar `k review check` enforces; it is also a
// review step's output check, so a review that fails it fails the step.

export const VERDICTS = ['met', 'not met', 'needs device', 'needs owner'];
const HEADER = /^\|\s*id\s*\|\s*verdict\s*\|\s*evidence\s*\|$/;
const RULE = /^\|(\s*:?-+:?\s*\|)+$/;
const VERDICT_LINE = /^verdict:\s*(.*?)\s*$/;
const FORMS = 'test <Name> (<path>), file <path>:<line>, measure <path> or screenshot <path>';

function rowOf(line, n) {
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return { line: n, id: cells[0] ?? '', verdict: cells[1] ?? '', evidence: cells.slice(2).join('|').trim() };
}

// parseReview(text) → { front, table, rows: [{ line, id, verdict, evidence }], verdictLines, last }
// `table` is the header's line (null with no table); `last` the last line that is not blank.
export function parseReview(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const front = {};
  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
      if (m) front[m[1]] = m[2].trim();
    }
    i++;
  }
  let table = null;
  let inTable = false;
  const rows = [];
  const verdictLines = [];
  let last = null;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) last = { line: i + 1, text: line };
    if (inTable && line.startsWith('|')) {
      if (!RULE.test(line)) rows.push(rowOf(line, i + 1));
      continue;
    }
    inTable = false;
    if (table === null && HEADER.test(line)) [table, inTable] = [i + 1, true];
    if (VERDICT_LINE.test(line)) verdictLines.push({ line: i + 1, text: VERDICT_LINE.exec(line)[1] });
  }
  return { front, table, rows, verdictLines, last };
}

// 'met', 'not met (AC-2, E-1)', 'needs owner (E-2)' → { kind, ids }; null for anything else.
export function parseVerdict(text) {
  if (text === 'met') return { kind: 'met', ids: [] };
  const m = /^(not met|needs owner) \(([^)]*)\)$/.exec(text ?? '');
  return m ? { kind: m[1], ids: m[2].split(',').map((x) => x.trim()).filter(Boolean) } : null;
}

// What the rows make the verdict: met only when every row is; else not met with the rows not met; else needs
// owner with the rows that need a device or the owner.
export function verdictOf(rows) {
  const not = rows.filter((r) => r.verdict === 'not met').map((r) => r.id);
  if (not.length) return { kind: 'not met', ids: not };
  const needs = rows.filter((r) => r.verdict === 'needs device' || r.verdict === 'needs owner').map((r) => r.id);
  return needs.length ? { kind: 'needs owner', ids: needs } : { kind: 'met', ids: [] };
}

// The verdict a review ends on, { kind, ids }; null when its last line is not one.
export function finalVerdict(text) {
  const r = parseReview(text);
  const m = r.last && VERDICT_LINE.exec(r.last.text);
  return m ? parseVerdict(m[1]) : null;
}

export const verdictText = (v) => (v.kind === 'met' ? 'met' : `${v.kind} (${v.ids.join(', ')})`);

// A met row's evidence: { kind: test|file|measure|screenshot, path, line?, name? }, or null.
export function parseEvidence(text) {
  let m = /^test\s+(.+?)\s+\(([^\s()]+?)(?::(\d+))?\)/.exec(text);
  if (m) return { kind: 'test', name: m[1], path: m[2], line: m[3] ? Number(m[3]) : null };
  m = /^file\s+(\S+):(\d+)(?!\d)/.exec(text);
  if (m) return { kind: 'file', path: m[1], line: Number(m[2]) };
  m = /^(measure|screenshot)\s+(\S+)/.exec(text);
  return m ? { kind: m[1], path: m[2].replace(/[,;:)]+$/, ''), line: null } : null;
}

const commitOf = (root, rev) => {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
};

// A cited path at the review's head: in the task folder first (evidence/...), then from the repo root.
function atHead(p, sha, path) {
  if (isAbsolute(path)) return null;
  for (const rel of [p.rel(path), path]) {
    let type = '';
    try {
      type = git(p.root, ['cat-file', '-t', `${sha}:${rel}`]).trim();
    } catch {}
    if (type === 'blob') return show(p.root, `${sha}:${rel}`).toString('utf8');
  }
  return null;
}

const lengthOf = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// The name as written, or a dotted name (Class.method) whose every part is in the file.
function hasTest(text, name) {
  if (text.includes(name)) return true;
  const parts = name.split('.').map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((x) => text.includes(x));
}

function evidenceProblems(row, p, sha) {
  const ev = parseEvidence(row.evidence);
  if (!ev) return [`met without evidence: the evidence starts with ${FORMS}`];
  if (!sha) return [];
  const text = atHead(p, sha, ev.path);
  if (text === null) return [`${ev.path} does not exist at head`];
  const out = [];
  const n = lengthOf(text);
  if (ev.line !== null && (ev.line < 1 || ev.line > n)) out.push(`${ev.path}:${ev.line} is past the file's length (${n} lines at head)`);
  if (ev.kind === 'test' && !hasTest(text, ev.name)) out.push(`test ${ev.name} is not in ${ev.path}`);
  return out;
}

// checkReview(text, { task: parsed task.md, id, p: taskPaths }) → [{ line, problem }] (line 0: the whole file).
export function checkReview(text, { task, id, p }) {
  const r = parseReview(text);
  const out = [];
  const add = (line, problem) => out.push({ line, problem });
  if (r.front.task !== id) add(1, r.front.task ? `the review is for ${r.front.task}, not ${id}` : 'the front matter names no task');
  const sha = r.front.head ? commitOf(p.root, r.front.head) : null;
  if (!r.front.head) add(1, 'the front matter names no head, the commit the cited paths are read at');
  else if (!sha) add(1, `head ${r.front.head} is not a commit of the repo`);
  if (r.table === null) add(0, 'no table: | id | verdict | evidence |');
  const ids = [...task.sections.ac, ...task.sections.e].map((x) => x.id).filter(Boolean);
  const seen = new Map();
  const valid = [];
  for (const row of r.rows) {
    const name = row.id || '(no id)';
    const first = ids.includes(row.id) && !seen.has(row.id);
    if (!ids.includes(row.id)) add(row.line, `${name} is not an AC or E of the task: one row per AC and E, none extra`);
    else if (!first) add(row.line, `${row.id} has a second row (the first is line ${seen.get(row.id)})`);
    else seen.set(row.id, row.line);
    if (!VERDICTS.includes(row.verdict)) {
      add(row.line, `${name}: the verdict ${row.verdict || '(none)'} is not one of ${VERDICTS.join(', ')}`);
      continue;
    }
    if (first) valid.push(row);
    if (row.verdict === 'met') for (const x of evidenceProblems(row, p, sha)) add(row.line, `${name}: ${x}`);
    if (row.verdict === 'not met' && !row.evidence) add(row.line, `${name} is not met: its row names what is wrong`);
  }
  for (const x of ids) if (!seen.has(x)) add(r.table ?? 0, `${x} has no row: one row per AC and E`);
  const rule = verdictOf(valid);
  const expected = verdictText(rule);
  const last = r.last && VERDICT_LINE.exec(r.last.text);
  for (const v of r.verdictLines) if (v.line !== r.last?.line) add(v.line, 'a verdict line before the last line: the verdict is the last line only');
  if (!last) return [...out, { line: r.last?.line ?? 0, problem: `the last line is the verdict: verdict: ${expected}` }];
  const got = parseVerdict(last[1]);
  const same = got && got.kind === rule.kind && [...got.ids].sort().join() === [...rule.ids].sort().join();
  if (!got) add(r.last.line, `verdict: ${last[1]} is not verdict: met, verdict: not met (<ids>) or verdict: needs owner (<ids>)`);
  else if (!same) add(r.last.line, `the rows make the verdict verdict: ${expected}, not verdict: ${last[1]}`);
  return out;
}

// `k review check <id> [<file>]`: the latest review (review.md, review-2.md, ...) or the named one.
export function check(ws, id, file = null) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  const review = file ? (existsSync(join(p.dir, file)) ? { file, text: readFileSync(join(p.dir, file), 'utf8') } : null) : latestReview(p.dir);
  if (!review) throw refuse(`${id} has no ${p.rel(file || 'review.md')}`);
  const task = parseTask(readFileSync(p.task, 'utf8'));
  return { file: review.file, problems: checkReview(review.text, { task, id, p }) };
}

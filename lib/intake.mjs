import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localDate } from './approval.mjs';
import { refuse, usage } from './errors.mjs';
import { git } from './git.mjs';
import { intakeQuestions } from './task.mjs';
import { aspectsOf, taskPaths } from './workspace.mjs';

// The intake's ledger (intake.md §2, §4): the skeleton, the background, and the append-only interview log.

const TEMPLATE = new URL('../templates/task.md', import.meta.url);
const CHANGE_FILES = ['proposal.md', 'tasks.md', 'design.md'];
const LANDED_MAX = 30;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// `k intake start <id> [--from <path>] [--title "..."]`: the draft task.md, an empty intake.md, and with
// `from` a notes.md of background. Commits nothing: the model commits the intake once `k check` passes.
export async function start({ ws, id, from, title, now = new Date() }) {
  const p = taskPaths(ws, id);
  if (existsSync(p.dir)) throw refuse(`${id} exists already: ${p.dir}`);
  const name = oneLine(title) || p.slug.replace(/-/g, ' ');
  const list = await aspectsOf(ws, { id, text: name });
  if (!list.length) throw refuse('no checklist plugin is loaded: the workspace module must list one under plugins');
  const fromRel = from ? repoPath(p.root, from) : null;
  const notes = fromRel ? background(p.root, fromRel, id, now) : null;

  const fill = {
    id,
    title: name,
    created: localDate(now),
    from: fromRel,
    aspects: list.map((a) => `- ${a.id}: ? [open]`).join('\n'),
  };
  let text = readFileSync(TEMPLATE, 'utf8');
  if (!fromRel) text = text.replace(/^from: \{\{from\}\}\n/m, '');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.task, text.replace(/\r/g, '').replace(/\n*$/, '\n'));
  writeFileSync(join(p.dir, 'intake.md'), `# Intake: ${id}\n`);
  if (notes) writeFileSync(join(p.dir, 'notes.md'), notes);
  return { dir: p.dir, aspects: list.length };
}

// A path inside the repo, relative to its root, with forward slashes.
function repoPath(root, path) {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw refuse(`--from ${path} is not inside the repo ${root}`);
  if (!existsSync(abs)) throw refuse(`--from ${path} does not exist in ${root}`);
  return rel.split(sep).join('/');
}

// notes.md: each file's headings and unchecked items, and the commits that may already have landed parts of it.
function background(root, fromRel, id, now) {
  const abs = join(root, fromRel);
  const files = statSync(abs).isDirectory()
    ? CHANGE_FILES.filter((f) => existsSync(join(abs, f))).map((f) => join(fromRel, f))
    : [fromRel];
  if (!files.length) throw refuse(`--from ${fromRel} has none of ${CHANGE_FILES.join(', ')}`);
  const out = [
    `# Notes: ${id}`,
    '',
    `Background from ${fromRel}, read ${localDate(now)}. Background only: every line is asked again in the intake.`,
  ];
  const texts = [];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8').replace(/\r/g, '');
    texts.push(text);
    const { headings, unchecked } = outline(text);
    out.push('', `## ${basename(rel)}`);
    if (headings.length) {
      const top = Math.min(...headings.map((h) => h.level));
      out.push('Headings:', ...headings.map((h) => `${'  '.repeat(h.level - top)}- ${h.text}`));
    }
    if (unchecked.length) out.push('Unchecked:', ...unchecked);
    if (!headings.length && !unchecked.length) out.push('(no headings, no unchecked items)');
  }
  out.push('', '## Possibly landed', ...landed(root, statSync(abs).isDirectory() ? fromRel : dirname(fromRel), texts));
  return out.join('\n') + '\n';
}

function outline(text) {
  const headings = [];
  const unchecked = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2] });
    else if (/^\s*[-*] \[ \] \S/.test(line)) unchecked.push(line.replace(/^(\s*)\* /, '$1- '));
  }
  return { headings, unchecked };
}

// Best effort: words in the change that name an existing repo path outside openspec/.
function namedPaths(root, texts) {
  const out = new Set();
  for (const t of texts) {
    for (let tok of t.split(/[\s`'"()<>[\],;|]+/)) {
      tok = tok.replace(/^\.\//, '').replace(/#.*$/, '').replace(/:\d+$/, '').replace(/[.:;!?*]+$/, '');
      if (!tok || /^[a-z][a-z0-9+.-]*:/i.test(tok) || tok.startsWith('/') || tok.split('/').includes('..')) continue;
      if (!tok.includes('/') && !/\.[A-Za-z0-9]+$/.test(tok)) continue;
      if (tok === 'openspec' || tok.startsWith('openspec/') || tok.startsWith('.git/')) continue;
      if (existsSync(join(root, tok))) out.add(tok);
    }
  }
  return [...out].sort();
}

// `git log --since=<the change's first commit> -- <the files it names>`.
function landed(root, changeRel, texts) {
  const paths = namedPaths(root, texts);
  if (!paths.length) return ['The change names no file of the repo.'];
  let since = '';
  try {
    since = git(root, ['log', '--format=%cI', '--', changeRel]).trim().split('\n').pop();
  } catch {
    since = '';
  }
  if (!since) return [`The change is not committed, so there is no date to look from. Files it names: ${paths.join(', ')}.`];
  let lines = [];
  try {
    lines = git(root, ['log', `--since=${since}`, '--format=%h %s', '--', ...paths]).split('\n').filter(Boolean);
  } catch {
    return [`git log failed for ${paths.join(', ')}.`];
  }
  const head = `Commits since ${since.slice(0, 10)} (the change's first commit) that touch files it names (${paths.join(', ')}):`;
  if (!lines.length) return [head, '(none)'];
  const shown = lines.slice(0, LANDED_MAX).map((l) => `- ${l}`);
  if (lines.length > LANDED_MAX) shown.push(`- ... and ${lines.length - LANDED_MAX} more`);
  return [head, ...shown];
}

// `k intake aspects <id>`: the loaded aspects, each with the plugin's guess whether it applies to the task.
export async function aspects(ws, id) {
  const p = taskPaths(ws, id);
  if (!existsSync(p.task)) throw refuse(`unknown task ${id}: ${p.task} does not exist`);
  const task = { id, text: readFileSync(p.task, 'utf8') };
  const out = [];
  for (const a of await aspectsOf(ws, task)) {
    out.push({
      id: a.id,
      title: a.title ?? null,
      question: a.question ?? null,
      edgeCases: a.edgeCases || [],
      sources: a.sources || [],
      applies: typeof a.appliesWhen === 'function' ? await a.appliesWhen(task) : null,
    });
  }
  return out;
}

function intakeLog(ws, id) {
  const p = taskPaths(ws, id);
  const file = join(p.dir, 'intake.md');
  if (!existsSync(file)) throw refuse(`${id} has no intake.md: k intake start ${id}`);
  return { file, log: readFileSync(file, 'utf8') };
}

const questionId = (q) => {
  const m = /^(?:Q-)?([1-9]\d*)$/i.exec(String(q ?? '').trim());
  if (!m) throw usage(`not a question id: ${q} (want Q-n)`);
  return `Q-${m[1]}`;
};

// `k intake question <id> --topic <topic> "<text>"` → 'Q-n', the next number.
export function question(ws, id, topic, text, now = new Date()) {
  const { file, log } = intakeLog(ws, id);
  const body = oneLine(text);
  if (!body) throw usage('a question needs its text');
  const n = Math.max(0, ...[...intakeQuestions(log)].map((q) => Number(q.slice(2)))) + 1;
  appendFileSync(file, `\n### Q-${n} ${oneLine(topic) || 'general'}\nAsked ${localDate(now)}: ${body}\n`);
  return `Q-${n}`;
}

// `k intake answer <id> Q-n "<verbatim>" --ruling "<ruling>"`: the owner's words as typed, quoted, and the
// ruling they produced. A changed mind is a new answer entry; nothing is ever rewritten.
export function answer(ws, id, q, verbatim, ruling, now = new Date()) {
  const { file, log } = intakeLog(ws, id);
  const qid = questionId(q);
  if (!intakeQuestions(log).has(qid)) throw refuse(`${id} has no ${qid} in intake.md: ask it first (k intake question)`);
  const words = String(verbatim ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!words.trim()) throw usage("an answer needs the owner's words, verbatim");
  const rule = oneLine(ruling);
  if (!rule) throw usage('an answer needs its ruling, such as "→ AC-2"');
  const date = localDate(now);
  const quoted = words.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  appendFileSync(file, `\n#### ${qid} answer, ${date}\n${quoted}\n\nRuling: ${rule}\n`);
  return { q: qid, date, tag: `[owner ${date} ${qid}]` };
}

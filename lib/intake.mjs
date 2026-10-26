import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localDate } from './approval.mjs';
import { moveDraft, notAccepted, parseDraft } from './drafts.mjs';
import { refuse, usage } from './errors.mjs';
import { git } from './git.mjs';
import { intakeQuestions, parseTask } from './task.mjs';
import { aspectsOf, taskPaths } from './workspace.mjs';

// The intake's ledger (intake.md §2, §4): the skeleton, the background, and the append-only interview log.

const TEMPLATE = new URL('../templates/task.md', import.meta.url);
const CHANGE_FILES = ['proposal.md', 'tasks.md', 'design.md'];
const DRAFT = /^kirunak\/drafts\/([^/]+)\.md$/;
const LANDED_MAX = 30;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// `k intake start <id> [--from <path>] [--title "..."]`: the draft task.md, an empty intake.md, and with
// `from` a notes.md of background. Commits nothing: the model commits the intake once `k check` passes.
// `--from kirunak/drafts/<slug>.md` takes a draft (kirunak-drafts AC-6): it must be the draft of this id, and it moves
// into the task's folder as draft.md (git mv, staged and not committed; a plain rename when it was never added), so
// `k drafts` lists it no more and git keeps its history. Like an openspec change, it is background, never a source.
// A bug's draft (`bug-of: <task>`) adds to notes.md the finished task's lines for one proposal (kirunak-spikes AC-1).
export async function start({ ws, id, from, title, now = new Date() }) {
  const p = taskPaths(ws, id);
  const fromRel = from ? inRepo(p.root, from) : null;
  const draft = fromRel && DRAFT.test(fromRel) ? readDraft(ws, p, fromRel) : null;
  if (existsSync(p.dir)) throw refuse(`${id} exists already: ${p.dir}`);
  const name = oneLine(title) || draft?.title || p.slug.replace(/-/g, ' ');
  const list = await aspectsOf(ws, { id, text: name });
  if (!list.length) throw refuse('no checklist plugin is loaded: the workspace module must list one under plugins');
  if (fromRel && !draft && !existsSync(join(p.root, fromRel))) throw refuse(`--from ${from} does not exist in ${p.root}`);
  const notes = draft ? draftBackground(p, fromRel, draft, now) : fromRel ? background(p.root, fromRel, id, now) : null;

  const fill = {
    id,
    title: name,
    created: localDate(now),
    from: draft ? p.rel('draft.md') : fromRel,
    aspects: list.map((a) => `- ${a.id}: ? [open]`).join('\n'),
  };
  let text = readFileSync(TEMPLATE, 'utf8');
  if (!fromRel) text = text.replace(/^from: \{\{from\}\}\n/m, '');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.task, text.replace(/\r/g, '').replace(/\n*$/, '\n'));
  writeFileSync(join(p.dir, 'intake.md'), `# Intake: ${id}\n`);
  if (notes) writeFileSync(join(p.dir, 'notes.md'), notes);
  if (!draft) return { dir: p.dir, aspects: list.length };
  let staged;
  try {
    staged = moveDraft(p.root, fromRel, p.rel('draft.md'));
  } catch (e) {
    rmSync(p.dir, { recursive: true, force: true });
    throw refuse(`moving the draft ${fromRel} to ${p.rel('draft.md')} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  return { dir: p.dir, aspects: list.length, draft: p.rel('draft.md'), staged };
}

// A path inside the repo, relative to its root, with forward slashes.
function inRepo(root, path) {
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw refuse(`--from ${path} is not inside the repo ${root}`);
  return rel.split(sep).join('/');
}

// The draft at fromRel, refused unless it is this id's own draft and still waits in kirunak/drafts/; a bug's, unless
// its task still exists and is accepted (kirunak-spikes AC-1, the check of E-1, E-2 and E-4), so a refusal moves and
// writes nothing. `bug` is that task's paths, null for a plain draft.
function readDraft(ws, p, fromRel) {
  const placed = `${p.repo}/${DRAFT.exec(fromRel)[1]}`;
  if (placed !== p.id) throw refuse(`--from ${fromRel} is the draft ${placed}, not ${p.id}: k intake start ${placed} --from ${fromRel}`);
  const abs = join(p.root, fromRel);
  if (!existsSync(abs)) {
    const taken = existsSync(join(p.dir, 'draft.md')) ? `its intake started already, and it is ${p.rel('draft.md')}` : 'dropped, or its intake started elsewhere';
    throw refuse(`the draft ${p.id} is gone: ${fromRel} does not exist in ${p.root} (${taken}); k drafts lists the drafts that wait`);
  }
  const parsed = parseDraft(readFileSync(abs, 'utf8'));
  const own = parsed.front.id || placed;
  if (own !== p.id) throw refuse(`--from ${fromRel} is the draft ${own}, not ${p.id}: its front matter says id: ${own}`);
  if (!('bug-of' in parsed.front)) return { ...parsed, title: oneLine(parsed.front.title), bug: null };
  const of = oneLine(parsed.front['bug-of']);
  const why = notAccepted(ws, of);
  if (why) throw refuse(`the bug ${p.id} cannot start its intake: ${why}`);
  return { ...parsed, title: oneLine(parsed.front.title), bug: taskPaths(ws, of) };
}

// notes.md from a draft: where it was and is, its headings and its numbered questions, as background only (R26); a
// bug's, the finished task's lines before them.
function draftBackground(p, fromRel, draft, now) {
  const written = draft.front.written ? `, written ${draft.front.written}` : '';
  const out = [
    `# Notes: ${p.id}`,
    '',
    `Background from the draft ${fromRel}${written}, now ${p.rel('draft.md')}, read ${localDate(now)}. ` +
      'Background only: nothing in a draft is a ruling, and every line is asked again in the intake, starting from its questions.',
    '',
    ...(draft.bug ? bugBackground(draft.bug) : []),
    '## draft.md',
  ];
  if (draft.sections.length) out.push('Headings:', ...draft.sections.map((x) => `- ${x.name}`));
  const asked = draft.sections.find((x) => x.name === 'Questions');
  const numbered = (asked?.lines ?? []).map((l) => l.text.trim()).filter((t) => /^\d+\.\s+\S/.test(t));
  if (numbered.length) out.push('Questions:', ...numbered);
  if (!draft.sections.length && !numbered.length) out.push('(no headings, no questions)');
  return out.join('\n') + '\n';
}

// A bug's part of notes.md (kirunak-spikes AC-1): whose bug it is, and that task's Edge cases, Out of scope and
// Aspects lines as they stand in its task.md, in whichever repo, for the intake's one proposal; a no asks each (E-3).
function bugBackground(t) {
  const { sections } = parseTask(readFileSync(t.task, 'utf8'));
  const out = [
    `The draft is a bug of ${t.id}, a task accepted already.`,
    '',
    `## The lines of ${t.id}, for the intake's one proposal (background only)`,
    `As they stand in ${t.rel('task.md')}, in ${t.repo}. After the goal, the intake proposes them together for one yes ` +
      'or no; on a no, it asks each one alone, like any line of a draft.',
  ];
  for (const [name, key] of [['Edge cases', 'e'], ['Out of scope', 'o'], ['Aspects', 'aspects']]) {
    if (!sections[key].length) out.push(`${name}: none`);
    else out.push(`${name}:`, ...sections[key].map((it) => (it.paragraph ? it.raw : `- ${it.raw}`)));
  }
  return [...out, ''];
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

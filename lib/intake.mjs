import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { localDate } from './approval.mjs';
import { bugPaths, reviewing } from './bugs.mjs';
import { items, moveDraft, notAccepted, parseDraft } from './drafts.mjs';
import { refuse, usage } from './errors.mjs';
import { git } from './git.mjs';
import { intakeQuestions, parseTask } from './task.mjs';
import { aspectsOf, taskPaths } from './workspace.mjs';

// The intake's ledger (intake.md §2, §4): the skeleton, the background, and the append-only interview log.

const TEMPLATE = new URL('../templates/task.md', import.meta.url);
const CHANGE_FILES = ['proposal.md', 'tasks.md', 'design.md'];
const DRAFT = /^kirunak\/drafts\/([^/]+)\.md$/;
const BUG = /^kirunak\/bugs\/([^/]+)\.md$/;
const PROPOSED = /^\s+Proposed:\s*\S/;
const LANDED_MAX = 30;

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// `k intake start <id> [--from <path>] [--title "..."]`: the draft task.md, an empty intake.md, and with
// `from` a notes.md of background. Commits nothing: the model commits the intake once `k check` passes.
// `--from kirunak/drafts/<slug>.md` takes a draft (kirunak-drafts AC-6): it must be the draft of this id, and it moves
// into the task's folder as draft.md (git mv, staged and not committed; a plain rename when it was never added), so
// `k drafts` lists it no more and git keeps its history. Like an openspec change, it is background, never a source.
// A draft is no bug (gulnya/kirunak-bugs AC-1): one naming `bug-of:` is refused, naming `k bug from`.
// `--from kirunak/bugs/<slug>.md` is Start fix (gulnya/kirunak-bugs AC-8): the bug of this id moves in the same way, as
// bug.md, its folder of records (kirunak/bugs/<slug>/) with it as bug/, and notes.md splits its questions into those
// with a proposed answer, for the intake's first question, and the open ones; a bug of a task adds that task's lines
// for the same first question (R29, kirunak-spikes AC-1).
export async function start({ ws, id, from, title, now = new Date() }) {
  const p = taskPaths(ws, id);
  const fromRel = from ? inRepo(p.root, from) : null;
  if (fromRel?.startsWith('kirunak/bugs/') && !BUG.test(fromRel)) {
    throw refuse(`--from ${fromRel} is not a bug: a bug is kirunak/bugs/<slug>.md, k intake start ${id} --from kirunak/bugs/${p.slug}.md`);
  }
  const bug = fromRel && BUG.test(fromRel) ? readBug(ws, p, fromRel) : null;
  const draft = fromRel && DRAFT.test(fromRel) ? readDraft(ws, p, fromRel) : null;
  const taken = bug ?? draft;
  if (existsSync(p.dir)) throw refuse(`${id} exists already: ${p.dir}`);
  const name = oneLine(title) || taken?.title || p.slug.replace(/-/g, ' ');
  const list = await aspectsOf(ws, { id, text: name });
  if (!list.length) throw refuse('no checklist plugin is loaded: the workspace module must list one under plugins');
  if (fromRel && !taken && !existsSync(join(p.root, fromRel))) throw refuse(`--from ${from} does not exist in ${p.root}`);
  const notes = bug ? bugBackground(p, fromRel, bug, now)
    : draft ? draftBackground(p, fromRel, draft, now) : fromRel ? background(p.root, fromRel, id, now) : null;

  const fill = {
    id,
    title: name,
    created: localDate(now),
    from: bug ? p.rel('bug.md') : draft ? p.rel('draft.md') : fromRel,
    aspects: list.map((a) => `- ${a.id}: ? [open]`).join('\n'),
  };
  let text = readFileSync(TEMPLATE, 'utf8');
  if (!fromRel) text = text.replace(/^from: \{\{from\}\}\n/m, '');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.task, text.replace(/\r/g, '').replace(/\n*$/, '\n'));
  writeFileSync(join(p.dir, 'intake.md'), `# Intake: ${id}\n`);
  if (notes) writeFileSync(join(p.dir, 'notes.md'), notes);
  if (bug) return { dir: p.dir, aspects: list.length, ...moveBug(p, bug) };
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

// The draft at fromRel, refused unless it is this id's own draft and still waits in kirunak/drafts/, so a refusal moves
// and writes nothing. A draft naming `bug-of:` is a bug left among the drafts (gulnya/kirunak-bugs AC-1): refused,
// naming `k bug from`, which moves it into kirunak/bugs/, and the intake that then takes it.
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
  if ('bug-of' in parsed.front) {
    throw refuse(`--from ${fromRel} is a bug, not a draft: it names bug-of. \`k bug from ${p.id}\` moves it into ` +
      `kirunak/bugs/, then k intake start ${p.id} --from kirunak/bugs/${p.slug}.md`);
  }
  return { ...parsed, title: oneLine(parsed.front.title) };
}

// The bug at fromRel (gulnya/kirunak-bugs AC-8), refused unless it is this id's own bug and still waits in
// kirunak/bugs/, no Review & merge of it runs (E-3: that one may merge its fix and close it), and the task it names,
// if any, still exists and is accepted (R29, kirunak-spikes E-1, E-2, E-4), so a refusal moves and writes nothing.
// `paths` are the bug's, `task` the paths of the task it names, null when it names none.
function readBug(ws, p, fromRel) {
  const placed = `${p.repo}/${BUG.exec(fromRel)[1]}`;
  if (placed !== p.id) throw refuse(`--from ${fromRel} is the bug ${placed}, not ${p.id}: k intake start ${placed} --from ${fromRel}`);
  const b = bugPaths(ws, p.id);
  if (!existsSync(b.path)) {
    const taken = existsSync(join(p.dir, 'bug.md')) ? `its intake started already, and it is ${p.rel('bug.md')}` : 'merged, dropped, or its intake started elsewhere';
    throw refuse(`the bug ${p.id} is gone: ${fromRel} does not exist in ${p.root} (${taken}); k bugs lists the bugs that wait`);
  }
  const parsed = parseDraft(readFileSync(b.path, 'utf8'));
  const own = parsed.front.id || placed;
  if (own !== p.id) throw refuse(`--from ${fromRel} is the bug ${own}, not ${p.id}: its front matter says id: ${own}`);
  const run = reviewing(ws.home, p.id);
  if (run) {
    const since = run.started ? `, started ${run.started}` : '';
    throw refuse(`the bug ${p.id} cannot start its intake: its Review & merge runs (pid ${run.pid}${since}) and may merge ` +
      'its fix and close it; k bugs shows its result once it ends');
  }
  let task = null;
  if ('bug-of' in parsed.front) {
    const of = oneLine(parsed.front['bug-of']);
    const why = notAccepted(ws, of);
    if (why) throw refuse(`the bug ${p.id} cannot start its intake: ${why}`);
    task = taskPaths(ws, of);
  }
  return { ...parsed, title: oneLine(parsed.front.title), paths: b, task };
}

// The bug into the task's folder (AC-8), as a draft moves: bug.md by git mv (a rename when it was never added), and its
// folder of records, when it has one, as bug/. A failed move puts the bug back and removes the task's folder.
function moveBug(p, bug) {
  const b = bug.paths;
  const records = existsSync(b.dir) ? p.rel('bug') : null;
  let staged;
  try {
    staged = moveDraft(p.root, b.rel, p.rel('bug.md'));
    if (records) moveDraft(p.root, b.dirRel, records);
  } catch (e) {
    if (existsSync(join(p.dir, 'bug.md'))) moveDraft(p.root, p.rel('bug.md'), b.rel);
    rmSync(p.dir, { recursive: true, force: true });
    throw refuse(`moving the bug ${b.rel} to ${p.rel('bug.md')} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
  return { bug: p.rel('bug.md'), records, staged };
}

// notes.md from a draft: where it was and is, its headings and its numbered questions, as background only (R26).
function draftBackground(p, fromRel, draft, now) {
  const written = draft.front.written ? `, written ${draft.front.written}` : '';
  const out = [
    `# Notes: ${p.id}`,
    '',
    `Background from the draft ${fromRel}${written}, now ${p.rel('draft.md')}, read ${localDate(now)}. ` +
      'Background only: nothing in a draft is a ruling, and every line is asked again in the intake, starting from its questions.',
    '',
    '## draft.md',
  ];
  if (draft.sections.length) out.push('Headings:', ...draft.sections.map((x) => `- ${x.name}`));
  const asked = draft.sections.find((x) => x.name === 'Questions');
  const numbered = (asked?.lines ?? []).map((l) => l.text.trim()).filter((t) => /^\d+\.\s+\S/.test(t));
  if (numbered.length) out.push('Questions:', ...numbered);
  if (!draft.sections.length && !numbered.length) out.push('(no headings, no questions)');
  return out.join('\n') + '\n';
}

// notes.md from a bug (AC-8): where it was and is, its records, the task it names with that task's lines, its headings,
// its fix written, then its questions as the intake asks them: those with a `Proposed:` line, all in its first
// question, and the open ones, each alone. Each question is copied whole, its indented lines with it.
function bugBackground(p, fromRel, bug, now) {
  const b = bug.paths;
  const written = bug.front.written ? `, written ${bug.front.written}` : '';
  const out = [
    `# Notes: ${p.id}`,
    '',
    `Background from the bug ${fromRel}${written}, now ${p.rel('bug.md')}, read ${localDate(now)}. ` +
      'Background only: nothing in a bug is a ruling, and every line is asked again in the intake: first its proposed ' +
      'answers, all in one question, then each open question alone.',
    '',
  ];
  if (existsSync(b.dir)) out.push(`Its records, from ${b.dirRel}/, are now in ${p.rel('bug')}/: ${filesUnder(b.dir).join(', ') || 'none'}.`, '');
  if (bug.task) out.push(...taskLines(bug.task));
  out.push('## bug.md');
  if (bug.sections.length) out.push('Headings:', ...bug.sections.map((x) => `- ${x.name}`));
  const fix = bug.sections.find((x) => x.name === 'Fix written');
  if (fix?.lines.length) {
    const repo = oneLine(bug.front['fix-repo']) || p.repo;
    out.push(`Fix written, on ${b.branch} in ${repo}:`, ...fix.lines.map((l) => l.text.replace(/\s+$/, '')));
  }
  const asked = bug.sections.find((x) => x.name === 'Questions');
  const questions = asked ? items(asked, /^\d+\.\s+\S/, () => {}).map((q) => [q.m.input, ...q.more.map((l) => l.text)].map((t) => t.replace(/\s+$/, ''))) : [];
  const proposed = questions.filter((q) => q.some((t) => PROPOSED.test(t)));
  const open = questions.filter((q) => !proposed.includes(q));
  out.push('', "## Proposed answers, for the intake's first question, every one in its own text");
  out.push(...(proposed.length ? proposed.flat() : ['none']));
  out.push('', '## Open questions, each asked alone after it');
  out.push(...(open.length ? open.flat() : ['none']));
  return out.join('\n') + '\n';
}

// Every file under `dir`, relative to it, sorted.
function filesUnder(dir, at = '') {
  return readdirSync(join(dir, at), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))
    .flatMap((e) => (e.isDirectory() ? filesUnder(dir, join(at, e.name)) : [join(at, e.name)]));
}

// A bug's task part of notes.md (R29, kirunak-spikes AC-1): whose bug it is, and that task's Edge cases, Out of scope
// and Aspects lines as they stand in its task.md, in whichever repo, proposed in the intake's first question with the
// bug's own proposed answers; a no asks each (E-3).
function taskLines(t) {
  const { sections } = parseTask(readFileSync(t.task, 'utf8'));
  const out = [
    `The bug is a bug of ${t.id}, a task accepted already.`,
    '',
    `## The lines of ${t.id}, for the intake's first question (background only)`,
    `As they stand in ${t.rel('task.md')}, in ${t.repo}. The intake proposes them in its first question, with the ` +
      "bug's proposed answers, for one yes or no; on a no, it asks each one alone.",
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

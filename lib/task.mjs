import { isSourced, splitTags, validDate } from './source.mjs';

// The task grammar (task-files.md §2).

export const SECTIONS = [
  ['Goal', 'goal'],
  ['Acceptance criteria', 'ac'],
  ['Edge cases', 'e'],
  ['Out of scope', 'o'],
  ['Decisions', 'd'],
  ['Aspects', 'aspects'],
  ['Open questions', 'q'],
];
const KEY_OF = Object.fromEntries(SECTIONS);
const NAME_OF = Object.fromEntries(SECTIONS.map(([n, k]) => [k, n]));
const PREFIX_OF = { ac: 'AC', e: 'E', o: 'O', d: 'D', q: 'Q' };
const ITEM_ID = /^(AC|E|O|D|Q)-([1-9]\d*)\b\s*/;
const ASPECT = /^([a-z0-9][a-z0-9-]*):\s*(.*)$/;

// { front, sections: { goal, ac, e, o, d, aspects, q }, lines, headings, stray, crlf }
// Each item: { line, raw, text, id, n, body, tags, bad }; an aspect item adds { aspect, ruling }.
export function parseTask(text) {
  const crlfAt = text.indexOf('\r');
  const crlf = crlfAt < 0 ? 0 : text.slice(0, crlfAt).split('\n').length;
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
  const sections = Object.fromEntries(SECTIONS.map(([, k]) => [k, []]));
  const headings = [];
  const stray = [];
  let key = null;
  let item = null;
  const close = () => {
    if (item) {
      finish(item, key);
      (key ? sections[key] : stray).push(item);
    }
    item = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith('###')) {
      close();
      key = KEY_OF[h[1]] || null;
      headings.push({ name: h[1], key, line: i + 1 });
      continue;
    }
    if (line.trim() === '') {
      close();
      continue;
    }
    if (line.startsWith('- ')) {
      close();
      item = { line: i + 1, raw: line.slice(2) };
    } else if (item && (/^\s{2,}\S/.test(line) || !item.list)) {
      item.raw += ' ' + line.trim();
      continue;
    } else {
      close();
      item = { line: i + 1, raw: line.trim(), paragraph: true };
    }
    item.list = !item.paragraph;
  }
  close();
  return { front, frontEnd, sections, lines, headings, stray, crlf };
}

function finish(item, key) {
  const { text, tags, bad } = splitTags(item.raw);
  item.tags = tags;
  item.bad = bad;
  item.text = text;
  const m = ITEM_ID.exec(text);
  if (m && item.list) {
    item.id = `${m[1]}-${m[2]}`;
    item.prefix = m[1];
    item.n = Number(m[2]);
    item.body = text.slice(m[0].length);
  }
  if (key === 'aspects' && item.list) {
    const a = ASPECT.exec(text);
    if (a) {
      item.aspect = a[1];
      item.ruling = a[2].trim();
    }
  }
  delete item.list;
}

function allItems(parsed) {
  return [...SECTIONS.flatMap(([, k]) => parsed.sections[k]), ...parsed.stray];
}

export function idsOf(parsed) {
  return new Set(allItems(parsed).filter((x) => x.id).map((x) => x.id));
}

// [{ line, problem }]: every rule of task-files.md §2, 1 to 5.
// opts.removed: ids an applied amendment removed (their numbers are gaps that stay, rule 2).
// opts.intakeQs: the Q-n entries intake.md has, to check that every owner tag points at one.
// opts.id: the id the task must carry in its front matter.
export function checkTask(parsed, aspectIds = [], opts = {}) {
  const problems = [];
  const add = (line, problem) => problems.push({ line, problem });
  const removed = new Set(opts.removed || []);
  const end = parsed.lines.length;

  if (parsed.crlf) add(parsed.crlf, 'CRLF line endings: a task is LF only');

  // Front matter (rule 3).
  const f = parsed.front;
  if (!parsed.frontEnd) add(1, 'no front matter: the task starts with --- and id, title, created');
  for (const k of ['id', 'title', 'created']) if (parsed.frontEnd && !f[k]) add(1, `front matter has no ${k}`);
  if (f.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[a-z0-9-]{1,40}$/.test(f.id)) add(1, `id ${f.id} is not <repo>/<slug>`);
  if (opts.id && f.id && f.id !== opts.id) add(1, `id ${f.id} is not this task's id ${opts.id}`);
  if (f.created && !validDate(f.created)) add(1, `created ${f.created} is not a date YYYY-MM-DD`);

  // Sections: all seven, once each, in order (rule 3).
  let last = -1;
  const seen = new Set();
  for (const h of parsed.headings) {
    if (!h.key) {
      add(h.line, `unknown section "## ${h.name}": the sections are ${SECTIONS.map(([n]) => n).join(', ')}`);
      continue;
    }
    const at = SECTIONS.findIndex(([, k]) => k === h.key);
    if (seen.has(h.key)) add(h.line, `section ${h.name} appears twice`);
    else if (at < last) add(h.line, `section ${h.name} is out of order: ${SECTIONS.map(([n]) => n).join(', ')}`);
    seen.add(h.key);
    last = Math.max(last, at);
  }
  for (const [name, key] of SECTIONS) if (!seen.has(key)) add(end, `missing section ## ${name}`);
  for (const s of parsed.stray) add(s.line, 'text before the first section: it belongs under a ## heading');

  // Goal and acceptance criteria are not empty.
  if (seen.has('goal') && parsed.sections.goal.length === 0) add(headingLine(parsed, 'goal'), 'Goal is empty');
  if (seen.has('ac') && parsed.sections.ac.length === 0) {
    add(headingLine(parsed, 'ac'), 'Acceptance criteria needs at least one AC-n line');
  }

  // Open questions: a Q-n line anywhere keeps the task from ready (rules 1, 5).
  for (const it of allItems(parsed)) {
    if (it.id && it.prefix === 'Q') add(it.line, `${it.id} is open: the task cannot become ready while a question is open`);
  }
  for (const it of parsed.sections.q) {
    if (it.prefix !== 'Q') add(it.line, 'only Q-n lines belong under Open questions');
  }

  // Numbered sections (rule 2).
  for (const key of ['ac', 'e', 'o', 'd']) {
    const prefix = PREFIX_OF[key];
    const nums = new Map();
    for (const it of parsed.sections[key]) {
      if (it.prefix === 'Q') continue;
      if (!it.id) {
        add(it.line, `a line under ${NAME_OF[key]} needs its number: ${prefix}-n`);
        continue;
      }
      if (it.prefix !== prefix) {
        add(it.line, `${it.id} is under ${NAME_OF[key]}, which holds ${prefix}-n lines`);
        continue;
      }
      if (nums.has(it.n)) add(it.line, `${it.id} appears twice`);
      nums.set(it.n, it.line);
    }
    const max = Math.max(0, ...nums.keys(), ...[...removed].filter((r) => r.startsWith(prefix + '-')).map((r) => Number(r.split('-')[1])));
    for (let n = 1; n <= max; n++) {
      const id = `${prefix}-${n}`;
      if (!nums.has(n) && !removed.has(id)) add(headingLine(parsed, key), `${prefix} numbering has a gap: ${id} is missing`);
      if (nums.has(n) && removed.has(id)) add(nums.get(n), `${id} was removed by an amendment; a number is never reused`);
    }
  }

  // Every line names its source (rule 1).
  for (const it of allItems(parsed)) {
    if (it.prefix === 'Q') continue;
    if (it.aspect && /^\?/.test(it.ruling)) continue;
    for (const b of it.bad) add(it.line, `malformed tag ${b}: [owner YYYY-MM-DD Q-n], [research <path or URL>], [default YYYY-MM-DD], [from <path>]`);
    if (!it.tags.length && !it.bad.length) {
      add(it.line, 'no source: end the line with [owner YYYY-MM-DD Q-n], [research <path or URL>] or [default YYYY-MM-DD]');
    } else if (it.tags.length && !isSourced(it.tags)) {
      add(it.line, '[from ...] is background, not a source: add [owner ...], [research ...] or [default ...]');
    }
    if (opts.intakeQs) {
      for (const t of it.tags) {
        if (t.kind === 'owner' && !opts.intakeQs.has(t.q)) add(it.line, `${t.q} is not an entry in intake.md`);
      }
    }
  }

  // Aspects (rule 4).
  const ids = idsOf(parsed);
  const known = new Set(aspectIds);
  const ruled = new Set();
  for (const it of parsed.sections.aspects) {
    if (!it.aspect) {
      add(it.line, 'an aspect line is "- <aspect>: in (<ids>) | out (<O-n>) | n/a: <why>" with its source');
      continue;
    }
    if (ruled.has(it.aspect)) add(it.line, `aspect ${it.aspect} is ruled twice`);
    ruled.add(it.aspect);
    if (!known.has(it.aspect)) add(it.line, `aspect ${it.aspect} is not in the loaded checklist`);
    const r = it.ruling;
    let m;
    if (/^\?/.test(r)) {
      add(it.line, `aspect ${it.aspect} is open: rule it in, out or n/a`);
    } else if ((m = /^(in|out)\s*\(([^)]*)\)/.exec(r))) {
      const named = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      if (!named.length) add(it.line, `aspect ${it.aspect} is ruled ${m[1]} without naming a line`);
      for (const n of named) {
        const okPrefix = m[1] === 'in' ? /^(AC|E|D)-\d+$/ : /^O-\d+$/;
        if (!okPrefix.test(n)) add(it.line, `aspect ${it.aspect}: ${m[1]} names ${n}, which must be ${m[1] === 'in' ? 'an AC, E or D' : 'an O'} line`);
        else if (!ids.has(n)) add(it.line, `aspect ${it.aspect}: ${m[1]} names ${n}, which the task does not have`);
      }
    } else if ((m = /^n\/a\s*[:,]\s*(.*)$/.exec(r))) {
      if (!m[1].trim()) add(it.line, `aspect ${it.aspect} is n/a without a reason`);
    } else {
      add(it.line, `aspect ${it.aspect}: rule it "in (<ids>)", "out (<O-n>)" or "n/a: <why>"`);
    }
  }
  for (const a of aspectIds) {
    if (!ruled.has(a)) add(headingLine(parsed, 'aspects') || end, `aspect ${a} of the checklist is missing from Aspects`);
  }

  return problems.sort((a, b) => a.line - b.line);
}

function headingLine(parsed, key) {
  const h = parsed.headings.find((x) => x.key === key);
  return h ? h.line : parsed.lines.length;
}

export function isReady(parsed, aspectIds = [], opts = {}) {
  return parsed.sections.q.length === 0 && checkTask(parsed, aspectIds, opts).length === 0;
}

// The Q-n entries of an intake log (task-files.md §3: "### Q-n <aspect or topic>").
export function intakeQuestions(text) {
  return new Set([...text.matchAll(/^### (Q-[1-9]\d*)\b/gm)].map((m) => m[1]));
}

// The ids that applied amendments removed, from the amendment files' text.
export function removedIds(amendmentTexts) {
  const out = new Set();
  for (const t of amendmentTexts) {
    if (!/^applied:/m.test(t)) continue;
    for (const m of t.matchAll(/^- remove ((?:AC|E|O|D)-\d+)\s*$/gm)) out.add(m[1]);
  }
  return out;
}

// The week's calls: every Claude Code transcript on this machine read for its model calls and its compactions, one
// JSON line each (calls.jsonl, the rows every other part reads), and its marks: a `kind: 'mark'` row for each command
// line, Skill call and Bash call running a k or git command that says what the session turned to (bytask.mjs's kinds of
// no-step work; gulnya/usage-improve-11-22 AC-11). Every reader but bytask.mjs reads only the 'call' and 'compact' rows.
// A transcript is `<config dir>/projects/<project>/<session>.jsonl`, an agent's beside it under
// `<session>/subagents/**/agent-*.jsonl` with its `.meta.json` (workflow agents sit deeper, in workflows/wf_*/).
// A transcript cut short (its last line not whole) or one that cannot be read (not a file, refused, its first line not
// JSON) is skipped whole and counted (gulnya/k-usage E-1), never a failure.
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

// Each transcript of the projects folder, in the folders' own order: { fp, proj, session, sub, meta, workflow }.
export function transcriptsOf(projects) {
  const files = [];
  let projs;
  try {
    projs = readdirSync(projects);
  } catch {
    return files;
  }
  for (const proj of projs) {
    const pdir = join(projects, proj);
    try {
      if (!statSync(pdir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(pdir)) {
      if (f.endsWith('.jsonl')) files.push({ fp: join(pdir, f), proj, session: f.slice(0, -6), sub: null });
      const sd = join(pdir, f, 'subagents');
      let rels;
      try {
        rels = readdirSync(sd, { recursive: true });
      } catch {
        continue;
      }
      for (const rel of rels) {
        const a = basename(rel);
        if (!a.startsWith('agent-') || !a.endsWith('.jsonl')) continue;
        let meta = {};
        try {
          meta = JSON.parse(readFileSync(join(sd, rel.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
        } catch {}
        files.push({ fp: join(sd, rel), proj, session: f, sub: a.slice(0, -6), meta, workflow: rel.includes('workflows') });
      }
    }
  }
  return files;
}

const isJson = (l) => {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
};

// One transcript's lines, each given to `each`; what was wrong with it ('unreadable', 'cut short') or null.
export async function readTranscript(fp, each) {
  let fh;
  try {
    if (!statSync(fp).isFile()) return 'unreadable';
    fh = await open(fp, 'r');
  } catch {
    return 'unreadable';
  }
  let first = null, last = null;
  try {
    const rl = createInterface({ input: fh.createReadStream(), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        if (first === null) first = line;
        last = line;
      }
      each(line);
    }
  } catch {
    return 'unreadable';
  } finally {
    await fh.close().catch(() => {});
  }
  if (first !== null && !isJson(first)) return 'unreadable';
  if (last !== null && !isJson(last)) return 'cut short';
  return null;
}

// A line worth parsing for its marks: a command line, the owner's own `!` command, a Skill or a Bash call.
const MARK_HINT = /<command-name>|<bash-input>|"name":"(Skill|Bash)"/;
// The Bash commands that mark, each with its mark's `what` (a word boundary before `k`: a command's start, a space, `;`,
// `&`, `|`, `(` or `!`). A command holding several marks takes the first of this list.
const BEFORE = String.raw`(?:^|[\s;&|(!])`;
const BASH = [
  [new RegExp(`${BEFORE}k\\s+step\\s+(finish|fail)\\b`), (m) => `k step ${m[1]}`],
  [new RegExp(`${BEFORE}k\\s+bug\\s+review\\b`), () => 'k bug review'],
  [new RegExp(`${BEFORE}k\\s+run\\b[^;&|\\n]*\\s--once\\b`), () => 'k run --once'],
  [new RegExp(`${BEFORE}k\\s+intake\\b`), () => 'k intake'],
  [new RegExp(`${BEFORE}k\\s+accept\\b`), () => 'k accept'],
  [new RegExp(`${BEFORE}k\\s+start\\b`), () => 'k start'],
  [/\bgit\s+(?:-C\s+\S+\s+)?merge(?![\w-])/, () => 'git merge'],
];
export const bashMark = (cmd) => {
  for (const [re, what] of BASH) {
    const m = re.exec(String(cmd ?? ''));
    if (m) return what(m);
  }
  return null;
};

// A transcript line's marks, each its `what`: `/<name>` for a user's command line, `skill <name>` for a Skill call,
// and bashMark's for a Bash call or the owner's own `!` line (<bash-input>). A user line's tool results are not read.
export function marksOf(r) {
  const out = [], content = r?.message?.content;
  if (r?.type === 'user') {
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    for (const m of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) out.push(`/${m[1]}`);
    for (const m of text.matchAll(/<bash-input>([\s\S]*?)<\/bash-input>/g)) {
      const what = bashMark(m[1]);
      if (what) out.push(what);
    }
  } else if (r?.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      if (b.name === 'Skill' && b.input?.skill) out.push(`skill ${b.input.skill}`);
      else if (b.name === 'Bash') {
        const what = bashMark(b.input?.command);
        if (what) out.push(what);
      }
    }
  }
  return out;
}

// The project folder as the rows name it: the roots' parent folder gone (`-Users-me-sources-katyafm` → `katyafm`).
export const projName = (prefixes) => (proj) => {
  const p = prefixes.find((x) => proj.includes(x));
  return p ? proj.replace(p, '') : proj;
};

// The rows since `since` (ms), as JSON lines in the transcripts' order, and the transcripts skipped:
// { lines, skipped: { cut, unreadable, files: Set of paths } }. Transcripts last written before `since` are not read.
// Of a transcript's marks before `since`, its last is kept: the kind of the window's first calls is the session's.
export async function scanCalls(projects, since, { prefixes = [] } = {}) {
  const name = projName(prefixes);
  const lines = [], skipped = { cut: 0, unreadable: 0, files: new Set() };
  for (const file of transcriptsOf(projects)) {
    let mtime;
    try {
      mtime = statSync(file.fp).mtimeMs;
    } catch {
      mtime = Infinity;
    }
    if (mtime < since) continue;
    const seen = new Map(), rows = [], proj = name(file.proj);
    let early = null;
    const wrong = await readTranscript(file.fp, (line) => {
      if (MARK_HINT.test(line)) {
        try {
          const r = JSON.parse(line);
          for (const what of marksOf(r)) {
            const mark = { kind: 'mark', ts: r.timestamp, proj, session: file.session, sub: file.sub, what };
            if (Date.parse(r.timestamp) >= since) rows.push(mark);
            else early = mark;
          }
        } catch {}
      }
      if (!line.includes('"usage"')) {
        // One row per compaction, its boundary line (the summary line after it is the same compaction).
        if (line.includes('"compact_boundary"')) {
          try {
            const r = JSON.parse(line), c = r.compactMetadata || {};
            if (r.subtype === 'compact_boundary') rows.push(JSON.stringify({ kind: 'compact', ts: r.timestamp, proj, session: file.session, sub: file.sub, trigger: c.trigger, pre: c.preTokens }));
          } catch {}
        }
        return;
      }
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return;
      }
      const m = r.message;
      if (!m || !m.usage || r.type !== 'assistant') return;
      // Claude Code writes one message over several lines, one per content block, each with a usage: input and the
      // cache agree on every line, but a first line's output can be partial and a later one's the full count (an
      // agent's often were, the week to 2026-10-25). So a message is one row, its time, input and cache the first
      // line's, its output and thinking the line's with the largest output, wherever in the file it is. A message
      // whose first line is before `since` is not this window's (gulnya/usage-first-line-output).
      const id = m.id || r.requestId;
      const u = m.usage;
      if (seen.has(id)) {
        const row = seen.get(id);
        if (row && (u.output_tokens || 0) > row.out) {
          row.out = u.output_tokens || 0;
          row.think = u.output_tokens_details?.thinking_tokens || 0;
        }
        return;
      }
      const t = Date.parse(r.timestamp);
      if (!(t >= since)) {
        seen.set(id, null);
        return;
      }
      const cc = u.cache_creation || {};
      const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
      const cw5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
      const row = {
        kind: 'call', ts: r.timestamp, proj, session: file.session,
        sub: file.sub, agentType: file.meta?.agentType, desc: file.meta?.description, model: m.model,
        advisor: r.advisorModel, inp: u.input_tokens || 0, cw5, cw1h, cr: u.cache_read_input_tokens || 0,
        out: u.output_tokens || 0, think: u.output_tokens_details?.thinking_tokens || 0,
        iters: (u.iterations || []).map((i) => i.type).filter((x) => x !== 'message'),
      };
      seen.set(id, row);
      rows.push(row);
    });
    if (early) rows.unshift(early);
    if (wrong) {
      skipped[wrong === 'cut short' ? 'cut' : 'unreadable']++;
      skipped.files.add(file.fp);
    } else for (const r of rows) lines.push(typeof r === 'string' ? r : JSON.stringify(r));
  }
  return { lines, skipped };
}

#!/usr/bin/env node
// The reader (kirunak-docs-promo S-1 §4, §6): renders a raw session's terminal stream through a headless terminal at
// the manifest's size and writes the public part the video's scenes read and E-3's test checks:
// - lines.jsonl: one line per distinct text that appeared on a screen row, in order of first appearance, with a stable
//   id, its time from the session's start (t), the last time it was shown (tEnd) and the screen row it first had;
// - dialogs.jsonl: the mod's dialogs and the intake's questions (AskUserQuestion in the transcript), one shape;
// - manifest.json: the raw manifest with `start` as ISO UTC and nothing of the raw folder.
// `node promo/capture/read.mjs <raw session dir> --out <public dir> [--deny <file>] [--check]`; with --check it also
// checks the session complete and writes complete.json into the raw folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import xterm from '@xterm/headless';

import { check, denyWords, report } from './check.mjs';

const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A spinner's frames and a redraw are the same line: its glyphs leave the text compared, never the text kept.
const SPINNER = /[⠀-⣿✻✽✶✳✢·⏺◐◓◑◒]/g;
const norm = (s) => s.replace(SPINNER, '').trim();

// Renders the stream: after each chunk the screen is read, and each row's text is matched to the line it showed
// before. A row whose text is the same (spinner glyphs aside), or the same text grown (typing), keeps its line; a
// text that left one row for another the same moment keeps its line too; a cleared or replaced row ends its line.
export async function render(raw, chunks, { cols, rows, name }) {
  const term = new xterm.Terminal({ cols, rows, scrollback: 1_000_000, allowProposedApi: true });
  const lines = [];
  let open = new Map(); // the buffer and absolute row → the line it shows
  for (const c of chunks) {
    await new Promise((done) => term.write(raw.subarray(c.o, c.o + c.n), done));
    const buf = term.buffer.active;
    const seen = new Map();
    for (let r = 0; r < rows; r++) {
      const text = buf.getLine(buf.baseY + r)?.translateToString(true) ?? '';
      if (norm(text)) seen.set(`${buf.type}:${buf.baseY + r}`, { text: text.trimEnd(), r });
    }
    const next = new Map();
    const left = new Map(open);
    for (const [key, { text, r }] of seen) {
      const was = left.get(key);
      if (was && (norm(was.text) === norm(text) || norm(text).startsWith(norm(was.text)))) {
        if (norm(text) !== norm(was.text)) was.text = text;
        was.tEnd = c.t;
        next.set(key, was);
        left.delete(key);
        seen.delete(key);
      }
    }
    for (const [key, { text, r }] of seen) {
      const moved = [...left].find(([, l]) => norm(l.text) === norm(text));
      if (moved) {
        left.delete(moved[0]);
        moved[1].tEnd = c.t;
        next.set(key, moved[1]);
        continue;
      }
      const line = { id: `${name}:${String(lines.length + 1).padStart(4, '0')}`, t: c.t, tEnd: c.t, row: r, text };
      lines.push(line);
      next.set(key, line);
    }
    for (const l of left.values()) l.tEnd = c.t;
    open = next;
  }
  term.dispose();
  return lines;
}

// The intake's questions: an AskUserQuestion tool call in the transcript and the answer in its tool result.
export function intakeDialogs(transcript) {
  const asked = new Map();
  const out = [];
  for (const entry of transcript) {
    for (const part of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (part.type === 'tool_use' && part.name === 'AskUserQuestion') {
        const q = part.input?.questions?.[0] ?? {};
        const d = { t: Date.parse(entry.timestamp), command: 'AskUserQuestion', header: q.header ?? '', text: [], question: q.question ?? '', choices: (q.options ?? []).map((o) => o.label), tap: null, tAnswer: null, end: null };
        asked.set(part.id, d);
        out.push(d);
      } else if (part.type === 'tool_result' && asked.has(part.tool_use_id)) {
        const d = asked.get(part.tool_use_id);
        const answers = entry.toolUseResult?.answers;
        const answer = answers ? (answers[d.question] ?? Object.values(answers)[0]) : null;
        d.tAnswer = Date.parse(entry.timestamp);
        if (answer == null) d.end = part.is_error ? 'dismissed' : 'answered';
        else if (d.choices.includes(answer)) d.tap = answer;
        else Object.assign(d, { typed: String(answer), end: 'typed' });
      }
    }
  }
  return out;
}

// The owner's typed slash commands in the transcript, with their times.
export function typedCommands(transcript) {
  const out = [];
  for (const entry of transcript) {
    const content = typeof entry.message?.content === 'string' ? entry.message.content : '';
    const m = content.match(/<command-name>\/?([^<]+)<\/command-name>/);
    if (m && entry.type === 'user') out.push({ t: Date.parse(entry.timestamp), command: m[1].trim() });
  }
  return out;
}

export function loadRaw(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const marks = jsonl(join(dir, 'terminal.times.jsonl'));
  const tdir = join(dir, 'transcripts');
  const transcripts = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ id: basename(f, '.jsonl'), entries: jsonl(join(tdir, f)) })) : [];
  return {
    manifest,
    raw: readFileSync(join(dir, 'terminal.raw')),
    chunks: marks.filter((m) => m.n !== undefined),
    marks,
    transcripts,
    dialogs: jsonl(join(dir, 'dialogs.jsonl')),
    events: jsonl(join(dir, 'events.jsonl')),
  };
}

// What makes a session complete (§6); each problem is one line.
export function problems(s, lines, dialogs) {
  const out = [];
  const end = s.marks.find((m) => m.end);
  if (!end) out.push('the stream does not end with the shell\'s exit');
  for (const m of s.marks.filter((x) => x.resize)) out.push(`the terminal was resized to ${m.resize.join('x')} at ${m.t}`);
  if (!s.transcripts.length) out.push('no Claude Code transcript was found in the session\'s span');
  else if (!s.transcripts.some((t) => t.id === s.manifest.sessionId)) out.push(`the manifest's session ${s.manifest.sessionId} has no transcript`);
  for (const d of dialogs) if (d.tap == null && d.typed == null && d.end == null) out.push(`${d.id} has no tap and no end`);
  const typed = s.transcripts.flatMap((t) => typedCommands(t.entries));
  for (const e of s.events.filter((x) => x.kind === 'approved' || x.kind === 'accepted')) {
    const at = Date.parse(e.time);
    const verb = e.kind === 'approved' ? 'approve' : 'accept';
    const before = (x) => x <= at + 1000;
    const byDialog = s.dialogs.some((d) => typeof d.end === 'string' && d.end.startsWith(`${verb} ${e.task}`) && before(d.tAnswer));
    const byTyping = typed.some((c) => c.command === `k-${verb}` && before(c.t));
    // A verb typed at the terminal (`k approve`) is a line of the stream itself.
    const byTerminal = lines.some((l) => new RegExp(`\\bk ${verb} ${e.task.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(l.text) && before(l.t + s.manifest.start));
    if (!byDialog && !byTyping && !byTerminal) out.push(`events: ${e.kind} ${e.task} at ${e.time} has no dialog, typed command or terminal line before it`);
  }
  if (lines.some((l) => l.text.length > s.manifest.cols)) out.push('a row is wider than the manifest\'s columns');
  return out;
}

export async function read(rawDir, outDir, { deny = [], names, complete = false } = {}) {
  const s = loadRaw(rawDir);
  const { manifest } = s;
  const name = manifest.name;
  const start = manifest.start;
  const rel = (t) => (t == null ? null : t - start);
  const lines = (await render(s.raw, s.chunks, { cols: manifest.cols, rows: manifest.rows, name })).map((l) => ({ ...l, t: rel(l.t), tEnd: rel(l.tEnd) }));
  const all = [...s.dialogs.map((d) => ({ ...d, source: 'mod' })), ...s.transcripts.flatMap((t) => intakeDialogs(t.entries)).map((d) => ({ ...d, source: 'intake' }))].sort((a, b) => a.t - b.t);
  const dialogs = all.map(({ session, ...d }, i) => ({ id: `${name}:d${String(i + 1).padStart(3, '0')}`, ...d, t: rel(d.t), tAnswer: rel(d.tAnswer) }));
  const { raw, capture, ...kept } = manifest;
  const pub = { ...kept, start: new Date(start).toISOString(), end: manifest.end ? new Date(manifest.end).toISOString() : null };
  const items = [...lines.map((l) => ({ id: l.id, text: l.text })), ...dialogs.map((d) => ({ id: d.id, text: [d.command, d.header, ...d.text, d.question, ...d.choices, d.tap, d.typed, d.end].filter((x) => x != null).join('\n') })), ...Object.entries(pub).map(([k, v]) => ({ id: `manifest.${k}`, text: JSON.stringify(v) }))];
  const found = check(items, { deny, ...(names && { names }) });
  if (found.length) return { ok: false, refused: found, problems: [] };
  const missing = complete ? problems(s, lines.map((l) => ({ ...l })), dialogs) : [];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'lines.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
  writeFileSync(join(outDir, 'dialogs.jsonl'), dialogs.map((d) => JSON.stringify(d)).join('\n') + (dialogs.length ? '\n' : ''));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(pub, null, 2) + '\n');
  const counts = { lines: lines.length, dialogs: dialogs.length, events: s.events.length, first: lines[0]?.id ?? null, last: lines.at(-1)?.id ?? null, tFirst: lines[0]?.t ?? null, tLast: lines.at(-1)?.tEnd ?? null };
  if (complete && !missing.length) writeFileSync(join(rawDir, 'complete.json'), JSON.stringify({ checked: new Date().toISOString(), ...counts }, null, 2) + '\n');
  return { ok: !missing.length, refused: [], problems: missing, counts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const [rawDir] = args;
  const outDir = flag('--out');
  if (!rawDir || !outDir) {
    console.error('usage: read.mjs <raw session dir> --out <public dir> [--deny <file>] [--check]');
    process.exit(2);
  }
  const r = await read(rawDir, outDir, { deny: denyWords(flag('--deny')), complete: args.includes('--check') });
  if (r.refused.length) {
    console.error(`refused, nothing written: ${r.refused.length} item(s) hold what a capture must not:\n${report(r.refused)}`);
    process.exit(1);
  }
  const c = r.counts;
  console.log(`${c.lines} lines (${c.first} at ${c.tFirst} ms to ${c.last} at ${c.tLast} ms), ${c.dialogs} dialogs, ${c.events} events`);
  if (r.problems.length) {
    console.error(`not complete:\n${r.problems.join('\n')}`);
    process.exit(1);
  }
  if (args.includes('--check')) console.log('complete: complete.json written');
}

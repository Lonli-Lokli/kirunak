// The week's calls: every Claude Code transcript on this machine read for its model calls and its compactions, one
// JSON line each (calls.jsonl, the rows every other part reads).
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

// The project folder as the rows name it: the roots' parent folder gone (`-Users-me-sources-katyafm` → `katyafm`).
export const projName = (prefixes) => (proj) => {
  const p = prefixes.find((x) => proj.includes(x));
  return p ? proj.replace(p, '') : proj;
};

// The rows since `since` (ms), as JSON lines in the transcripts' order, and the transcripts skipped:
// { lines, skipped: { cut, unreadable, files: Set of paths } }. Transcripts last written before `since` are not read.
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
    const seen = new Set(), rows = [], proj = name(file.proj);
    const wrong = await readTranscript(file.fp, (line) => {
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
      const id = m.id || r.requestId;
      if (seen.has(id)) return;
      seen.add(id);
      const t = Date.parse(r.timestamp);
      if (!(t >= since)) return;
      const u = m.usage;
      const cc = u.cache_creation || {};
      const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
      const cw5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
      rows.push(JSON.stringify({
        kind: 'call', ts: r.timestamp, proj, session: file.session,
        sub: file.sub, agentType: file.meta?.agentType, desc: file.meta?.description, model: m.model,
        advisor: r.advisorModel, inp: u.input_tokens || 0, cw5, cw1h, cr: u.cache_read_input_tokens || 0,
        out: u.output_tokens || 0, think: u.output_tokens_details?.thinking_tokens || 0,
        iters: (u.iterations || []).map((i) => i.type).filter((x) => x !== 'message'),
      }));
    });
    if (wrong) {
      skipped[wrong === 'cut short' ? 'cut' : 'unreadable']++;
      skipped.files.add(file.fp);
    } else for (const r of rows) lines.push(r);
  }
  return { lines, skipped };
}

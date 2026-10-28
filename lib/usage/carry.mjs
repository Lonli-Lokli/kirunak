// carry.txt: what a context item really costs, its size times every later call that re-reads it.
// An item enters the cache once (1h write, 2x) and is read back (0.1x) by each later call of the same transcript until a
// compaction drops it. Weight in Opus base-input tokens, as report.txt counts it.
import { statSync } from 'node:fs';
import { mult, printer } from './common.mjs';
import { readTranscript, transcriptsOf } from './calls.mjs';

const kindOf = (b) => {
  if (b.name !== 'Bash') return b.name === 'Read' ? (b.input?.limit ? 'Read ranged' : 'Read whole') : b.name;
  const c = String(b.input?.command);
  const m = c.match(/heavy-lock|gradlew|xcodebuild|xcresult|zdymak|voice-lint|git (?:log|diff|show)|git |\bk (?:show|board|list|step)|\bk |npm |npx |node |cat |sed -n|grep|rg |find |ls /);
  return 'Bash:' + (m ? m[0].trim() : 'other');
};

// The transcripts of `projects` last written from FROM on; a transcript the week's scan skipped (`skipped`, its paths)
// is left out whole, and a line that is not JSON is passed over.
export async function carry(projects, FROM, TO, skipped = new Set()) {
  const agg = {};
  let total = 0;
  const add = (k, tok, w) => {
    const a = (agg[k] ??= { n: 0, tok: 0, w: 0 });
    a.n++; a.tok += tok; a.w += w; total += w;
  };
  for (const file of transcriptsOf(projects)) {
    const kind = file.sub ? 'sub' : 'main';
    let mtime;
    try {
      mtime = statSync(file.fp).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < Date.parse(FROM) || skipped.has(file.fp)) continue;
    // Every assistant call and compaction, in file order, and the images counted on the way.
    const names = {}, seen = new Set(), events = [], images = [];
    await readTranscript(file.fp, (l) => {
      if (!l) return;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        return;
      }
      if ((r.type === 'system' && r.subtype === 'compact_boundary') || r.isCompactSummary) { events.push({ t: 'compact' }); return; }
      const c = r.message?.content;
      if (r.type === 'assistant' && r.message?.usage) {
        const id = r.message.id || r.requestId;
        if (!seen.has(id)) { seen.add(id); events.push({ t: 'call', model: r.message.model }); }
        for (const b of Array.isArray(c) ? c : []) {
          if (b.type === 'tool_use') names[b.id] = kindOf(b);
          if (r.timestamp < FROM || r.timestamp >= TO) continue;
          // The assistant's own content is re-read too: its writes, its text, its kept thinking.
          const tok = b.type === 'tool_use' ? JSON.stringify(b.input ?? {}).length / 4 : b.type === 'text' ? b.text.length / 4 : b.type === 'thinking' ? (b.thinking || '').length / 4 : 0;
          if (tok) events.push({ t: 'item', k: kind + ' assistant ' + (b.type === 'tool_use' ? (/^(Write|Edit|Agent|SendMessage)$/.test(b.name) ? b.name : 'other call') : b.type), tok });
        }
        return;
      }
      if (!r.timestamp || r.timestamp < FROM || r.timestamp >= TO || r.type !== 'user') return;
      for (const b of Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : []) {
        let k, tok;
        if (b.type === 'tool_result') {
          const arr = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
          const imgs = arr.filter((x) => x.type === 'image').length;
          tok = arr.filter((x) => x.type === 'text').reduce((s, x) => s + (x.text || '').length, 0) / 4 + imgs * 1600;
          k = names[b.tool_use_id] || '?';
          if (imgs) images.push(imgs);
        } else if (b.type === 'text') {
          k = b.text.includes('<system-reminder>') ? 'system reminders' : 'user text';
          tok = b.text.length / 4;
        } else continue;
        events.push({ t: 'item', k: kind + ' ' + k, tok });
      }
    });
    for (const imgs of images) add(kind + ' (images in results)', imgs * 1600, 0);
    // Walk backwards: later calls before the next compaction re-read each item.
    let later = 0, model = 'claude-opus';
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.t === 'compact') later = 0;
      else if (e.t === 'call') { later++; model = e.model || model; }
      else add(e.k, e.tok, mult(model) * e.tok * (2 + 0.1 * later));
    }
  }
  const p = printer();
  const pct = (x) => (100 * x / total).toFixed(1).padStart(5) + '%';
  p.log(`carry weight of context items ${FROM}..${TO}: ~${(total / 1e6).toFixed(0)}M Opus-input tokens`);
  for (const [k, a] of Object.entries(agg).sort((x, y) => y[1].w - x[1].w).slice(0, 30)) {
    p.log(k.padEnd(34), String(a.n).padStart(6), ('~' + Math.round(a.tok / 1e3) + 'k tok').padStart(12), pct(a.w), 'avg ~' + Math.round(a.tok / a.n) + ' tok');
  }
  return p.text();
}

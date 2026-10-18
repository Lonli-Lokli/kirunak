import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kirunakHome } from './home.mjs';
import { rows } from './list.mjs';

// The local page (boards.md §2): static HTML, inline CSS, both themes, no control of any kind.

// Colour tokens per theme. Every pair in TEXT_PAIRS is text on a ground and must reach 4.5:1 in both.
export const THEMES = {
  light: {
    bg: '#f4f5f7', card: '#ffffff', line: '#c9ced6', text: '#1b1f24', muted: '#4a5361',
    link: '#0b57d0', met: '#1a6e34', notmet: '#b3261e', needs: '#6a3ab2', stale: '#b3261e',
  },
  dark: {
    bg: '#0f1216', card: '#1a1e24', line: '#3a414b', text: '#e6e9ee', muted: '#a8b1bc',
    link: '#8ab4f8', met: '#6fcf8c', notmet: '#ff8a80', needs: '#c9adff', stale: '#ff8a80',
  },
};
export const TEXT_PAIRS = [
  ['text', 'bg'], ['muted', 'bg'], ['text', 'card'], ['muted', 'card'], ['link', 'card'], ['link', 'bg'],
  ['met', 'card'], ['notmet', 'card'], ['needs', 'card'], ['stale', 'card'],
];

const COLUMNS = ['draft', 'proposed', 'ready', 'blocked', 'in progress', 'in review', 'awaiting owner', 'done this week'];
const COLUMN_OF = { reviewed: 'awaiting owner', done: 'done this week' };
const WEEK = 7 * 24 * 3600 * 1000;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const readJson = (p, fallback = null) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

// The slice-1 status: the default guard's lock, queue and claims, and the running steps.
export function status(ws) {
  const home = ws.home || kirunakHome();
  const guard = join(home, 'guard');
  const queueFile = join(guard, 'queue');
  const claims = readJson(join(guard, 'claims.json'), []);
  const runningDir = join(home, 'running');
  const running = existsSync(runningDir)
    ? readdirSync(runningDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(runningDir, f))).filter(Boolean)
    : [];
  return {
    lock: readJson(join(guard, 'lock', 'owner.json')),
    queue: existsSync(queueFile) ? readFileSync(queueFile, 'utf8').split('\n').filter((l) => l.trim()) : [],
    claims: Array.isArray(claims) ? claims : Object.entries(claims).map(([resource, c]) => ({ resource, ...c })),
    running,
    maxAgents: ws.machine?.maxAgents ?? 2,
  };
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function css() {
  const vars = (t) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(' ');
  return `
:root { color-scheme: light dark; ${vars(THEMES.light)} }
@media (prefers-color-scheme: dark) { :root { ${vars(THEMES.dark)} } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
h1 { font-size: 1.3rem; margin: 0 0 12px; }
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 12px; align-items: start; }
.col h2 { font-size: 1rem; margin: 0 0 8px; }
.col h2 .n { color: var(--muted); font-weight: normal; }
.empty { color: var(--muted); margin: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
.card h3 { font-size: 0.95rem; margin: 0 0 2px; }
.id, .meta { color: var(--muted); font-size: 0.85rem; margin: 0 0 6px; }
.card ul { margin: 4px 0 6px; padding-left: 1.1rem; }
.card li { margin: 2px 0; }
.v { font-weight: 600; white-space: nowrap; }
.v-met { color: var(--met); } .v-notmet { color: var(--notmet); } .v-needs { color: var(--needs); } .v-none { color: var(--muted); font-weight: normal; }
.stale { color: var(--stale); font-weight: 600; }
a { color: var(--link); }
.links a { margin-right: 10px; }
footer { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 10px; color: var(--muted); font-size: 0.9rem; }
footer p { margin: 4px 0; }
`;
}

function verdictSpan(v) {
  const cls = !v ? 'v-none' : v === 'met' ? 'v-met' : v === 'not met' ? 'v-notmet' : 'v-needs';
  return `<span class="v ${cls}">${esc(v || 'none')}</span>`;
}

function card(r) {
  const items = [...(r.ac || []), ...(r.e || [])]
    .map((x) => `<li><b>${esc(x.id)}</b> ${esc(x.text)} ${verdictSpan(x.verdict)}</li>`)
    .join('');
  const meta = [
    r.queue ? `queue ${r.queue}` : 'not queued',
    r.step ? `step: ${r.step}` : null,
    r.lock && r.state === 'in progress' ? `lock: ${r.lock}` : null,
    r.approved ? `approved ${String(r.approved).slice(0, 10)}` : null,
    r.review ? `${r.review.file}: ${r.review.verdict || 'no verdict yet'}` : null,
    r.checklist ? `checklist ${r.checklist.ticked} ticked, ${r.checklist.open} open` : null,
    r.accepted ? `accepted ${String(r.accepted).slice(0, 10)}` : null,
  ].filter(Boolean);
  const links = ['task', 'plan', 'review', 'checklist']
    .filter((k) => r.paths?.[k])
    .map((k) => `<a href="${esc(pathToFileURL(r.paths[k]).href)}">${k}.md</a>`)
    .join('');
  return `<article class="card">
<h3>${esc(r.title)}</h3>
<p class="id">${esc(r.id)}</p>
${r.state === 'stale' ? '<p class="stale">stale: task.md does not match its approval</p>' : ''}
<p class="meta">${meta.map(esc).join(' · ')}</p>
${items ? `<ul>${items}</ul>` : ''}
<p class="links">${links}</p>
</article>`;
}

function footer(st, now) {
  const lock = st?.lock ? `lock: ${st.lock.what ?? '?'} (session ${st.lock.session ?? '?'}, since ${st.lock.since ?? '?'})` : 'no lock';
  const queue = st?.queue?.length ? `guard queue: ${st.queue.join('; ')}` : 'guard queue: empty';
  const claims = st?.claims?.length
    ? `claims: ${st.claims.map((c) => `${c.resource} by ${c.by}${c.why ? ` (${c.why})` : ''}`).join('; ')}`
    : 'claims: none';
  const running = st?.running ?? [];
  const steps = `running steps: ${running.length} of ${st?.maxAgents ?? 2}${
    running.length ? ': ' + running.map((s) => `${s.task ?? '?'} ${s.step ?? ''}${s.since ? ` since ${s.since}` : ''}`.trim()).join('; ') : ''
  }`;
  return `<footer>
<p>${esc(lock)}</p>
<p>${esc(queue)}</p>
<p>${esc(claims)}</p>
<p>${esc(steps)}</p>
<p>Generated at ${esc(stamp(now))}. To regenerate: k board</p>
</footer>`;
}

// renderHtml(rows, status, now) → the page. Columns by state; on hold and stale get a column only when a task is in one.
export function renderHtml(list, st, now = new Date()) {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c, []]));
  for (const r of list) {
    const col = COLUMN_OF[r.state] || r.state;
    if (r.state === 'done' && r.accepted && now - Date.parse(r.accepted) > WEEK) continue;
    (cols[col] ||= []).push(r);
  }
  const sections = Object.entries(cols)
    .filter(([name, cards]) => COLUMNS.includes(name) || cards.length)
    .map(([name, cards]) => `<section class="col">
<h2>${esc(name)} <span class="n">${cards.length}</span></h2>
${cards.length ? cards.map(card).join('\n') : '<p class="empty">none</p>'}
</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kirunak board</title>
<style>${css()}</style>
</head>
<body>
<h1>kirunak board</h1>
<main class="board">
${sections}
</main>
${footer(st, now)}
</body>
</html>
`;
}

// write(ws, { path, open }) → the path written; opens it only when asked.
export async function write(ws, { path = null, open = false } = {}) {
  const out = path || join(ws.home || kirunakHome(), 'board.html');
  const html = renderHtml(await rows(ws, { all: true }), status(ws), new Date());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  if (open) {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  return out;
}

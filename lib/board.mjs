import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kirunakHome } from './home.mjs';
import { rows } from './list.mjs';
import { bugFix, draftDate, entry, facts, items, model, sessions, STALE } from './board-model.mjs';
import { list as listBugs } from './bugs.mjs';
import { list as listDrafts } from './drafts.mjs';

// The page (boards.md §2, and the phone's, §3): static HTML, inline CSS, both themes, no form, button or script. One
// column on a phone, read in order: the tasks sessions are working on, every other task by state, the bugs that wait
// (a heading, k waiting's line and a list, gulnya/kirunak-bugs AC-7), the drafts that wait for the owner's intake (a
// heading and a list, kirunak-drafts AC-9, AC-14), then the lock, its queue and the running steps. Each task is one brief row, the brief board's entry (kirunak-phone A-7), that
// opens its card in place when tapped and closes when tapped again: a native details and summary, closed at first.

// Colour tokens per theme. Every pair in TEXT_PAIRS is text on a ground and must reach 4.5:1 in both. `work` is the
// ground of a task's row and card in the first section, a task a session is working on. A draft's row is text and
// muted on `card`, as a task's is (DRAFT_PAIRS), its dashed border only a mark that it is not a task yet. A bug's row is
// the same on `card`, its border solid, and the bugs' line above them is text on `bg` (BUG_PAIRS).
export const THEMES = {
  light: {
    bg: '#f4f5f7', card: '#ffffff', work: '#eaf1fe', line: '#c9ced6', text: '#1b1f24', muted: '#4a5361',
    link: '#0b57d0', met: '#1a6e34', notmet: '#b3261e', needs: '#6a3ab2', stale: '#b3261e',
  },
  dark: {
    bg: '#0f1216', card: '#1a1e24', work: '#16223a', line: '#3a414b', text: '#e6e9ee', muted: '#a8b1bc',
    link: '#8ab4f8', met: '#6fcf8c', notmet: '#ff8a80', needs: '#c9adff', stale: '#ff8a80',
  },
};
export const TEXT_PAIRS = [
  ['text', 'bg'], ['muted', 'bg'], ['text', 'card'], ['muted', 'card'], ['link', 'card'], ['link', 'bg'],
  ['met', 'card'], ['notmet', 'card'], ['needs', 'card'], ['stale', 'card'],
  ['text', 'work'], ['muted', 'work'], ['link', 'work'], ['met', 'work'], ['notmet', 'work'], ['needs', 'work'], ['stale', 'work'],
];
export const DRAFT_PAIRS = [['text', 'card'], ['muted', 'card']];
export const BUG_PAIRS = [['text', 'bg'], ['text', 'card'], ['muted', 'card']];

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

function css() {
  const vars = (t) => Object.entries(t).map(([k, v]) => `--${k}: ${v};`).join(' ');
  // The viewer's theme: the system's through prefers-color-scheme, unless the host page (claude.ai) sets data-theme.
  return `
:root { color-scheme: light dark; ${vars(THEMES.light)} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${vars(THEMES.dark)} } }
:root[data-theme="dark"] { color-scheme: dark; ${vars(THEMES.dark)} }
:root[data-theme="light"] { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0 auto; max-width: 75rem; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; overflow-wrap: anywhere; word-break: break-word; }
h1 { font-size: 1.35rem; margin: 0; }
.made { color: var(--muted); margin: 2px 0 8px; }
h2 { font-size: 1.1rem; margin: 20px 0 8px; }
h2 .n { color: var(--muted); font-weight: normal; }
.states { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: 0 16px; align-items: start; }
.states > section { min-width: 0; }
.empty { color: var(--muted); margin: 0; }
.task { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin: 0 0 8px; }
.work .task { background: var(--work); border-left: 4px solid var(--link); }
.task > summary { padding: 10px 12px; cursor: pointer; }
.task > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 8px; }
.card { padding: 0 12px 10px; }
.card p { margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 0.9rem; }
.items { margin: 8px 0 4px; padding-left: 1.2rem; }
.items li { margin: 4px 0; }
.v { font-weight: 600; }
.v-met { color: var(--met); } .v-notmet { color: var(--notmet); } .v-needs { color: var(--needs); } .v-none { color: var(--muted); font-weight: normal; }
.stale { color: var(--stale); font-weight: 600; }
a { color: var(--link); }
.links a { margin-right: 12px; }
.bugs p { margin: 0 0 8px; }
.bugs ul, .drafts ul { list-style: none; margin: 0; padding: 0; }
.bugs li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin: 0 0 8px; padding: 10px 12px; }
.drafts li { background: var(--card); border: 1px dashed var(--line); border-radius: 8px; margin: 0 0 8px; padding: 10px 12px; }
.machine h3 { font-size: 1rem; margin: 12px 0 4px; }
.machine p, .machine ul, .machine ol { margin: 0 0 4px; }
.machine ul, .machine ol { padding-left: 1.5rem; }
footer { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 10px; color: var(--muted); font-size: 0.9rem; }
footer p { margin: 4px 0; }
`;
}

const verdictClass = (v) => (v === 'none' ? 'v-none' : v === 'met' ? 'v-met' : v.startsWith('not met') ? 'v-notmet' : 'v-needs');

// A task: its brief entry as the summary, its id in bold, and under it the card, the title, the facts, every AC and E
// in full with its verdict, and the file links. The summary names the task, so the card does not repeat its id.
function card(r, links) {
  const list = items(r)
    .map((x) => `<li><b>${esc(x.id)}</b> <span class="v ${verdictClass(x.verdict)}">${esc(x.verdict)}</span>: ${esc(x.text)}</li>`)
    .join('\n');
  const files = links
    ? ['task', 'plan', 'review', 'checklist'].filter((k) => r.paths?.[k]).map((k) => `<a href="${esc(pathToFileURL(r.paths[k]).href)}">${k}.md</a>`).join(' ')
    : '';
  return `<details class="task">
<summary><b>${esc(r.id)}</b>${esc(entry(r).slice(r.id.length))}</summary>
<div class="card">
<p>${esc(r.title)}</p>
${facts(r).map((f) => `<p class="${f === STALE ? 'stale' : 'meta'}">${esc(f)}</p>`).join('\n')}
${list ? `<ul class="items">\n${list}\n</ul>` : ''}
${files ? `<p class="links">${files}</p>` : ''}
</div>
</details>`;
}

const heading = (title, n) => `<h2>${esc(title)} <span class="n">(${n})</span></h2>`;

// The bugs that wait: a heading, k waiting's line for them, and a list, a bug a row with its id in bold, its title, its
// fix and the task it is a bug of in the text's colour, and the date it was written muted, as a draft's; nothing when
// none waits (gulnya/kirunak-bugs AC-7).
function bugs(m) {
  if (!m.bugs.length) return '';
  const row = (b) => {
    const date = b.written ? `written <time datetime="${esc(b.written)}">${esc(b.written)}</time>` : esc(draftDate(b));
    return `<li><b>${esc(b.id)}</b>: ${esc(b.title)}, ${esc(bugFix(b))}, <span class="meta">${date}</span></li>`;
  };
  return `<section class="bugs">
${heading('Bugs', m.bugs.length)}
<p>${esc(m.bugsLine)}</p>
<ul>
${m.bugs.map(row).join('\n')}
</ul>
</section>
`;
}

// The drafts that wait for the owner's intake: a heading and a list, a draft a row with its id in bold, its title and
// the date it was written; nothing when there is none. A bug's row names its task before the date, "bug of <task>", in
// the text's colour, since it says what the draft is (kirunak-spikes AC-6, D-2); only the date is muted.
function drafts(m) {
  if (!m.drafts.length) return '';
  const row = (d) => {
    const date = d.written ? `written <time datetime="${esc(d.written)}">${esc(d.written)}</time>` : esc(draftDate(d));
    const bug = d.bugOf ? `bug of ${esc(d.bugOf)}, ` : '';
    return `<li><b>${esc(d.id)}</b>: ${esc(d.title)}, ${bug}<span class="meta">${date}</span></li>`;
  };
  return `<section class="drafts">
${heading('Drafts', m.drafts.length)}
<ul>
${m.drafts.map(row).join('\n')}
</ul>
</section>
`;
}

function machine(m) {
  const part = (p) => {
    const tag = p.ordered ? 'ol' : 'ul';
    const body = p.rows.length ? `<${tag}>${p.rows.map((x) => `<li>${esc(x)}</li>`).join('')}</${tag}>` : `<p class="empty">${esc(p.empty)}</p>`;
    return `<h3>${esc(p.title)}</h3>\n${body}`;
  };
  return `<section class="machine">
<h2>Lock, queue and running steps</h2>
<p>${esc(m.lock)}</p>
${m.machine.map(part).join('\n')}
</section>`;
}

// renderHtml(rows, st, now, { links }) → the page; `st` is status() with `sessions` beside it. `links` adds file://
// links to each card's files, which only the Mac that wrote the page can open.
export function renderHtml(list, st, now = new Date(), { links = true } = {}) {
  const m = model(list, st, now);
  const work = m.working.length ? m.working.map((r) => card(r, links)).join('\n') : '<p class="empty">No session names a task and no step is running.</p>';
  const states = m.states.map((s) => `<section>\n${heading(s.title, s.rows.length)}\n${s.rows.map((r) => card(r, links)).join('\n')}\n</section>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kirunak board</title>
<style>${css()}</style>
</head>
<body>
<header>
<h1>kirunak board</h1>
<p class="made">Made at ${esc(m.made)}</p>
</header>
<main>
<section class="work">
${heading('Working on now', m.working.length)}
${work}
</section>
<div class="states">
${states || '<p class="empty">No other task.</p>'}
</div>
${bugs(m)}${drafts(m)}${machine(m)}
</main>
<footer>
<p>Read-only: the task files as they were at ${esc(m.made)}. To make it again: k board.</p>
</footer>
</body>
</html>
`;
}

// The status with the session records, the bugs and the drafts beside it, as the board reads it.
export const snapshot = (ws) => ({ ...status(ws), sessions: sessions(ws), bugs: listBugs(ws), drafts: listDrafts(ws) });

// write(ws, { path, open }) → the path written; opens it only when asked. The page at a path (--html, for the phone)
// has no file:// links, which would open nothing there.
export async function write(ws, { path = null, open = false } = {}) {
  const out = path || join(ws.home || kirunakHome(), 'board.html');
  const html = renderHtml(await rows(ws, { all: true }), snapshot(ws), new Date(), { links: !path });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  if (open) {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  return out;
}

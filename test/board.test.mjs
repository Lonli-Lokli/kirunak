import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { renderHtml, snapshot, TEXT_PAIRS, write } from '../lib/board.mjs';
import { renderBrief } from '../lib/board-brief.mjs';
import { rows } from '../lib/list.mjs';
import { fixture, NOW, queuedAndParked, sessionsAt } from './board-fixture.mjs';

async function page(w, opts) {
  return renderHtml(await rows(w.ws, { all: true }), snapshot(w.ws), NOW, opts);
}

const h2s = (html) => [...html.matchAll(/<h2>([^<]*?)(?: <span class="n">\((\d+)\)<\/span>)?<\/h2>/g)].map((m) => m[1]);

// Each task's row: its summary as read (the tags taken out), its id, and the card under it.
const tasks = (html) =>
  [...html.matchAll(/<details class="task">\n<summary>(.*?)<\/summary>\n<div class="card">\n([^]*?)<\/div>\n<\/details>/g)].map((m) => {
    const summary = m[1].replace(/<[^>]*>/g, '');
    return { summary, id: summary.slice(0, summary.indexOf(':')), card: m[2], raw: m[0] };
  });
const cardOf = (html, id) => tasks(html).find((t) => t.id === id)?.card ?? '';

test('every task appears with its AC and E and their latest verdicts', async () => {
  const w = await fixture();
  queuedAndParked(w);
  const html = await page(w);
  for (const id of ['weather/hourly-chart', 'hub/reviewed', 'weather/recent', 'weather/offline-forecast']) assert.ok(html.includes(id), id);
  assert.ok(!html.includes('weather/long-ago'), 'done more than a week ago is left out');
  for (const text of ['The last forecast stays readable offline', 'With no network, the app opens on the last forecast it fetched', 'A forecast older than a day shows its age in words']) {
    assert.ok(html.includes(text), text);
  }
  const card = cardOf(html, 'hub/reviewed');
  assert.match(card, /<b>AC-1<\/b>[^<]*<span class="v v-met">met<\/span>/);
  assert.match(card, /<b>AC-2<\/b>.*<span class="v v-notmet">not met<\/span>/);
  assert.match(card, /<b>E-1<\/b>.*<span class="v v-none">none<\/span>/);
  assert.match(card, /review: review-2\.md, verdict: not met \(AC-2\)/);
  const chart = cardOf(html, 'weather/hourly-chart');
  assert.match(chart, /state: in progress, queue place 1/);
  assert.match(chart, /step: 2026-11-03 14:02 S-2 started/);
  assert.match(cardOf(html, 'weather/next-up'), /state: queued, queue place 2/);
  assert.match(cardOf(html, 'hub/later'), /state: parked</);
  assert.deepEqual(h2s(html), [
    'Working on now', 'proposed', 'queued', 'parked', 'in progress', 'in review', 'done this week', 'Lock, queue and running steps',
  ], 'a section per state with tasks, in lib/state.mjs\'s order');
  assert.match(html, /<h3>Task queue<\/h3>\n<ol><li>weather\/hourly-chart \(in progress\)<\/li><li>weather\/next-up \(queued\)<\/li><\/ol>/);
});

test('no form, button or script anywhere, and every text is escaped', async () => {
  const html = await page(await fixture());
  for (const tag of ['<form', '<button', '<script']) assert.ok(!html.toLowerCase().includes(tag), tag);
  assert.ok(html.includes('An hourly chart &lt;for&gt; today'));
  assert.ok(html.includes('Points read &lt;below&gt; &amp; above zero.'));
  assert.ok(!html.includes('<for>'));
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

test('both themes in the CSS, every text pair at 4.5:1 or more in each', async () => {
  const html = await page(await fixture());
  const light = /:root \{([^}]*)\}/.exec(html)[1];
  const dark = /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\} \}/.exec(html)?.[1];
  assert.ok(dark, 'a dark block under prefers-color-scheme, unless the host says light');
  assert.equal(/:root\[data-theme="dark"\] \{([^}]*)\}/.exec(html)?.[1], dark, 'the same dark block when the host says dark');
  for (const [name, block] of [['light', light], ['dark', dark]]) {
    const t = tokens(block);
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(t[fg] && t[bg], `${name} defines --${fg} and --${bg}`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
    }
  }
  assert.ok(ratio('#777777', '#ffffff') < 4.5, 'the check fails a pair under 4.5:1');
});

test('file:// links to the four files of every card', async () => {
  const w = await fixture();
  const html = await page(w);
  const dir = join(realpathSync(w.weather), 'kirunak', 'tasks', 'hourly-chart');
  for (const f of ['task.md', 'plan.md', 'review.md', 'checklist.md']) {
    assert.ok(html.includes(`href="${pathToFileURL(join(dir, f)).href}"`), f);
  }
  assert.ok(html.includes(`href="${pathToFileURL(join(realpathSync(w.hub), 'kirunak', 'tasks', 'reviewed', 'review-2.md')).href}"`), 'the latest review');
});

test('the last section: no lock, then the lock, its queue, the running steps, the claims and the task queue', async () => {
  const w = await fixture();
  let html = await page(w);
  assert.match(html, /<p>no lock<\/p>/);
  assert.match(html, /<h3>Running steps: 0 of 2<\/h3>/);
  assert.match(html, /<h3>Task queue<\/h3>\n<ol><li>weather\/hourly-chart \(in progress\)<\/li><\/ol>/);
  assert.match(html, /<p class="made">Made at \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/p>/);
  assert.match(html, /To make it again: k board\./);
  mkdirSync(join(w.home, 'guard', 'lock'), { recursive: true });
  mkdirSync(join(w.home, 'running'), { recursive: true });
  writeFileSync(join(w.home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 's1', what: 'weather unit tests', pid: 1, since: '2026-11-07T11:50:00Z' }));
  writeFileSync(join(w.home, 'guard', 'queue'), '{"session":"s2","what":"hub build"}\n');
  writeFileSync(join(w.home, 'guard', 'claims.json'), JSON.stringify([{ resource: 'phone-1', by: 's1', why: 'smoke run' }]));
  writeFileSync(join(w.home, 'running', '123.json'), JSON.stringify({ task: 'weather/hourly-chart', step: 'S-2', session: 's1', since: '2026-11-07T11:40:00Z' }));
  html = await page(w);
  assert.match(html, /<p>lock: weather unit tests \(session s1, since \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)<\/p>/);
  assert.match(html, /<h3>Heavy-job queue<\/h3>\n<ol><li>hub build \(session s2\)<\/li><\/ol>/);
  assert.match(html, /<h3>Device claims<\/h3>\n<ul><li>phone-1 by s1 \(smoke run\)<\/li><\/ul>/);
  assert.match(html, /<h3>Running steps: 1 of 2<\/h3>\n<ul><li>weather\/hourly-chart S-2, session s1, since \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/li><\/ul>/);
});

test('write puts the page in $KIRUNAK_HOME, or at a path, and opens nothing unless asked', async () => {
  const w = await fixture();
  const t0 = performance.now();
  const out = await write(w.ws);
  const ms = performance.now() - t0;
  assert.equal(out, join(w.home, 'board.html'));
  assert.ok(readFileSync(out, 'utf8').startsWith('<!doctype html>'));
  assert.ok(ms < 2000, `write took ${ms.toFixed(0)} ms`);
  const other = join(w.root, 'elsewhere', 'b.html');
  assert.equal(await write(w.ws, { path: other }), other);
  assert.ok(existsSync(other));
});

test('the tasks sessions work on come first, each once, with who works on it; a done task is not among them', async () => {
  const w = await fixture();
  sessionsAt(w);
  const html = await page(w);
  assert.deepEqual(h2s(html), ['Working on now', 'proposed', 'done this week', 'Lock, queue and running steps']);
  const work = html.slice(html.indexOf('<section class="work">'), html.indexOf('<div class="states">'));
  assert.deepEqual(tasks(work).map((t) => t.id), ['weather/hourly-chart', 'hub/reviewed'], 'in k list\'s order');
  assert.match(work, /<h2>Working on now <span class="n">\(2\)<\/span><\/h2>/);
  assert.match(work, /worked on by session s1 since \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/p>/);
  assert.match(work, /worked on by step S-3 running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/p>/);
  assert.equal(html.split('<summary><b>weather/hourly-chart</b>').length, 2, 'once on the page');
  assert.ok(!work.includes('weather/recent'));
});

test('read in order by a screen reader: one h1, the time it was made, an h2 per section, a row per task, lists for the AC and E', async () => {
  const w = await fixture();
  sessionsAt(w);
  const html = await page(w);
  const body = html.slice(html.indexOf('<body>'));
  assert.deepEqual([...body.matchAll(/<h([1-3])>/g)].map((m) => m[1]).join(''), '122223333');
  assert.match(body, /<h1>kirunak board<\/h1>\n<p class="made">Made at \d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/p>/);
  assert.equal(tasks(body).length, body.split('<details').length - 1, 'every task a row');
  for (const t of tasks(body)) {
    assert.match(t.raw, /^<details class="task">\n<summary><b>[a-z]+\/[a-z-]+<\/b>: [a-z ]+[,<]/, 'the id, then the state, as text');
    assert.match(t.card, /^<p>[^<]+<\/p>\n<p class="meta">state: [a-z ]+/, 'the title, then the state as text');
    assert.match(t.card, /<ul class="items">\n(<li><b>(AC|E)-\d+<\/b> <span class="v [a-z-]+">(met|not met|needs device|needs owner|none)<\/span>: [^\n]*<\/li>\n)+<\/ul>/);
  }
  assert.ok(!/[·•|]/.test(body.replace(/<[^>]*>/g, '')), 'no separator or bullet drawn in the text');
  assert.ok(!/content:\s*['"][^'"]/.test(html), 'no CSS mark a reader would speak');
});

test('laid out for a phone: the viewport, long words broken, no box wider than 390 px less its gutters', async () => {
  const html = await page(await fixture());
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  const style = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  assert.match(style, /body \{[^}]*padding: 16px;[^}]*overflow-wrap: anywhere;/);
  assert.match(style, /minmax\(min\(100%, \d+rem\), 1fr\)/, 'a grid column never wider than the screen');
  // A length over 358 px may only cap a width (max-width, min(100%, ...)), never set one.
  const sized = style.replace(/max-width: [\d.]+rem/g, '').replace(/min\(100%, [\d.]+rem\)/g, '');
  for (const m of sized.matchAll(/(\d+(?:\.\d+)?)(px|rem)\b/g)) assert.ok(Number(m[1]) * (m[2] === 'rem' ? 16 : 1) <= 358, `${m[0]} in the CSS`);
});

test('the page written at a path, for the phone, has no file:// link', async () => {
  const w = await fixture();
  const out = await write(w.ws, { path: join(w.root, 'phone', 'board.html') });
  assert.ok(!readFileSync(out, 'utf8').includes('file://'));
  assert.ok(readFileSync(await write(w.ws), 'utf8').includes('file://'), 'the local page keeps them');
});

test('each task a brief row, closed at first, that opens its card in place: native details, in the brief board\'s order', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  const list = await rows(w.ws, { all: true });
  const html = renderHtml(list, snapshot(w.ws), NOW);
  const brief = renderBrief(list, snapshot(w.ws), NOW);
  const entries = brief.text.split('\n').filter((l) => /^[a-z]+\/[a-z-]+: /.test(l));
  assert.deepEqual(tasks(html).map((t) => t.summary), entries, 'each summary the brief entry, in the same order');
  assert.deepEqual(tasks(html).map((t) => t.id), brief.ids);
  assert.ok(!/<details[^>]*\sopen/.test(html), 'closed until tapped');
  assert.ok(!/\srole=/.test(html), 'no role over the native semantics');
  assert.ok(!/\saria-(?!hidden)/.test(html), 'no aria but on a decorative mark');
  assert.ok(cardOf(html, 'weather/offline-forecast').includes('A forecast older than a day shows its age in words'), 'every AC and E in full');
});

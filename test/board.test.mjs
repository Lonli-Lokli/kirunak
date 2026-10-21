import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { renderHtml, status, TEXT_PAIRS, write } from '../lib/board.mjs';
import { rows } from '../lib/list.mjs';
import { fixture, NOW } from './board-fixture.mjs';

async function page(w) {
  return renderHtml(await rows(w.ws, { all: true }), status(w.ws), NOW);
}

test('every task appears with its AC and E and their latest verdicts', async () => {
  const w = await fixture();
  const html = await page(w);
  for (const id of ['weather/hourly-chart', 'hub/reviewed', 'weather/recent', 'weather/offline-forecast']) assert.ok(html.includes(id), id);
  assert.ok(!html.includes('weather/long-ago'), 'done more than a week ago is left out');
  for (const text of ['The last forecast stays readable offline', 'With no network, the app opens on the last forecast it fetched', 'A forecast older than a day shows its age in words']) {
    assert.ok(html.includes(text), text);
  }
  const card = html.slice(html.indexOf('hub/reviewed'), html.indexOf('</article>', html.indexOf('hub/reviewed')));
  assert.match(card, /<b>AC-1<\/b>[^<]*<span class="v v-met">met<\/span>/);
  assert.match(card, /<b>AC-2<\/b>.*<span class="v v-notmet">not met<\/span>/);
  assert.match(card, /<b>E-1<\/b>.*<span class="v v-none">none<\/span>/);
  assert.match(card, /review-2\.md: not met \(AC-2\)/);
  const chart = html.slice(html.indexOf('weather/hourly-chart'), html.indexOf('</article>', html.indexOf('weather/hourly-chart')));
  assert.match(chart, /queue 1/);
  assert.match(chart, /step: 2026-11-03 14:02 S-2 started/);
  for (const col of ['draft', 'proposed', 'ready', 'blocked', 'in progress', 'in review', 'awaiting owner', 'done this week']) {
    assert.ok(html.includes(`<h2>${col} `), col);
  }
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
  const dark = /@media \(prefers-color-scheme: dark\) \{ :root \{([^}]*)\} \}/.exec(html)?.[1];
  assert.ok(dark, 'a dark block under prefers-color-scheme');
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

test('the footer: no lock, then the lock, queue, claims and running steps', async () => {
  const w = await fixture();
  let html = await page(w);
  assert.match(html, /<p>no lock<\/p>/);
  assert.match(html, /running steps: 0 of 2/);
  assert.match(html, /Generated at \d{4}-\d{2}-\d{2} \d{2}:\d{2}\. To regenerate: k board/);
  mkdirSync(join(w.home, 'guard', 'lock'), { recursive: true });
  mkdirSync(join(w.home, 'running'), { recursive: true });
  writeFileSync(join(w.home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 's1', what: 'weather unit tests', pid: 1, since: '2026-11-07T11:50:00Z' }));
  writeFileSync(join(w.home, 'guard', 'queue'), '{"session":"s2","what":"hub build"}\n');
  writeFileSync(join(w.home, 'guard', 'claims.json'), JSON.stringify([{ resource: 'phone-1', by: 's1', why: 'smoke run' }]));
  writeFileSync(join(w.home, 'running', '123.json'), JSON.stringify({ task: 'weather/hourly-chart', step: 'S-2', session: 's1', since: '2026-11-07T11:40:00Z' }));
  html = await page(w);
  assert.match(html, /lock: weather unit tests \(session s1/);
  assert.match(html, /guard queue: \{&quot;session&quot;:&quot;s2&quot;/);
  assert.match(html, /claims: phone-1 by s1 \(smoke run\)/);
  assert.match(html, /running steps: 1 of 2: weather\/hourly-chart S-2 since 2026-11-07T11:40:00Z/);
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

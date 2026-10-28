import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BUG_PAIRS, bugState, DRAFT_PAIRS, DRAFT_STATE, FIVE, renderHtml, snapshot, STATE_CLASSES, STATE_PAIRS, taskState, TEXT_PAIRS, verdictState, write } from '../lib/board.mjs';
import { renderBrief } from '../lib/board-brief.mjs';
import { model } from '../lib/board-model.mjs';
import { renderMarkdown } from '../lib/board-md.mjs';
import { fixLine, quadDamagePath } from '../lib/bugs.mjs';
import { rows } from '../lib/list.mjs';
import { STATES } from '../lib/state.mjs';
import { bugAt, bugsAt, draftsAt, fixture, NOW, queuedAndParked, sessionsAt } from './board-fixture.mjs';

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

// The five states as the mod's dialogs have them (gulnya/mobile-dialogs AC-8): looks.ts read as text, since the page
// cannot import TypeScript, so a change there that the page does not follow fails here.
const LOOKS = readFileSync(new URL('../mods/kirunak/hooks/looks.ts', import.meta.url), 'utf8');
const looksMap = (name) => {
  const block = new RegExp(`\\bconst ${name}\\b[^=]*= \\{([^}]*)\\}`).exec(LOOKS)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/^\s*'?([a-z ]+?)'?: '([a-z ]+)',?$/gm)].map((m) => [m[1], m[2]]));
};
const themeTokens = (html) => [
  ['light', tokens(/:root \{([^}]*)\}/.exec(html)[1])],
  ['dark', tokens(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\} \}/.exec(html)[1])],
];

test('the five states: a token each in the light and the dark theme, each at 4.5:1 or more on every ground of the page (gulnya/mobile-dialogs AC-7, AC-8, AC-20)', async () => {
  const html = await page(await fixture());
  assert.deepEqual(FIVE, /export type State = ([^\n]*)/.exec(LOOKS)[1].match(/'[a-z]+'/g).map((x) => x.slice(1, -1)), 'the dialogs\' five');
  for (const [name, t] of themeTokens(html)) {
    for (const s of FIVE) {
      assert.match(t[s] ?? '', /^#[0-9a-f]{6}$/i, `${name} defines --${s}`);
      for (const g of ['bg', 'card', 'work']) {
        assert.ok(STATE_PAIRS.some(([f, b]) => f === s && b === g) && TEXT_PAIRS.some(([f, b]) => f === s && b === g), `--${s} on --${g} is in the page's contrast test`);
        const r = ratio(t[s], t[g]);
        assert.ok(r >= 4.5, `${name}: --${s} on --${g} is ${r.toFixed(2)}:1`);
      }
    }
  }
});

test('every state the page draws is one of the five, mapped as the dialogs map it, its word beside its colour (gulnya/mobile-dialogs AC-8, AC-9)', async () => {
  const [stages, taskStages] = [looksMap('STAGES'), looksMap('TASK_STAGES')];
  for (const state of STATES) {
    assert.ok(taskStages[state] && stages[taskStages[state]], `looks.ts draws ${state}`);
    assert.equal(taskState(state), stages[taskStages[state]], `${state} as the dialogs draw it`);
  }
  assert.equal(taskState('no such state'), 'na', 'a state of no known name is not reached, as taskChip has it');
  for (const [v, s] of [['met', 'done'], ['not met', 'failed'], ['needs device', 'waits'], ['needs owner', 'waits'], ['none', 'na']]) assert.equal(verdictState(v), s, v);
  const fixes = [
    [{ quadDamageRun: { phase: 'fixing', try: 1 } }, 'running'], [{ quadDamageRun: { phase: 'waiting' } }, 'running'], [{ reviewing: true }, 'running'],
    [{ fixReady: true }, 'waits'], [{ review: { atHead: true, verdict: 'findings', file: 'review.md' } }, 'waits'], [{ branch: 'bug/x', ahead: 2 }, 'waits'], [{}, 'na'],
  ];
  for (const [b, s] of fixes) assert.equal(bugState(fixLine(b)), s, fixLine(b));
  assert.equal(DRAFT_STATE, 'waits');

  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  bugsAt(w);
  draftsAt(w);
  const html = await page(w);
  const style = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  for (const [c, s] of Object.entries(STATE_CLASSES)) {
    assert.ok(FIVE.includes(s), `${c} is one of the five`);
    assert.ok(style.includes(`.${c} { color: var(--${s}); }`), `.${c} in --${s}`);
  }
  for (const [, token] of style.matchAll(/(?:^|[;{\s])color: var\(--([\w-]+)\)/g)) assert.ok([...FIVE, 'text', 'muted', 'link'].includes(token), `--${token} is the text's or a state's`);
  assert.match(style, /\.drafts li \{[^}]*border-left: 4px solid var\(--waits\);/, 'a draft\'s edge in the colour of waits');
  const body = html.slice(html.indexOf('<body>'));
  const drawn = [...body.matchAll(/<span class="(?:v )?([sv]-[a-z]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
  assert.ok(drawn.length > 0);
  for (const t of tasks(body)) {
    const [, c, word] = /<span class="(s-[a-z]+)">([^<]+)<\/span>/.exec(t.raw) ?? [];
    assert.equal(c, `s-${taskState(word)}`, `${t.id}: ${word}`);
  }
  for (const [c, word] of drawn) {
    assert.ok(word.trim(), `${c} on a word`);
    if (c.startsWith('v-')) assert.equal(STATE_CLASSES[c], verdictState(word), word);
  }
  const bugRows = body.slice(body.indexOf('<section class="bugs">'), body.indexOf('<section class="drafts">'));
  for (const [, c, word] of bugRows.matchAll(/<span class="(s-[a-z]+)">([^<]+)<\/span>/g)) assert.equal(c, `s-${bugState(word)}`, word);
  const seen = new Set(drawn.map(([c]) => STATE_CLASSES[c]));
  for (const s of ['done', 'running', 'na', 'waits', 'failed']) assert.ok(seen.has(s), `the fixture draws ${s}`);
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
    assert.match(t.raw, /^<details class="task">\n<summary><b>[a-z]+\/[a-z-]+<\/b>: <span class="s-[a-z]+">[a-z ]+<\/span>[,<]/, 'the id, then the state, as text in its colour');
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

test('the drafts read in order after the tasks: a heading and a list after the last task group, before the lock, nothing decorative read (kirunak-drafts AC-9, AC-14)', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  assert.ok(!(await page(w)).includes('<section class="drafts">'), 'no group when no draft waits');
  draftsAt(w);
  const html = await page(w);
  const body = html.slice(html.indexOf('<body>'));
  assert.deepEqual(h2s(body), ['Working on now', 'proposed', 'queued', 'parked', 'done this week', 'Drafts', 'Lock, queue and running steps']);
  const at = body.indexOf('<h2>Drafts <span class="n">(2)</span></h2>');
  assert.ok(at > body.lastIndexOf('</details>') && at > body.indexOf('<div class="states">'), 'the Drafts heading after the last task group');
  assert.ok(at < body.indexOf('<section class="machine">'), 'and before the lock');
  assert.match(body.slice(at), new RegExp([
    '^<h2>Drafts <span class="n">\\(2\\)</span></h2>',
    '<ul>',
    '<li><b>weather/wind-alerts</b>: Wind alerts &lt;for&gt; cyclists, <span class="meta">written <time datetime="2026-11-05">2026-11-05</time></span></li>',
    '<li><b>hub/short-jobs</b>: Short jobs first [^<]*, <span class="meta">written <time datetime="2026-11-06">2026-11-06</time></span></li>',
    '</ul>',
    '</section>',
  ].join('\n')));
  const section = body.slice(body.indexOf('<section class="drafts">'), body.indexOf('<section class="machine">'));
  assert.equal(section.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
    'Drafts (2) weather/wind-alerts: Wind alerts &lt;for&gt; cyclists, written 2026-11-05 hub/short-jobs: Short jobs first in the heavy-job queue, ' +
    'so a quick test never waits behind a long build, written 2026-11-06', 'read as words, in order, with no mark between them');
  assert.ok(!/\saria-(?!hidden)|\srole=/.test(section), 'native semantics only');
  assert.ok(!/content:\s*['"][^'"]/.test(html), 'no CSS mark a reader would speak');
});

test('a bug\'s row in the Drafts group says bug of <task> before its date, in the text\'s colour, the date alone muted; the drafts\' rows as they were (kirunak-spikes AC-6, D-2)', async () => {
  const w = await fixture();
  draftsAt(w);
  bugAt(w);
  const html = await page(w);
  const section = html.slice(html.indexOf('<section class="drafts">'), html.indexOf('<section class="machine">'));
  assert.match(section, new RegExp([
    '<ul>',
    '<li><b>weather/wind-alerts</b>: Wind alerts &lt;for&gt; cyclists, <span class="meta">written <time datetime="2026-11-05">2026-11-05</time></span></li>',
    '<li><b>hub/short-jobs</b>: Short jobs first [^<]*, <span class="meta">written <time datetime="2026-11-06">2026-11-06</time></span></li>',
    '<li><b>hub/midnight-gap</b>: The chart skips the hour after midnight, bug of weather/recent, <span class="meta">written <time datetime="2026-11-07">2026-11-07</time></span></li>',
    '</ul>',
  ].join('\n')));
  assert.ok(section.replace(/<[^>]*>/g, '').includes('hub/midnight-gap: The chart skips the hour after midnight, bug of weather/recent, written 2026-11-07'), 'read as words, in order');
  assert.doesNotMatch(section, /spike/i, 'called a bug, never a spike');
});

test('the drafts\' text pairs are the page\'s, held at 4.5:1 in the light and the dark theme (kirunak-drafts AC-14)', async () => {
  const w = await fixture();
  draftsAt(w);
  const html = await page(w);
  const style = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  assert.match(style, /\.drafts li \{ background: var\(--card\);/, 'a draft row on the card ground');
  assert.match(style, /\.meta \{ color: var\(--muted\);/, 'its date muted');
  assert.doesNotMatch(style, /\.drafts[^{]*\{[^}]*\bcolor:/, 'no text colour of its own: text, and muted for the date; its edge is the colour of waits (gulnya/mobile-dialogs AC-8)');
  const light = tokens(/:root \{([^}]*)\}/.exec(html)[1]);
  const dark = tokens(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\} \}/.exec(html)[1]);
  for (const [fg, bg] of DRAFT_PAIRS) {
    assert.ok(TEXT_PAIRS.some(([f, b]) => f === fg && b === bg), `--${fg} on --${bg} is in the page's contrast test`);
    for (const [name, t] of [['light', light], ['dark', dark]]) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
  }
});

test('the bugs read in order before the drafts: a heading, k waiting\'s line and a list, after the last task group, nothing when none waits (gulnya/kirunak-bugs AC-7)', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  draftsAt(w);
  assert.ok(!(await page(w)).includes('<section class="bugs">'), 'no group when no bug waits');
  bugsAt(w);
  const html = await page(w);
  const body = html.slice(html.indexOf('<body>'));
  assert.deepEqual(h2s(body), ['Working on now', 'proposed', 'queued', 'parked', 'done this week', 'Bugs', 'Drafts', 'Lock, queue and running steps']);
  const at = body.indexOf('<section class="bugs">');
  assert.ok(at > body.lastIndexOf('</details>') && at < body.indexOf('<section class="drafts">'), 'after the last task group, before the drafts');
  assert.match(body.slice(at), new RegExp([
    '^<section class="bugs">',
    '<h2>Bugs <span class="n">\\(2\\)</span></h2>',
    '<p>2 bugs wait, 1 with a fix ready: /k-bugs</p>',
    '<ul>',
    '<li><b>hub/queue-stuck</b>: The queue keeps a finished job, <span class="s-waits">fix ready</span>, bug of weather/recent, <span class="meta">written <time datetime="2026-11-06">2026-11-06</time></span></li>',
    '<li><b>weather/rain-icon</b>: The rain icon shows &lt;sun&gt;, <span class="s-na">no fix</span>, <span class="meta">written <time datetime="2026-11-04">2026-11-04</time></span></li>',
    '</ul>',
    '</section>',
  ].join('\n')));
  const section = body.slice(at, body.indexOf('<section class="drafts">'));
  assert.equal(section.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
    'Bugs (2) 2 bugs wait, 1 with a fix ready: /k-bugs hub/queue-stuck: The queue keeps a finished job, fix ready, bug of weather/recent, written 2026-11-06 ' +
    'weather/rain-icon: The rain icon shows &lt;sun&gt;, no fix, written 2026-11-04', 'read as words, in order, with no mark between them');
  assert.ok(!/\saria-(?!hidden)|\srole=/.test(section), 'native semantics only');
});

test('the bugs\' text pairs are the page\'s, held at 4.5:1 in the light and the dark theme (gulnya/kirunak-bugs AC-7)', async () => {
  const w = await fixture();
  bugsAt(w);
  const html = await page(w);
  const style = /<style>([\s\S]*)<\/style>/.exec(html)[1];
  assert.match(style, /\.bugs li \{ background: var\(--card\);/, 'a bug row on the card ground');
  assert.doesNotMatch(style, /\.bugs[^{]*\{[^}]*\bcolor:/, 'no colour of the group\'s own: text, the line on the page\'s ground, muted for the date, the fix its state\'s (gulnya/mobile-dialogs AC-8)');
  const light = tokens(/:root \{([^}]*)\}/.exec(html)[1]);
  const dark = tokens(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{([^}]*)\} \}/.exec(html)[1]);
  assert.deepEqual(BUG_PAIRS, [['text', 'bg'], ['text', 'card'], ['muted', 'card']]);
  for (const [fg, bg] of BUG_PAIRS) {
    assert.ok(TEXT_PAIRS.some(([f, b]) => f === fg && b === bg), `--${fg} on --${bg} is in the page's contrast test`);
    for (const [name, t] of [['light', light], ['dark', dark]]) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
  }
});

test('Quad Damage\'s run in the Bugs group, as k waiting says it, first, on the page, in the markdown and in the brief; each bug it is on with the run\'s phase; nothing while none lives (gulnya/quad-damage AC-12)', async () => {
  const w = await fixture();
  bugsAt(w);
  const run = (fields) => {
    mkdirSync(dirname(quadDamagePath(w.home)), { recursive: true });
    writeFileSync(quadDamagePath(w.home), JSON.stringify({ pid: process.pid, started: '2026-11-07T11:40:05+00:00', by: 'owner', via: 'mod', folder: '/f', bug: 'hub/queue-stuck', ...fields }) + '\n');
  };
  const all = async () => {
    const list = await rows(w.ws, { all: true });
    const st = snapshot(w.ws);
    return { m: model(list, st, NOW), html: renderHtml(list, st, NOW), text: renderMarkdown(list, st, NOW), brief: renderBrief(list, st, NOW) };
  };
  let b = await all();
  assert.equal(b.m.quadDamageLine, '');
  assert.doesNotMatch(b.html + b.text + b.brief.text, /Quad Damage/);

  run({ phase: 'fixing', try: 1, since: '2026-11-07T11:41:00+00:00' });
  b = await all();
  const line = 'Quad Damage runs: hub/queue-stuck, fixing (try 1) since 11:41';
  assert.equal(b.m.quadDamageLine, line);
  assert.deepEqual(Object.keys(b.m).slice(Object.keys(b.m).indexOf('quadDamageLine'), Object.keys(b.m).indexOf('quadDamageLine') + 3), ['quadDamageLine', 'bugs', 'bugsLine']);
  assert.deepEqual(b.m.bugs.map((x) => [x.id, x.fix]), [['hub/queue-stuck', 'Quad Damage: fixing, try 1'], ['weather/rain-icon', 'no fix']]);
  assert.match(b.html, new RegExp(`<h2>Bugs <span class="n">\\(2\\)</span></h2>\n<p>${line.replace(/[()]/g, '\\$&')}</p>\n<p>2 bugs wait, 1 with a fix ready: /k-bugs</p>\n<ul>`));
  assert.match(b.html, /<li><b>hub\/queue-stuck<\/b>: The queue keeps a finished job, <span class="s-running">Quad Damage: fixing, try 1<\/span>, bug of weather\/recent,/);
  assert.ok(b.text.includes(`## Bugs (2)\n\n${line}\n\n2 bugs wait, 1 with a fix ready: /k-bugs\n\n- hub/queue-stuck`), b.text);
  const group = b.brief.groups.find((g) => g.name === 'Bugs');
  assert.deepEqual(group.lines.slice(0, 2), [line, '2 bugs wait, 1 with a fix ready: /k-bugs']);
  assert.deepEqual(group.ids, ['hub/queue-stuck', 'weather/rain-icon'], 'the ids as they were: the line is not a bug');

  run({ phase: 'waiting', try: 1, waitUntil: '2026-11-07T13:15:00+00:00' });
  b = await all();
  assert.equal(b.m.quadDamageLine, 'Quad Damage waits for the 5-hour window until 13:15');
  assert.equal(b.m.bugs[0].fix, 'Quad Damage: waiting for the 5-hour window until 13:15');
  const style = /<style>([\s\S]*)<\/style>/.exec(b.html)[1];
  assert.doesNotMatch(style, /\.bugs[^{]*\{[^}]*\bcolor:/, 'the line is text on the page\'s ground, a pair BUG_PAIRS holds at 4.5:1');
});

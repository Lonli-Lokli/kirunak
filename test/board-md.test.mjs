// Times on the board are local: the expected text below is read in UTC.
process.env.TZ = 'UTC';

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot } from '../lib/board.mjs';
import { bullet, counts, cut, one, renderMarkdown } from '../lib/board-md.mjs';
import { rows } from '../lib/list.mjs';
import { addTask, fixture, NOW, queuedAndParked, sessionsAt } from './board-fixture.mjs';
import { k } from './helpers.mjs';

const board = async (w) => renderMarkdown(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);

// No hard line break inside a paragraph or a list item (kirunak-phone S-10): no line goes on from the one before (an
// indented line, or text straight after a list item or a paragraph), so each is a heading, a list item, a paragraph
// standing between blank lines, or blank.
export function noHardBreak(text) {
  const lines = text.replace(/\n$/, '').split('\n');
  const item = (l) => /^(#{1,3} |- |\d+\. )\S/.test(l);
  lines.forEach((l, i) => {
    assert.ok(!/^\s/.test(l), `a line that goes on from the one before: ${l}`);
    if (l && !item(l)) {
      assert.ok(!lines[i - 1], `a paragraph line straight after another line: ${l}`);
      assert.ok(!lines[i + 1], `a paragraph line straight before another line: ${l}`);
    }
  });
}

test('headings, lists and paragraphs, no table, and no line broken inside a paragraph or an item however long', async () => {
  const w = await fixture();
  sessionsAt(w);
  const long = 'a-task-slug-that-runs-to-forty-letters-x';
  addTask(w.weather, `weather/${long}`, `A title of many words ${'that goes on and on '.repeat(5)}until it ends`);
  mkdirSync(join(w.home, 'guard'), { recursive: true });
  writeFileSync(join(w.home, 'guard', 'queue'), `{"session":"s2","what":"a heavy job named ${'at great length '.repeat(6)}"}\n`);
  const text = await board(w);
  noHardBreak(text);
  for (const line of text.split('\n')) assert.ok(!line.trimStart().startsWith('|'), 'no table');
  assert.ok(text.includes(`\n- weather/${long}: A title of m… (3 none)\n`));
  assert.ok(text.includes('\n- worked on by session s1 since 2026-11-07 11:00\n'));
  assert.ok(text.includes(`\n1. a heavy job named ${'at great length '.repeat(6).trim()} (session s2)\n`), 'a long row on one line');
  assert.ok(text.includes('\nAn hourly chart \\<for\\> today\n'), 'markdown in a title shows as written');
  assert.equal(text.split('kirunak').length - 1, 1, 'kirunak named once, in the first heading');
  assert.ok(text.startsWith('# kirunak board\n\nMade at 2026-11-07 12:00.\n'));
});

test('pane-sized: the cards\' AC and E cut at 70 characters with …, every other task one bullet on one line with its counts', async () => {
  const w = await fixture();
  sessionsAt(w);
  const edit = (repo, slug, f) => {
    const p = join(repo, 'kirunak', 'tasks', slug, 'task.md');
    writeFileSync(p, f(readFileSync(p, 'utf8')));
  };
  // Worked on now: an AC whose escapes fall where it is cut, and an E that runs on.
  addTask(w.weather, 'weather/cut-items', 'Items cut to fit');
  edit(w.weather, 'cut-items', (t) =>
    t
      .replace('- AC-1 The chart shows one point per hour.', `- AC-1 ${'Points read <below> & above zero, '.repeat(4)}`)
      .replace('- E-1 A missing hour leaves a gap.', `- E-1 A missing hour leaves a gap ${'and the next one too '.repeat(6)}`),
  );
  writeFileSync(join(w.home, 'sessions', 's4.json'), JSON.stringify({ task: 'weather/cut-items', since: '2026-11-07T11:30:00Z' }));
  // Not worked on: an id that leaves the title no room, and a task with no AC or E.
  const review = '| id | verdict | evidence |\n| --- | --- | --- |\n| AC-1 | met | a |\n| AC-2 | not met | b |\n| E-1 | needs device | c |\n';
  const roomless = 'an-id-leaving-a-title-too-little-room-xy';
  addTask(w.weather, `weather/${roomless}`, 'A title that has to go to the second line', { files: { 'review-1.md': review } });
  addTask(w.weather, 'weather/no-items', 'A task with nothing to judge yet');
  edit(w.weather, 'no-items', (t) => t.replace(/^- (AC|E)-\d .*\n/gm, ''));

  const text = await board(w);
  noHardBreak(text);
  const card = text.slice(text.indexOf('### weather/cut-items'), text.indexOf('\n## ', text.indexOf('### weather/cut-items')));
  assert.deepEqual(card.split('\n').filter((l) => /^- (AC|E)-/.test(l)), [
    '- AC-1 none: Points read \\<below\\> & above zero, Points read \\<below…',
    '- AC-2 none: Points read \\<below\\> & above zero.',
    '- E-1 none: A missing hour leaves a gap and the next one too and the…',
  ]);
  assert.ok(text.includes(`\n- weather/${roomless}: A title that… (1 met, 1 not met, 1 needs device)\n`), 'at least 12 characters of the title');
  assert.ok(text.includes('\n- weather/no-items: A task with nothing to judge yet\n'), 'no AC or E: nothing about verdicts');
  assert.ok(!text.includes('### weather/no-items') && !text.includes('### weather/recent'), 'only the tasks worked on now keep a card');
});

test('cut never splits an escape and keeps the tail; a bullet keeps its counts and leaves out a zero', () => {
  assert.equal(cut('- ', 'abc <def> ghi', '', 8), '- abc…');
  assert.equal(cut('- ', 'abc <def> ghi', '', 10), '- abc \\<d…');
  assert.equal(cut('- ', 'abc <def> ghi', '', 13), '- abc \\<def…');
  assert.equal(cut('- ', 'abc def', ' (1 met)', 17), '- abc def (1 met)');
  assert.equal(cut('- ', 'abc defgh', ' (1 met)', 17), '- abc de… (1 met)');
  assert.equal(cut('  ', '1. starts a list', '', 70, true), '  1\\. starts a list');
  const r = (verdicts) => ({ id: 'a/b', title: 'A title', ac: verdicts.map((v, i) => ({ id: `AC-${i + 1}`, text: 't', verdict: v })), e: [] });
  assert.equal(counts(r(['none', 'met', null, 'not met', 'met'])), '2 met, 1 not met, 2 none');
  assert.equal(counts(r([])), '');
  assert.deepEqual(bullet(r(['needs owner'])), ['- a/b: A title (1 needs owner)']);
  assert.deepEqual(bullet(r([])), ['- a/b: A title']);
  // However long the id, the bullet is one line and keeps 12 characters of the title and its counts.
  const long = `a/${'too-long-to-break-'.repeat(4)}x`;
  assert.deepEqual(bullet({ ...r(['met']), id: long, title: 'A title that goes on '.repeat(4) }), [`- ${long}: A title that… (1 met)`]);
});

test('a line never starts as a list, a heading or a rule, and its spaces and breaks are one space each', () => {
  assert.equal(one('- three\nfour', '- '), '- \\- three four');
  assert.equal(one('3. three  # four'), '3\\. three # four');
  assert.equal(one('# four', '1. '), '1. \\# four');
  assert.equal(one('', '- '), '-');
});

test('k board --markdown prints the board and writes nothing', async () => {
  const w = await fixture();
  const r = k(w.home, ['board', '--markdown']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('# kirunak board\n\nMade at '));
  assert.match(r.stdout, /\n## Working on now \(0\)\n\nNo session names a task and no step is running\.\n/);
  assert.match(r.stdout, /\n## Lock, queue and running steps\n/);
  assert.ok(!existsSync(join(w.home, 'board.html')));
});

// The fixture's board, word for word: what the mod's /k-board shows in the chat.
const EXPECTED = `# kirunak board

Made at 2026-11-07 12:00.

## Working on now (2)

### weather/hourly-chart

An hourly chart \\<for\\> today

- state: in progress, queue place 1
- step: 2026-11-03 14:02 S-2 started (opus, session 7c1)
- worked on by session s1 since 2026-11-07 11:00
- approved 2026-11-03

Verdicts:

- AC-1 none: The chart shows one point per hour.
- AC-2 none: Points read \\<below\\> & above zero.
- E-1 none: A missing hour leaves a gap.

### hub/reviewed

A reviewed task

- state: in review
- worked on by step S-3 running since 2026-11-07 11:40
- review: review-2.md, verdict: not met (AC-2)
- approved 2026-11-01

Verdicts:

- AC-1 met: The chart shows one point per hour.
- AC-2 not met: Points read \\<below\\> & above zero.
- E-1 none: A missing hour leaves a gap.

## proposed (1)

- weather/offline-forecast: The last forecast stays readable… (4 none)

## queued (1)

- weather/next-up: Next in line (3 none)

## parked (1)

- hub/later: Not yet (3 none)

## done this week (1)

- weather/recent: Done this week (3 none)

## Lock, queue and running steps

no lock

### Heavy-job queue

empty

### Running steps: 1 of 2

- hub/reviewed S-3, session s2, since 2026-11-07 11:40

### Device claims

none

### Task queue

1. weather/hourly-chart (in progress)
2. weather/next-up (queued)
`;

test('the fixture\'s board as the chat shows it: the working tasks, each state\'s tasks, the lock and the queues', async () => {
  const w = await fixture();
  sessionsAt(w);
  queuedAndParked(w);
  assert.equal(await board(w), EXPECTED);
});

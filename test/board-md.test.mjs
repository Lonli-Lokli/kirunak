// Times on the board are local: the expected text below is read in UTC.
process.env.TZ = 'UTC';

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshot } from '../lib/board.mjs';
import { renderMarkdown, WIDTH, wrap } from '../lib/board-md.mjs';
import { rows } from '../lib/list.mjs';
import { addTask, fixture, NOW, sessionsAt } from './board-fixture.mjs';
import { k } from './helpers.mjs';

const board = async (w) => renderMarkdown(await rows(w.ws, { all: true }), snapshot(w.ws), NOW);

test('headings and bullet lists, no table, no line over 70 characters but one unbreakable word', async () => {
  const w = await fixture();
  sessionsAt(w);
  const long = 'a-task-slug-that-runs-to-forty-letters-x';
  addTask(w.weather, `weather/${long}`, `A title of many words ${'that goes on and on '.repeat(5)}until it ends`);
  const text = await board(w);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= WIDTH || !/\s/.test(line.replace(/^(#+ |- |\d+\. |\s+)/, '')), `too long: ${line}`);
    assert.match(line, /^(|#{1,3} \S.*|- \S.*|\d+\. \S.*| {2,3}\S.*|[^\s|#-].*)$/, `a heading, a list item, its next line or text: ${line}`);
    assert.ok(!line.trimStart().startsWith('|'), 'no table');
  }
  assert.ok(text.includes(`### weather/${long}\n`));
  assert.ok(text.includes('\nAn hourly chart \\<for\\> today\n'), 'markdown in a title shows as written');
  assert.equal(text.split('kirunak').length - 1, 1, 'kirunak named once, in the first heading');
  assert.ok(text.startsWith('# kirunak board\n\nMade at 2026-11-07 12:00.\n'));
});

test('a wrapped line never starts as a list, a heading or a rule', () => {
  assert.deepEqual(wrap('one two - three', '- ', 10), ['- one two', '  \\- three']);
  assert.deepEqual(wrap('one two 3. three # four', '', 9), ['one two', '3\\. three', '\\# four']);
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

### weather/offline-forecast

The last forecast stays readable offline

- state: proposed

Verdicts:

- AC-1 none: With no network, the app opens on the last forecast it
  fetched, with the time it was fetched.
- AC-2 none: The forecast screen shows the fetch time in the reader's
  own time format.
- AC-3 none: Both phone platforms keep the last forecast across a
  restart.
- E-1 none: A forecast older than a day shows its age in words, not
  only a time.

## done this week (1)

### weather/recent

Done this week

- state: done
- approved 2026-11-01
- accepted 2026-11-06

Verdicts:

- AC-1 none: The chart shows one point per hour.
- AC-2 none: Points read \\<below\\> & above zero.
- E-1 none: A missing hour leaves a gap.

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
`;

test('the fixture\'s board as the chat shows it: the working tasks, each state\'s tasks, the lock and the queues', async () => {
  const w = await fixture();
  sessionsAt(w);
  assert.equal(await board(w), EXPECTED);
});

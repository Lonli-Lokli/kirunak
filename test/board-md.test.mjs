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

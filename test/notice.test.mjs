import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notice, PUSH, stopNotice, WIDTH } from '../lib/notice.mjs';

// Every notice fits a phone screen (S-2 design R7.1; AC-23..AC-25): at most 3 lines of at most 80 characters, the
// task's title and id first, the one thing to do last; `one` at most 200 characters on one line, for a push.
const fits = (n, width = WIDTH) => {
  assert.ok(n.lines.length <= 3, n.lines.join('\n'));
  assert.ok(n.lines.every((l) => l.length <= width && !l.includes('\n')), n.lines.join('\n'));
  assert.ok(n.one.length <= PUSH && !n.one.includes('\n'), n.one);
};

test('a short notice: what happened with the title and id on the first line, why, then the one thing to do', () => {
  const n = notice({ title: 'Wind alerts', id: 'weather/wind', step: 'S-2', what: 'stopped, failed 2 times', why: 'exit 1', next: 'read kirunak/tasks/wind/steps/S-2/failure-2.md' });
  assert.deepEqual(n.lines, ['Wind alerts (weather/wind): S-2 stopped, failed 2 times', 'why: exit 1', 'read kirunak/tasks/wind/steps/S-2/failure-2.md']);
  assert.equal(n.one, 'Wind alerts (weather/wind): S-2 stopped, failed 2 times. why: exit 1. read kirunak/tasks/wind/steps/S-2/failure-2.md');
  fits(n);
});

test('nothing to do says so; no why makes two lines; markdown marks and line breaks are taken out', () => {
  const n = notice({ title: 'The `cache` **stays**', id: 'weather/offline', step: 'S-1', what: 'climbed to opus' });
  assert.deepEqual(n.lines, ['The cache stays (weather/offline): S-1 climbed to opus', 'nothing is needed']);
  assert.deepEqual(notice({ title: 'A\ntitle', id: 'x/y', what: 'done', next: '  go\n on ' }).lines, ['A title (x/y): done', 'go on']);
});

test('a long title keeps the first line to itself, whole, and what happened opens the second; a longer one is cut there, never the id', () => {
  const title = 'Enforced escalation: kirunak counts failures and hands steps up';
  const n = notice({ title, id: 'gulnya/enforced-escalation', step: 'S-14', what: 'stopped, failed on every rung', why: 'missing outputs: '.repeat(10), next: 'read it' });
  assert.equal(n.lines[0], `${title.slice(0, 80 - ' (gulnya/enforced-escalation)'.length - 1)}… (gulnya/enforced-escalation)`);
  assert.match(n.lines[1], /^S-14 stopped, failed on every rung: missing outputs: .*…$/);
  assert.equal(n.lines[1].length, 80);
  fits(n);
  const short = notice({ title: 'Fifty characters of a title, give or take a word.', id: 'gulnya/enforced-escalation', step: 'S-14', what: 'stopped' });
  assert.equal(short.lines[0], 'Fifty characters of a title, give or take a word. (gulnya/enforced-escalation)');
  assert.equal(short.lines[1], 'S-14 stopped');
});

test('both limits hold for any length: 3 lines of 80 (or the width asked), one of 200', () => {
  const long = 'word '.repeat(80);
  for (const width of [80, 78]) {
    const n = notice({ title: long, id: `repo/${'slug-'.repeat(20)}`, step: 'S-1', what: long, why: long, next: long, width });
    fits(n, width);
    assert.equal(n.one.length, PUSH);
    assert.ok(n.lines[0].length === width && n.lines[0].endsWith('…'));
  }
});

test('a stop names the step\'s folder and its reports, the folder alone when that is too long; a question names where the answer goes', () => {
  const r = { title: 'Wind alerts', id: 'weather/wind' };
  const stop = { step: 'S-2', kind: 'escalated', what: 'stopped, failed on every rung', why: 'exit 1', dir: 'kirunak/tasks/wind/steps/S-2/', reports: [1, 2, 3, 4].map((k) => `steps/S-2/failure-${k}.md`) };
  assert.deepEqual(stopNotice(r, stop).lines, ['Wind alerts (weather/wind): S-2 stopped, failed on every rung', 'why: exit 1', 'read kirunak/tasks/wind/steps/S-2/ (failure-1.md … failure-4.md)']);
  assert.equal(stopNotice(r, { ...stop, reports: stop.reports.slice(0, 2) }).lines[2], 'read kirunak/tasks/wind/steps/S-2/ (failure-1.md, failure-2.md)');
  const dir = `kirunak/tasks/${'a-long-slug-'.repeat(4)}/steps/S-2/`;
  assert.equal(stopNotice(r, { ...stop, dir }).lines[2], `read ${dir}`);
  const asked = stopNotice(r, { step: 'S-3', kind: 'owner', what: 'waits for your answer', why: 'Which cache size?', dir: 'x', reports: [] });
  assert.deepEqual(asked.lines, ['Wind alerts (weather/wind): S-3 waits for your answer', 'why: Which cache size?', 'answer in a session or in notes.md, then start k run again']);
});

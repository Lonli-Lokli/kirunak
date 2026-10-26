import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryIn, CAP, cut, labelOf, lastOf, planFor, stateText, waitingLines } from '../hooks/compact-rules.mjs';

// The task put back after a compaction and after /clear (design/orchestrator.md §5, R5.1-R5.5).

// ---- The parts' text (R5.1) ----

const numbered = (n, width = 30) => `${Array.from({ length: n }, (_, i) => `line ${String(i).padStart(3, '0')} ${'y'.repeat(width)}`).join('\n')}\n`;

test('cut and lastOf: whole up to exactly CAP; over it, within CAP at a line end or start, naming the whole file', () => {
  const exact = `${'x'.repeat(CAP - 1)}\n`;
  assert.equal(cut(exact, CAP, '/r/task.md'), exact);
  assert.equal(lastOf(exact, CAP, '/r/progress.md'), exact);
  const text = numbered(400);
  const c = cut(text, CAP, '/r/plan.md');
  assert.ok(c.length <= CAP, `${c.length}`);
  assert.match(c, /\n… cut at 9,500 characters; the whole file: \/r\/plan\.md$/);
  assert.ok(text.startsWith(c.slice(0, c.lastIndexOf('\n') + 1)));
  const l = lastOf(text, CAP, '/r/progress.md');
  const [first, ...rest] = l.split('\n');
  assert.ok(l.length <= CAP, `${l.length}`);
  assert.equal(first, '… cut at 9,500 characters, its last lines kept; the whole file: /r/progress.md');
  assert.match(rest[0], /^line \d{3} y+$/);
  assert.ok(text.endsWith(rest.join('\n')));
  assert.equal(cut('z'.repeat(20000), CAP, 'f').length, CAP);
  assert.equal(lastOf('z'.repeat(20000), CAP, 'f').length, CAP);
});

const block = (id, size) => `### ${id} Step ${id} [agent]\nwhat: ${'w'.repeat(size)}\n\n`;
const planOf = (size) => `---\ntask: app/demo\n---\n\nThe header.\n\n${['S-1', 'S-2', 'S-3', 'S-4'].map((id) => block(id, size)).join('')}`;
const STATES = new Map([['S-1', { state: 'done' }], ['S-2', { state: 'running' }], ['S-3', 'ready'], ['S-4', 'pending']]);
const ids = (text) => [...text.matchAll(/^### (S-\d+)/gm)].map((m) => m[1]);

test('planFor: the header and the steps not finished; over CAP the running and ready ones; still over, cut', () => {
  const fits = planFor(planOf(2000), STATES, '/r/plan.md');
  assert.ok(fits.startsWith('---\ntask: app/demo\n---\n\nThe header.\n\n### S-2 '));
  assert.deepEqual(ids(fits), ['S-2', 'S-3', 'S-4']);
  assert.match(fits, /\n\n… left out, the blocks of S-1; the whole file: \/r\/plan\.md$/);
  const over = planFor(planOf(3200), STATES, '/r/plan.md');
  assert.deepEqual(ids(over), ['S-2', 'S-3']);
  assert.ok(over.length <= CAP, `${over.length}`);
  assert.match(over, /… left out, the blocks of S-1, S-4; the whole file: \/r\/plan\.md$/);
  const cutPlan = planFor(planOf(5000), STATES, '/r/plan.md');
  assert.ok(cutPlan.length <= CAP, `${cutPlan.length}`);
  assert.match(cutPlan, /\n… cut at [\d,]+ characters; the whole file: \/r\/plan\.md\n… left out, the blocks of S-1, S-4; /);
  assert.deepEqual(ids(planFor(planOf(100), new Map(), '/r/plan.md')), ['S-1', 'S-2', 'S-3', 'S-4']);
  assert.equal(planFor('# no steps\n', STATES, '/r/plan.md'), '# no steps\n');
});

test('labelOf, waitingLines (only the task\'s rows, each with what k says) and boundaryIn (R5.2)', () => {
  assert.equal(labelOf('plan', 'compact'), 'kirunak, after a compaction (part 3 of 4): plan');
  assert.equal(labelOf('state', 'clear'), 'kirunak, after /clear (part 1 of 4): state');
  const w = {
    stopped: [{ id: 'app/demo', lines: ['Demo (app/demo): S-2 is waiting for your answer', 'why: which file?'] }, { id: 'app/other', lines: ['x'] }],
    approve: [{ id: 'app/demo', why: null }],
    amendments: [{ id: 'app/demo', amendment: 'A-1', name: 'a wider scope', refuse: 'A-1 is not complete\nand more' }],
    accept: [{ id: 'app/other', why: null }],
  };
  assert.deepEqual(waitingLines(w, 'app/demo'), [
    'Demo (app/demo): S-2 is waiting for your answer', 'why: which file?', 'to approve: can approve',
    'amendment A-1: a wider scope, not yet: A-1 is not complete',
  ]);
  assert.deepEqual(waitingLines(w, 'app/none'), []);
  assert.deepEqual(waitingLines(null, 'app/demo'), []);
  const since = Date.parse('2026-01-05T11:57:00.000Z');
  const mark = (at, extra = {}) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at, content: 'Conversation compacted', ...extra });
  const reply = JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1 } } });
  assert.equal(boundaryIn(`cut line\n${reply}\n${mark('2026-01-05T11:59:00.000Z')}\n`, since), true);
  assert.equal(boundaryIn(`${mark('2026-01-05T11:59:00.000Z')}\n${reply}\n`, since), false);
  assert.equal(boundaryIn(`${reply}\n${mark('2026-01-05T11:56:59.000Z')}\n`, since), false);
  assert.equal(boundaryIn(`${reply}\n${mark('2026-01-05T11:59:00.000Z', { isSidechain: true })}\n`, since), false);
  assert.equal(boundaryIn('', since), false);
});

test('stateText: three sentences, the task, the running steps, k\'s text or its failure, the agents and the shells', () => {
  const f = {
    source: 'compact', task: 'app/demo', title: 'A demo task', dir: '/r/app/kirunak/tasks/demo', session: 's-main', chain: ['s-old'],
    running: [{ step: 'S-2', since: '2026-01-05 10:00' }], status: 'no lock\nrunning steps: 0 of 2\nsession s-main: app/demo',
    waiting: ['to approve: can approve'], home: '/r/home',
    agents: [{ id: 'a1', type: 'Explore', description: 'find the parser', outputFile: '/r/tasks/a1.output', at: '2026-01-05T10:05:00.000Z', by: null }],
    shells: { at: '2026-01-05T10:06:00.000Z', list: [{ id: 'b1', type: 'shell', status: 'running', command: 'node heavy-lock.mjs run -- make test' }] },
  };
  const lines = stateText(f).split('\n');
  assert.equal(lines[0], 'This is the same session, after a compaction, still on app/demo.');
  assert.match(lines[1], /^The parts task, plan and progress hold its task\.md, plan\.md and progress\.md /);
  assert.match(lines[2], /^Go on from progress\.md's last line: start no step again, and ask the owner nothing already answered\.$/);
  assert.deepEqual(lines.slice(4), [
    'task: app/demo: A demo task', 'folder: /r/app/kirunak/tasks/demo', 'session: s-main, earlier ids s-old',
    'running steps of this session: S-2 (started 2026-01-05 10:00)', 'k status --session s-main:', '  no lock',
    '  running steps: 0 of 2', '  session s-main: app/demo', 'k waiting, the lines of this task:', '  to approve: can approve',
    'running agents:', '  find the parser: Explore, id a1, launched 2026-01-05T10:05:00.000Z; output /r/tasks/a1.output',
    'background shell tasks at the last Stop (2026-01-05T10:06:00.000Z):', '  b1 running: node heavy-lock.mjs run -- make test',
  ]);
  const bare = stateText({ ...f, source: 'clear', from: 's-old', chain: [], running: [], status: { failed: 'no workspace' }, waiting: { failed: 'no workspace' }, agents: [], shells: null });
  assert.match(bare, /^This is the same session, after \/clear \(it was session s-old\), still on app\/demo\.\n/);
  for (const l of ['running steps of this session: none, a step boundary', '  k status failed: no workspace', '  k waiting failed: no workspace', 'running agents:\n  none', 'background shell tasks at the last Stop:\n  none']) {
    assert.ok(bare.includes(l), l);
  }
});

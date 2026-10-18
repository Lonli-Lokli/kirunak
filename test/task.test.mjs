import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES } from './helpers.mjs';
import { parseTags } from '../lib/source.mjs';
import { checkTask, intakeQuestions, isReady, parseTask } from '../lib/task.mjs';

const DIR = join(FIXTURES, 'workspace', 'weather', 'kirunak', 'tasks', 'offline-forecast');
const TASK = readFileSync(join(DIR, 'task.md'), 'utf8');
const INTAKE = readFileSync(join(DIR, 'intake.md'), 'utf8');
const ASPECTS = ['platforms', 'large-text', 'offline'];

const check = (text, aspects = ASPECTS, opts = {}) => checkTask(parseTask(text), aspects, opts);
const has = (problems, re) => problems.some((p) => re.test(p.problem));
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('the invented finished task passes', () => {
  assert.deepEqual(check(TASK, ASPECTS, { intakeQs: intakeQuestions(INTAKE), id: 'weather/offline-forecast' }), []);
  assert.equal(isReady(parseTask(TASK), ASPECTS), true);
});

test('an unsourced line fails with its number', () => {
  const text = TASK.replace('in the reader\'s own time format. [owner 2026-11-02 Q-2]', 'in the reader\'s own time format.');
  const problems = check(text);
  const at = lineOf(text, 'AC-2');
  assert.ok(problems.some((p) => p.line === at && /no source/.test(p.problem)), JSON.stringify(problems));
});

test('each tag kind parses', () => {
  assert.deepEqual(parseTags('x [owner 2026-11-02 Q-4]'), [{ kind: 'owner', date: '2026-11-02', q: 'Q-4' }]);
  assert.deepEqual(parseTags('x [research docs/offline.md §2]'), [{ kind: 'research', ref: 'docs/offline.md §2' }]);
  assert.deepEqual(parseTags('x [research https://example.com/a]'), [{ kind: 'research', ref: 'https://example.com/a' }]);
  assert.deepEqual(parseTags('x [default 2026-11-02]'), [{ kind: 'default', date: '2026-11-02' }]);
  assert.deepEqual(parseTags('x [owner 2026-11-02 Q-1] [from openspec/changes/a/tasks.md 3.2]'), [
    { kind: 'owner', date: '2026-11-02', q: 'Q-1' },
    { kind: 'from', ref: 'openspec/changes/a/tasks.md 3.2' },
  ]);
  assert.equal(parseTags('x with no tag'), null);
  assert.equal(parseTags('x [owner 2026-13-40 Q-1]'), null);
  assert.equal(parseTags('x [owner 2026-11-02]'), null);
});

test('[from ...] alone fails', () => {
  const text = TASK.replace('[owner 2026-11-02 Q-5] [from', '[from');
  assert.ok(has(check(text), /background, not a source/));
});

test('a malformed tag is named', () => {
  const text = TASK.replace('[owner 2026-11-02 Q-6]', '[owner 2026-11-02]');
  assert.ok(has(check(text), /malformed tag \[owner 2026-11-02\]/));
});

test('a Q-n line makes the task not ready', () => {
  const text = TASK.replace('## Open questions\n', '## Open questions\n- Q-9 Should alerts come back online? \n');
  const parsed = parseTask(text);
  assert.equal(isReady(parsed, ASPECTS), false);
  assert.ok(has(checkTask(parsed, ASPECTS), /Q-9 is open/));
});

test('a gap in AC numbering fails', () => {
  const text = TASK.replace('- AC-2 The forecast screen', '- AC-4 The forecast screen');
  assert.ok(has(check(text), /AC numbering has a gap: AC-2 is missing/));
});

test('a number an amendment removed is a gap that stays, and is never reused', () => {
  const gap = TASK.replace('- AC-2 The forecast screen', '- AC-4 The forecast screen');
  assert.ok(!has(check(gap, ASPECTS, { removed: new Set(['AC-2']) }), /gap/));
  assert.ok(has(check(TASK, ASPECTS, { removed: new Set(['AC-2']) }), /AC-2 was removed by an amendment/));
});

test('sections out of order fail', () => {
  const text = TASK.replace('## Edge cases', '## Swap').replace('## Out of scope', '## Edge cases').replace('## Swap', '## Out of scope');
  assert.ok(has(check(text), /out of order/));
});

test('a missing or unknown section fails', () => {
  assert.ok(has(check(TASK.replace('## Decisions\n- D-1 Keep the last three days of forecasts, no more. [owner 2026-11-02 Q-6]\n', '')), /missing section ## Decisions/));
  assert.ok(has(check(TASK.replace('## Decisions', '## Choices')), /unknown section/));
});

test('an aspect missing from Aspects fails', () => {
  const text = TASK.replace('- offline: in (AC-1, E-1) [default 2026-11-02]\n', '');
  assert.ok(has(check(text), /aspect offline of the checklist is missing/));
});

test('an unknown aspect fails', () => {
  const text = TASK.replace('## Open questions', '- rtl: n/a: no text [default 2026-11-02]\n\n## Open questions');
  assert.ok(has(check(text), /aspect rtl is not in the loaded checklist/));
});

test('an open aspect fails', () => {
  const text = TASK.replace('- offline: in (AC-1, E-1) [default 2026-11-02]', '- offline: ? [open]');
  assert.ok(has(check(text), /aspect offline is open/));
});

test('in naming no existing line fails', () => {
  const text = TASK.replace('in (AC-1, E-1)', 'in (AC-1, E-4)');
  assert.ok(has(check(text), /names E-4, which the task does not have/));
});

test('n/a without a reason fails', () => {
  const text = TASK.replace('n/a: the forecast screen keeps its layout', 'n/a:');
  assert.ok(has(check(text), /n\/a without a reason/));
});

test('CRLF fails', () => {
  assert.ok(has(check(TASK.replace(/\n/g, '\r\n')), /CRLF/));
});

test('front matter is checked', () => {
  assert.ok(has(check(TASK.replace('created: 2026-11-02\n', '')), /front matter has no created/));
  assert.ok(has(check(TASK, ASPECTS, { id: 'weather/other' }), /not this task's id/));
});

test('an owner tag must point at an intake entry', () => {
  const text = TASK.replace('[owner 2026-11-02 Q-6]', '[owner 2026-11-02 Q-12]');
  assert.ok(has(check(text, ASPECTS, { intakeQs: intakeQuestions(INTAKE) }), /Q-12 is not an entry in intake.md/));
});

test('acceptance criteria cannot be empty', () => {
  const text = TASK.replace(/- AC-1[^\n]*\n- AC-2[^\n]*\n- AC-3[^\n]*\n/, '');
  assert.ok(has(check(text), /at least one AC-n line/));
});

test('a line under the wrong section fails', () => {
  const text = TASK.replace('- E-1 A forecast', '- AC-4 A forecast');
  assert.ok(has(check(text), /AC-4 is under Edge cases/));
});

test('the skeleton with open aspects is a draft', () => {
  const skeleton = [
    '---', 'id: weather/x', 'title: X', 'created: 2026-11-02', '---', '',
    '## Goal', '', '## Acceptance criteria', '', '## Edge cases', '', '## Out of scope', '', '## Decisions', '',
    '## Aspects', '- platforms: ? [open]', '- large-text: ? [open]', '- offline: ? [open]', '', '## Open questions', '',
  ].join('\n');
  const problems = check(skeleton);
  assert.ok(has(problems, /Goal is empty/));
  assert.equal(problems.filter((p) => /is open/.test(p.problem)).length, 3);
});

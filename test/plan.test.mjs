import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlan, parseBudget, parsePlan } from '../lib/plan.mjs';
import { parseTask } from '../lib/task.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { k, makeWorkspace } from './helpers.mjs';

const ID = 'weather/offline-forecast';

// The plan of orchestrator.md §1, for the fixture task (AC-1..3, E-1, D-1).
export const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent, sonnet, high]
covers: AC-1, AC-2, E-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv
budget: 100 calls, 40 minutes, 3 USD
brief: steps/S-1/brief.md

### S-2 Unit tests [heavy]
needs: S-1
command: npm test
what: weather unit tests, 4 minutes
max-minutes: 10
outputs: evidence/S-2-tests.xml

### S-3 Review [review]
needs: S-2
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

async function fixture() {
  const w = await makeWorkspace();
  const p = taskPaths(w.ws, ID);
  return { ...w, p, task: parseTask(readFileSync(p.task, 'utf8')) };
}

const problemsOf = (w, text) => checkPlan(parsePlan(text), w.task, w.p).map((x) => x.problem);

test('the plan of the design parses: kinds, model, effort, lists, budget', () => {
  const { front, steps, problems } = parsePlan(PLAN);
  assert.deepEqual(problems, []);
  assert.deepEqual(front, { task: ID, blockedBy: [] });
  assert.deepEqual(steps.map((s) => [s.id, s.kind, s.model, s.effort]), [
    ['S-1', 'agent', 'sonnet', 'high'], ['S-2', 'heavy', null, null], ['S-3', 'review', null, null],
  ]);
  assert.deepEqual(steps[0].covers, ['AC-1', 'AC-2', 'E-1']);
  assert.deepEqual(steps[0].budget, { calls: 100, minutes: 40, usd: 3 });
  assert.equal(steps[1].command, 'npm test');
  assert.equal(steps[1].maxMinutes, 10);
  assert.deepEqual(steps[2].needs, ['S-2']);
  assert.deepEqual(parseBudget('3 USD, 1 call'), { usd: 3, calls: 1, bad: [] });
});

test('a full plan passes the check', async () => {
  const w = await fixture();
  assert.deepEqual(problemsOf(w, PLAN), []);
});

test('an uncovered E fails, and so does an uncovered AC', async () => {
  const w = await fixture();
  const text = PLAN.replace('covers: AC-1, AC-2, E-1', 'covers: AC-1, AC-2').replace('covers: all\n', 'covers: AC-3\n');
  assert.deepEqual(problemsOf(w, text), ['E-1 is covered by no step']);
  assert.deepEqual(problemsOf(w, text.replace('covers: AC-3', 'covers: E-1')), ['AC-3 is covered by no step']);
});

test('an unknown id fails', async () => {
  const w = await fixture();
  assert.deepEqual(problemsOf(w, PLAN.replace('AC-2, E-1', 'AC-2, E-1, E-3')), ['S-1 covers E-3, which the task does not have']);
});

test('an input no step produces fails; one a step produces or the repo has passes', async () => {
  const w = await fixture();
  assert.deepEqual(problemsOf(w, PLAN.replace('inputs: task, docs/offline.md', 'inputs: task, docs/none.md')), [
    'S-1 input docs/none.md: no earlier step produces it and no file in the repo matches',
  ]);
  // A later step's output is not an earlier one's.
  const late = PLAN.replace('inputs: task, docs/offline.md', 'inputs: task, evidence/S-2-tests.xml');
  assert.deepEqual(problemsOf(w, late), ['S-1 input evidence/S-2-tests.xml: no earlier step produces it and no file in the repo matches']);
  // A file in the task folder counts, as a folder an earlier step writes into does (evidence/).
  mkdirSync(join(w.p.dir, 'steps', 'S-1'), { recursive: true });
  writeFileSync(join(w.p.dir, 'steps', 'S-1', 'notes.txt'), 'x');
  assert.deepEqual(problemsOf(w, PLAN.replace('inputs: task, docs/offline.md', 'inputs: task, steps/S-1/notes.txt')), []);
});

test('the grammar: a bad header, an unknown kind, effort or field, a needs no step has, a heavy step with no command', async () => {
  const w = await fixture();
  const bad = PLAN.replace('[agent, sonnet, high]', '[agnet, sonnet, hgih]')
    .replace('needs: S-1\n', 'needs: S-9\n')
    .replace('command: npm test\n', 'comand: npm test\n')
    .replace('### S-3 Review [review]', '### S-3 Review');
  assert.deepEqual(problemsOf(w, bad), [
    'S-1: unknown kind agnet; the kinds are agent, heavy, review, owner, sync',
    'S-1: unknown effort hgih; the levels are low, medium, high, xhigh, max',
    'S-2: not a plan field: comand: npm test',
    'a step is `### S-n <title> [<kind>[, <model>[, <effort>]]]`',
    'S-2 needs S-9, which the plan does not have',
    'S-2 is a heavy step with no command',
    'AC-3 is covered by no step',
  ]);
  assert.deepEqual(problemsOf(w, PLAN.replace('task: weather/offline-forecast', 'task: weather/other')), [
    'the plan is for weather/other, not weather/offline-forecast',
  ]);
});

test('an [escalate] mark parses with and without a model', () => {
  const text = PLAN.replace('[agent, sonnet, high]', '[agent, sonnet, high] [escalate: opus, xhigh]').replace('[heavy]', '[heavy] [escalate]');
  const { steps, problems } = parsePlan(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(steps[0].escalate, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(steps[1].escalate, { model: null, effort: null });
  assert.equal(steps[2].escalate, null);
});

test('k plan check reports the problems and exits 1, and passes a good plan', async () => {
  const w = await fixture();
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN.replace('AC-2, E-1', 'AC-2').replace('covers: all\n', 'covers: AC-3\n'));
  const bad = k(w.home, ['plan', 'check', ID]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /E-1 is covered by no step/);
  writeFileSync(join(w.p.dir, 'plan.md'), PLAN);
  const good = k(w.home, ['plan', 'check', ID]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /plan: check passes/);
});

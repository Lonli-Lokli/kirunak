import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlan, parseBudget, parsePlan, VERIFY_SINCE } from '../lib/plan.mjs';
import { gate, load } from '../lib/steps.mjs';
import { parseTask } from '../lib/task.mjs';
import { taskPaths } from '../lib/workspace.mjs';
import { approvedWorkspace, k, makeWorkspace } from './helpers.mjs';

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
verify: npm test

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

test('a [heavy] step may state expect-minutes; none is null; one that is no number or is over the step\'s max is refused (gulnya/heavy-queue-nearest-done E-1, E-3)', () => {
  const stated = parsePlan(PLAN.replace('max-minutes: 10\n', 'max-minutes: 10\nexpect-minutes: 4\n'));
  assert.deepEqual(stated.problems, []);
  assert.equal(stated.steps[1].expectMinutes, 4);
  assert.equal(parsePlan(PLAN).steps[1].expectMinutes, null, 'none stated: the guard reads the max');
  const over = parsePlan(PLAN.replace('max-minutes: 10\n', 'max-minutes: 10\nexpect-minutes: 12\n'));
  assert.deepEqual(over.problems.map((x) => x.problem), ['S-2: expect-minutes 12 is larger than its max of 10 minutes']);
  const noMax = parsePlan(PLAN.replace('max-minutes: 10\n', 'budget: 30 minutes\nexpect-minutes: 31\n'));
  assert.deepEqual(noMax.problems.map((x) => x.problem), ['S-2: expect-minutes 31 is larger than its max of 30 minutes'], 'with no max-minutes, the budget\'s minutes are the max');
  for (const bad of ['0', 'soon', '-3']) {
    const r = parsePlan(PLAN.replace('max-minutes: 10\n', `max-minutes: 10\nexpect-minutes: ${bad}\n`));
    assert.deepEqual(r.problems.map((x) => x.problem), ['S-2: expect-minutes is a number of minutes'], bad);
  }
});

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

test('parsePlan keeps the text above the first step as header, trimmed, and \'\' when a step comes first (gulnya/brief-what-and-header)', () => {
  const header = '# Rules\n\nBuild at the lock.\n\nKeep images out of git.';
  assert.equal(parsePlan(PLAN.replace('---\n\n### S-1', `---\n\n${header}\n\n### S-1`)).header, header);
  assert.equal(parsePlan(PLAN).header, '');
  assert.equal(parsePlan(`${header}\n\n### S-1 Build [agent]\ncovers: all\n`).header, header, 'no front matter: the header from the first line');
  assert.equal(parsePlan('### S-1 Build [agent]\ncovers: all\n').header, '');
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

test('a plan with no review step fails k plan check, and a task already running is told so at its next step', async () => {
  const w = await fixture();
  const none = PLAN.replace('### S-3 Review [review]', '### S-3 Review [agent]');
  const problem = 'the plan has no review step, and k accept needs a review: add a step of kind review (outputs: review.md)';
  assert.deepEqual(problemsOf(w, none), [problem]);
  writeFileSync(join(w.p.dir, 'plan.md'), none);
  const r = k(w.home, ['plan', 'check', ID]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`line 1: ${problem.replace(/[()]/g, '\\$&')}`));
  const a = await approvedWorkspace(none);
  writeFileSync(join(a.p.dir, 'progress.md'), '2026-11-03 14:02 S-1 started (by hand)\n2026-11-03 15:10 S-1 finished\n');
  const next = k(a.home, ['step', 'start', ID, 'S-2']);
  assert.equal(next.status, 1);
  assert.match(next.stderr, new RegExp(`cannot run a step:\n {2}plan\\.md line 1: ${problem.replace(/[()]/g, '\\$&')}`));
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

test('an input naming a step\'s needs.json fails, there or not, naming the needs-<k>.json it moved to; that one passes', async () => {
  const w = await fixture();
  const naming = (input) => PLAN.replace('inputs: task, diff, evidence/', `inputs: task, diff, evidence/, ${input}`);
  const problem = (use) => `S-3 input steps/S-1/needs.json: a needs.json is S-1's request while its run goes on, and it moves to needs-<k>.json when that run ends; name ${use}, or notes.md, which holds the owner's answer`;
  assert.deepEqual(problemsOf(w, naming('steps/S-1/needs.json')), [problem('the needs-<k>.json it moves to')]);
  // A live request is refused as well: by the time S-3 starts, S-1's run has ended and the file has moved.
  mkdirSync(join(w.p.dir, 'steps', 'S-1'), { recursive: true });
  for (const f of ['needs-1.json', 'needs-2.json', 'needs.json']) writeFileSync(join(w.p.dir, 'steps', 'S-1', f), '{}');
  assert.deepEqual(problemsOf(w, naming('steps/S-1/needs.json')), [problem('steps/S-1/needs-2.json')]);
  assert.deepEqual(problemsOf(w, naming('steps/S-1/needs-2.json')), []);
  // k plan check says so, and so does the gate of a task already running.
  writeFileSync(join(w.p.dir, 'plan.md'), naming('steps/S-1/needs.json'));
  const r = k(w.home, ['plan', 'check', ID]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 21: S-3 input steps\/S-1\/needs\.json: a needs\.json is S-1's request/);
  const a = await approvedWorkspace(naming('steps/S-1/needs.json'));
  const start = k(a.home, ['step', 'start', ID, 'S-1']);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /cannot run a step:\n {2}plan\.md line 21: S-3 input steps\/S-1\/needs\.json/);
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
    'the plan has no review step, and k accept needs a review: add a step of kind review (outputs: review.md)',
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

test('a stop\'s failures: field parses as a list, and k plan check accepts it beside an old [escalate: fable, xhigh] mark', async () => {
  const stopped = PLAN.replace('[agent, sonnet, high]\n', '[agent, sonnet, high] [escalate: fable, xhigh]\n')
    .replace('brief: steps/S-1/brief.md\n', 'brief: steps/S-1/brief.md\nfailures: steps/S-1/failure-1.md, steps/S-1/failure-2.md, steps/S-1/failure-3.md\n');
  const { steps, problems } = parsePlan(stopped);
  assert.deepEqual(problems, []);
  assert.deepEqual(steps[0].failures, ['steps/S-1/failure-1.md', 'steps/S-1/failure-2.md', 'steps/S-1/failure-3.md']);
  assert.deepEqual(steps[0].escalate, { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(steps[1].failures, [], 'a step that never stopped has none');
  const w = await fixture();
  writeFileSync(join(w.p.dir, 'plan.md'), stopped);
  const r = k(w.home, ['plan', 'check', ID]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plan: check passes/);
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

// gulnya/k-run-step-models AC-2: an agent step on Sonnet names the check that proves it.
const UNVERIFIED = PLAN.replace('verify: npm test\n', '');
const NO_VERIFY = 'S-1 is an agent step on Sonnet with no verify line: add `verify: <command>`, the check k run runs as it ends';

test('an agent step on Sonnet with no verify line is refused, naming the step; its plan line\'s model, else models.agent; one with a verify line, or on Opus, passes (AC-2)', async () => {
  const w = await fixture();
  assert.equal(parsePlan(PLAN).steps[0].verify, 'npm test');
  assert.deepEqual(problemsOf(w, PLAN), []);
  assert.deepEqual(checkPlan(parsePlan(UNVERIFIED), w.task, w.p), [{ line: 6, problem: NO_VERIFY }]);
  assert.deepEqual(problemsOf(w, UNVERIFIED.replace('[agent, sonnet, high]', '[agent, opus, high]')), []);
  // No model on the line: the workspace's models.agent decides.
  const bare = UNVERIFIED.replace('[agent, sonnet, high]', '[agent]');
  assert.deepEqual(checkPlan(parsePlan(bare), w.task, w.p, { models: { agent: { model: 'claude-sonnet-5-5' } } }).map((x) => x.problem), [NO_VERIFY]);
  assert.deepEqual(checkPlan(parsePlan(bare), w.task, w.p, { models: { agent: { model: 'opus' } } }), []);
  writeFileSync(join(w.p.dir, 'plan.md'), UNVERIFIED);
  const r = k(w.home, ['plan', 'check', ID]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 6: S-1 is an agent step on Sonnet with no verify line/);
});

test('a task first approved before the rule gets the same finding as a warning: k plan check passes and the gate runs it; one approved since is refused (E-3)', async () => {
  const w = await approvedWorkspace(UNVERIFIED);
  const record = JSON.parse(readFileSync(w.p.record, 'utf8'));
  const approvedOn = (day) => {
    const at = `${day}T10:00:00+00:00`;
    writeFileSync(w.p.record, JSON.stringify({ ...record, approved: '2099-01-01T10:00:00+00:00', history: [{ ...record.history[0], approved: at }] }));
  };
  approvedOn('2026-10-28');
  const old = k(w.home, ['plan', 'check', ID]);
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /plan: check passes\n {2}warning, line 6: S-1 is an agent step on Sonnet with no verify line: .* \(a warning: weather\/offline-forecast was approved before 2026-11-05\)/);
  assert.deepEqual(gate(load(w.ws, ID)).filter((x) => x.startsWith('plan.md')), []);
  approvedOn(VERIFY_SINCE);
  const since = k(w.home, ['plan', 'check', ID]);
  assert.equal(since.status, 1);
  assert.match(since.stderr, /line 6: S-1 is an agent step on Sonnet with no verify line/);
  assert.deepEqual(gate(load(w.ws, ID)).filter((x) => x.startsWith('plan.md')), [`plan.md line 6: ${NO_VERIFY}`]);
});

test('a step\'s tools: is all or nothing; any other list is a problem (gulnya/k-run-step-models AC-4)', () => {
  const plan = (tools) => `### S-1 Shoot the phone [agent]\noutputs: steps/S-1/report.md\n${tools === undefined ? '' : `tools: ${tools}\n`}`;
  assert.deepEqual([parsePlan(plan()).steps[0].tools, parsePlan(plan()).problems], [null, []]);
  assert.deepEqual([parsePlan(plan('all')).steps[0].tools, parsePlan(plan('all')).problems], ['all', []]);
  assert.deepEqual(parsePlan(plan('Read, Bash')).problems.map((x) => x.problem), ['S-1: tools is `all` or nothing, not Read, Bash']);
});

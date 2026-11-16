import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetOf, checkPlan, FAST_QUEUE_SINCE, fastQueue, parseBudget, parsePlan, VERIFY_SINCE } from '../lib/plan.mjs';
import { gate, load } from '../lib/steps.mjs';
import { parseTask } from '../lib/task.mjs';
import { checkPlanSettings, taskPaths } from '../lib/workspace.mjs';
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
command: npm test -- --test-reporter=junit --test-reporter-destination=evidence/S-2-tests.xml
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
  assert.deepEqual(front, { task: ID, blockedBy: [], release: false });
  assert.deepEqual(steps.map((s) => [s.id, s.kind, s.model, s.effort]), [
    ['S-1', 'agent', 'sonnet', 'high'], ['S-2', 'heavy', null, null], ['S-3', 'review', null, null],
  ]);
  assert.deepEqual(steps[0].covers, ['AC-1', 'AC-2', 'E-1']);
  assert.deepEqual(steps[0].budget, { calls: 100, minutes: 40, usd: 3 });
  assert.equal(steps[1].command, 'npm test -- --test-reporter=junit --test-reporter-destination=evidence/S-2-tests.xml');
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

// gulnya/chooser-quality S-17 (2026-11-08): plan check passed a review reading review.md, and its brief refused it.
test('a review step reading more than task, diff and evidence/ fails k plan check, as its brief would', async () => {
  const w = await fixture();
  writeFileSync(join(w.p.dir, 'review.md'), 'an earlier review\n');
  const wide = PLAN.replace('inputs: task, diff, evidence/\noutputs: review.md', 'inputs: task, diff, evidence/, review.md\noutputs: review-2.md');
  const problem = 'S-3 is a review: review.md is outside its three inputs (task, diff, evidence/)';
  assert.deepEqual(problemsOf(w, wide), [problem]);
  assert.deepEqual(problemsOf(w, PLAN), []);
});

// The brief's other refusal (review-1 of gulnya/plan-check-review-inputs): a review whose outputs name no review file.
test('a review step whose outputs name no review file fails k plan check, as its brief would', async () => {
  const w = await fixture();
  writeFileSync(join(w.p.dir, 'review.md'), 'an earlier review\n');
  const none = PLAN.replace('inputs: task, diff, evidence/\noutputs: review.md', 'inputs: task, diff, evidence/\noutputs: report.md');
  assert.notEqual(none, PLAN);
  assert.deepEqual(problemsOf(w, none), ['S-3 is a review: its outputs name no review file (review.md, review-2.md, ...)']);
  const both = PLAN.replace('inputs: task, diff, evidence/\noutputs: review.md', 'inputs: task, diff, evidence/, review.md\noutputs: report.md');
  assert.deepEqual(problemsOf(w, both), [
    'S-3 is a review: review.md is outside its three inputs (task, diff, evidence/); its outputs name no review file (review.md, review-2.md, ...)',
  ]);
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
  // S-3 reads the request as an agent step: a review reads task, diff and evidence/ alone, so S-4 reviews.
  const base = `${PLAN.replace('### S-3 Review [review]', '### S-3 Read the evidence [agent, opus, high]')}
### S-4 Review [review]
needs: S-3
covers: all
inputs: task, diff, evidence/
outputs: review-2.md
`;
  const naming = (input) => base.replace('inputs: task, diff, evidence/', `inputs: task, diff, evidence/, ${input}`);
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
    .replace('command: npm test -- --test-reporter=junit --test-reporter-destination=evidence/S-2-tests.xml\n', 'comand: npm test\n')
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
    'S-2 is a heavy step beside S-1, which neither needs it nor is needed by it: make S-2 need S-1, so the heavy work runs after the work that does not take its output',
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

// gulnya/heavy-retry-unchanged AC-6: a [heavy] step's output its command never names is warned about, never refused.
test('k plan check warns about a [heavy] step\'s output its command never names, naming the step and the path; none when the command names it (gulnya/heavy-retry-unchanged AC-6)', async () => {
  const w = await fixture();
  const unnamed = PLAN.replace('command: npm test -- --test-reporter=junit --test-reporter-destination=evidence/S-2-tests.xml\n', 'command: npm test\n');
  const WARN = 'S-2\'s command never names evidence/S-2-tests.xml: k run fails the step "missing outputs" after its job passes';
  assert.deepEqual(checkPlan(parsePlan(unnamed), w.task, w.p), [{ line: 14, problem: WARN, warning: true }]);
  assert.deepEqual(checkPlan(parsePlan(PLAN), w.task, w.p), [], 'the command names the path');
  writeFileSync(join(w.p.dir, 'plan.md'), unnamed);
  const r = k(w.home, ['plan', 'check', ID]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plan: check passes\n {2}warning, line 14: S-2's command never names evidence\/S-2-tests\.xml: k run fails the step "missing outputs" after its job passes/);
});

// gulnya/fast-heavy-queue: the heavy and store-set rules. `step` writes one step block; `fq` runs the rules alone on a
// task with no approval record, where every finding refuses.
const step = (id, title, kind, ...fields) => `### ${id} ${title} [${kind}]\n${fields.map((f) => `${f}\n`).join('')}`;
const planOf = (front, ...steps) => `---\ntask: ${ID}\n${front}---\n\n${steps.join('\n')}`;
const fq = (text, ws = null) => {
  const plan = parsePlan(text);
  assert.deepEqual(plan.problems, []);
  return fastQueue(plan, null, ws).map((x) => x.problem);
};
const REVIEW = (...needs) => step('S-9', 'Review', 'review', `needs: ${needs.join(', ')}`, 'covers: all', 'inputs: task, diff, evidence/', 'outputs: review.md');

test('the new fields parse: long, sooner, final, resumable and the front matter\'s release; a bad value is a problem (gulnya/fast-heavy-queue)', () => {
  const p = parsePlan(planOf('release: yes\n',
    step('S-1', 'Tests', 'heavy', 'command: npm test', 'long: a device boot', 'resumable: yes'),
    step('S-2', 'Store set', 'agent', 'final: yes', 'sooner: the owner asked'),
  ));
  assert.deepEqual(p.problems, []);
  assert.equal(p.front.release, true);
  assert.deepEqual(p.steps.map((s) => [s.long, s.sooner, s.final, s.resumable]), [['a device boot', null, false, true], [null, 'the owner asked', true, false]]);
  const bad = parsePlan(planOf('release: maybe\n', step('S-1', 'Tests', 'heavy', 'command: npm test', 'final: no', 'resumable: true', 'long:', 'sooner: ')));
  assert.deepEqual(bad.problems.map((x) => x.problem), [
    'release is `yes` or left out, not maybe',
    'S-1: final is `yes` or left out, not no',
    'S-1: resumable is `yes` or left out, not true',
    'S-1: long: says why, `long: <why>`',
    'S-1: sooner: says why, `sooner: <why>`',
  ]);
});

test('AC-1: a heavy step beside work that neither needs it nor is needed by it is refused, naming that work; made to need it, it passes', () => {
  const fix = step('S-1', 'Fix', 'agent');
  const tests = (...needs) => step('S-2', 'Unit tests', 'heavy', `needs: ${needs.join(', ')}`, 'command: npm test');
  const docs = step('S-3', 'Docs', 'agent');
  assert.deepEqual(fq(planOf('', fix, tests('S-1'), docs, REVIEW('S-2', 'S-3'))), [
    'S-2 is a heavy step beside S-3, which neither needs it nor is needed by it: make S-2 need S-3, so the heavy work runs after the work that does not take its output',
  ]);
  assert.deepEqual(fq(planOf('', fix, docs, tests('S-1', 'S-3'), REVIEW('S-2'))), []);
  // Two steps beside it are named in one finding.
  assert.match(fq(planOf('', fix, tests('S-1'), docs, step('S-4', 'More docs', 'agent'), REVIEW('S-2', 'S-3', 'S-4')))[0], /^S-2 is a heavy step beside S-3, S-4, which neither need it nor are needed by it: make S-2 need S-3, S-4,/);
});

test('AC-1: a test a fix needs stays before the fix, through any number of needs; another heavy step and a final step are no work beside it', () => {
  const failing = step('S-1', 'A test that fails without the fix', 'agent');
  const fix = step('S-2', 'The fix', 'agent', 'needs: S-1');
  const tests = (id, ...fields) => step(id, 'Unit tests', 'heavy', 'needs: S-2', 'command: npm test', ...fields);
  assert.deepEqual(fq(planOf('', failing, fix, tests('S-3'), REVIEW('S-3'))), []);
  assert.deepEqual(fq(planOf('', failing, fix, tests('S-3'), tests('S-4'), REVIEW('S-3', 'S-4'))), []);
  assert.deepEqual(fq(planOf('release: yes\n', failing, fix, tests('S-3'), REVIEW('S-3'), step('S-10', 'Ship it', 'agent', 'needs: S-9', 'final: yes'))), []);
});

test('AC-2: a heavy step stated over plan.shortMinutes is refused unless resumable or long; expect-minutes, else max-minutes, else the budget; no setting, no rule', () => {
  const ws = { plan: { shortMinutes: 30 } };
  const heavy = (...fields) => planOf('', step('S-1', 'Simulator tests', 'heavy', 'command: npm test', ...fields), REVIEW('S-1'));
  const OVER = (n) => `S-1 is a heavy step of ${n} minutes, over the short line of 30: split it into steps of 30 minutes or less, mark it \`resumable: yes\` when its job can run in pieces, or add \`long: <why it cannot split>\``;
  assert.deepEqual(fq(heavy('expect-minutes: 45', 'max-minutes: 90'), ws), [OVER(45)]);
  assert.deepEqual(fq(heavy('max-minutes: 45'), ws), [OVER(45)]);
  assert.deepEqual(fq(heavy('budget: 50 calls, 40 minutes, 1 USD'), ws), [OVER(40)]);
  assert.deepEqual(fq(heavy('expect-minutes: 20', 'max-minutes: 60'), ws), [], 'the expected length decides');
  assert.deepEqual(fq(heavy('max-minutes: 30'), ws), [], '30 is not over 30');
  assert.deepEqual(fq(heavy('max-minutes: 45', 'resumable: yes'), ws), []);
  assert.deepEqual(fq(heavy('max-minutes: 45', 'long: a release bundle cannot split'), ws), []);
  assert.deepEqual(fq(heavy('max-minutes: 45')), [], 'no plan.shortMinutes');
  assert.deepEqual(fq(heavy('max-minutes: 45'), { plan: { storeSet: ['store set'] } }), []);
});

test('AC-2: a heavy step that states no length is judged at the minutes k run queues it at, its budget\'s (budgetOf); refused over the line, a warning in an older task', () => {
  const ws = { plan: { shortMinutes: 30 }, budget: { calls: 100, minutes: 40, usd: 3 } };
  const heavy = (...fields) => planOf('', step('S-1', 'Simulator tests', 'heavy', 'command: npm test', ...fields), REVIEW('S-1'));
  const OVER = 'S-1 is a heavy step of 40 minutes, over the short line of 30: split it into steps of 30 minutes or less, mark it `resumable: yes` when its job can run in pieces, or add `long: <why it cannot split>`';
  assert.equal(budgetOf(ws, {}).minutes, 40, 'the same minutes k run queues the job at');
  assert.deepEqual(fq(heavy(), ws), [OVER]);
  assert.deepEqual(fq(heavy(), { plan: { shortMinutes: 30 } }), [OVER], 'no workspace budget: budgetOf\'s default, 40');
  assert.deepEqual(fq(heavy('resumable: yes'), ws), []);
  assert.deepEqual(fq(heavy('long: a device boot cannot split'), ws), []);
  assert.deepEqual(fq(heavy('max-minutes: 20'), ws), []);
  assert.deepEqual(fq(heavy(), { ...ws, budget: { minutes: 25 } }), [], 'a workspace budget under the line');
  assert.deepEqual(fq(heavy()), [], 'no plan.shortMinutes');
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-ac2-'));
  try {
    const record = join(dir, 'approval.json');
    writeFileSync(record, JSON.stringify({ history: [{ approved: '2026-11-01T09:00:00Z' }] }));
    const old = fastQueue(parsePlan(heavy()), { id: ID, record }, ws);
    assert.deepEqual(old, [{ line: old[0]?.line, problem: `${OVER} (a warning: ${ID} was approved before ${FAST_QUEUE_SINCE})`, warning: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STORE = { plan: { storeSet: ['store (screenshot|set)', 'preview video', /feature graphic/i] } };

test('AC-5, E-1: outside a release a step whose title makes a store set is refused unless it says sooner; a capture taken as review evidence matches nothing; no setting, no rule', () => {
  const work = step('S-1', 'The settings screen', 'agent');
  const shots = (...fields) => step('S-2', 'Store screenshots in every locale', 'agent', 'needs: S-1', ...fields);
  assert.deepEqual(fq(planOf('', work, shots(), REVIEW('S-2')), STORE), [
    'S-2 makes a store set in a plan that is no release: store sets are made once, by a release\'s final steps; drop the step, or add `sooner: <why it is needed now>`',
  ]);
  assert.deepEqual(fq(planOf('', work, shots('sooner: the owner asked for them on 2026-11-15'), REVIEW('S-2')), STORE), []);
  // A RegExp counts as a string does; the title decides, never a what: line that only names a store set.
  assert.equal(fq(planOf('', work, step('S-2', 'The Play feature graphic', 'agent', 'needs: S-1'), REVIEW('S-2')), STORE).length, 1);
  const what = step('S-2', 'Settings in each theme: renders', 'agent', 'needs: S-1', 'what: at the store set\'s phone size, render Settings for the owner');
  assert.deepEqual(fq(planOf('', work, what, REVIEW('S-2')), STORE), []);
  // E-1: a capture the review must see.
  const capture = step('S-2', 'Capture the settings screen for the review', 'agent', 'needs: S-1', 'what: capture evidence/S-2-settings.png in both themes');
  assert.deepEqual(fq(planOf('', work, capture, REVIEW('S-2')), STORE), []);
  assert.deepEqual(fq(planOf('', work, shots(), REVIEW('S-2'))), [], 'no plan.storeSet');
});

test('AC-6: final steps belong to a release, make its store set and come last; nothing that is not final needs one', () => {
  const work = step('S-1', 'The settings screen', 'agent');
  const review = step('S-2', 'Review', 'review', 'needs: S-1', 'covers: all', 'inputs: task, diff, evidence/', 'outputs: review.md');
  const shots = (...fields) => step('S-3', 'Store screenshots', 'agent', 'needs: S-2', ...fields);
  const R = 'release: yes\n';
  assert.deepEqual(fq(planOf(R, work, review, shots('final: yes')), STORE), []);
  assert.deepEqual(fq(planOf('', work, review, step('S-3', 'Ship it', 'agent', 'needs: S-2', 'final: yes'))), [
    'S-3 is `final: yes` in a plan that is no release: final steps belong to a release\'s plan, its front matter `release: yes`; drop the mark',
  ]);
  assert.deepEqual(fq(planOf(R, work, review, shots()), STORE), [
    'S-3 makes a store set: mark it `final: yes`, so it runs once the stories the release ships are accepted, or add `sooner: <why>`',
  ]);
  assert.deepEqual(fq(planOf(R, work, review, shots('sooner: the owner asked')), STORE), []);
  const after = step('S-4', 'Notes', 'agent', 'needs: S-3');
  assert.deepEqual(fq(planOf(R, work, review, shots('final: yes'), after), STORE), [
    'S-4 is not final but needs the final step S-3: mark it `final: yes`, or drop the need',
    'S-3 is a final step with S-4 after it, not final: move the final steps to the end of the plan',
  ]);
  assert.deepEqual(fq(planOf(R, work, shots('final: yes').replace('needs: S-2', 'needs: S-1'), review), STORE), [
    'S-3 is a final step with S-2 after it, not final: move the final steps to the end of the plan',
  ]);
});

test('the rules are warnings in a task first approved before FAST_QUEUE_SINCE: k plan check passes and the gate runs it; one approved since is refused', async () => {
  const beside = PLAN.replace('### S-2 Unit tests [heavy]\nneeds: S-1\n', '### S-2 Unit tests [heavy]\n').replace('### S-3 Review [review]\nneeds: S-2\n', '### S-3 Review [review]\nneeds: S-1, S-2\n');
  const FINDING = 'S-2 is a heavy step beside S-1, which neither needs it nor is needed by it: make S-2 need S-1, so the heavy work runs after the work that does not take its output';
  const w = await approvedWorkspace(beside);
  const record = JSON.parse(readFileSync(w.p.record, 'utf8'));
  const approvedOn = (day) => writeFileSync(w.p.record, JSON.stringify({ ...record, history: [{ ...record.history[0], approved: `${day}T10:00:00+00:00` }] }));
  approvedOn('2026-11-15');
  const old = k(w.home, ['plan', 'check', ID]);
  assert.equal(old.status, 0, old.stderr);
  assert.ok(old.stdout.includes(`warning, line 14: ${FINDING} (a warning: ${ID} was approved before ${FAST_QUEUE_SINCE})`), old.stdout);
  assert.deepEqual(gate(load(w.ws, ID)).filter((x) => x.startsWith('plan.md')), []);
  approvedOn(FAST_QUEUE_SINCE);
  const since = k(w.home, ['plan', 'check', ID]);
  assert.equal(since.status, 1);
  assert.ok(since.stderr.includes(`line 14: ${FINDING}`), since.stderr);
  assert.deepEqual(gate(load(w.ws, ID)).filter((x) => x.startsWith('plan.md')), [`plan.md line 14: ${FINDING}`]);
});

test('FAST_QUEUE_SINCE is a real day not after today, never a placeholder, so the rules refuse in a task approved since', () => {
  assert.match(FAST_QUEUE_SINCE, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(FAST_QUEUE_SINCE <= new Date().toISOString().slice(0, 10), `FAST_QUEUE_SINCE ${FAST_QUEUE_SINCE} is in the future: set it to the day the rules reached master`);
});

test('the workspace\'s plan settings: absent or good pass; a shortMinutes that is no number or a storeSet that is no list of patterns is a problem', () => {
  assert.deepEqual(checkPlanSettings(undefined), []);
  assert.deepEqual(checkPlanSettings({ shortMinutes: 30, storeSet: ['store set', /preview video/i] }), []);
  assert.deepEqual(checkPlanSettings({ shortMinutes: '30' }), ['plan.shortMinutes is a number of minutes']);
  assert.deepEqual(checkPlanSettings({ storeSet: 'store set' }), ['plan.storeSet is a list of patterns, each a RegExp or a string that reads as one']);
  assert.deepEqual(checkPlanSettings({ storeSet: ['(unclosed'] }), ['plan.storeSet is a list of patterns, each a RegExp or a string that reads as one']);
  assert.deepEqual(checkPlanSettings([]), ['plan is { shortMinutes, storeSet }']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLines } from '../lib/keeper.mjs';
import { run } from '../lib/run.mjs';
import { renderBrief } from '../lib/board-brief.mjs';
import { snapshot } from '../lib/board.mjs';
import { card } from '../lib/board-md.mjs';
import { rows } from '../lib/list.mjs';
import { stoppedFor } from '../lib/waiting.mjs';
import * as queue from '../lib/queue.mjs';
import * as steps from '../lib/steps.mjs';
import { register } from '../plugins/machine-guard-pids.mjs';
import { alive, groupAlive } from '../plugins/resource-guard-local.mjs';
import runnerClaude from '../plugins/runner-claude.mjs';
import { approvedWorkspace, events, fakeClaude, fakePs, k, KIRUNAK } from './helpers.mjs';

const PLAN = `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent]
covers: AC-1, AC-2, E-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv

### S-2 Restart keeps it [agent]
needs: S-1
covers: AC-3
inputs: task, evidence/S-1-cache-sizes.tsv
outputs: steps/S-2/report.md

### S-3 Restart offline on a phone [owner]
needs: S-2

### S-4 Review [review]
needs: S-3
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

// Where a k run that did both agent steps stops: at the owner's step, before the review.
const BOTH = { 'S-1': 'done', 'S-2': 'done', 'S-3': 'ready', 'S-4': 'pending' };

const OUTPUTS = { 'S-1': ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv'], 'S-2': ['steps/S-2/report.md'] };

// Every fake run's usage, and the tokens R3.1's events read from it (lib/cost.mjs's names).
const RUN_USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const TOKENS = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 };

// A fake runner seam: each run is a real short process (so its pid is alive while it runs); when it exits,
// `act(step, n, w)` does the step's work and the result names the conversation.
function fakeRunner(w, act = () => 'write') {
  const calls = [];
  const runner = {
    start(step) {
      const n = calls.push(step);
      const child = spawn('sleep', [step.sleep || '0.05'], { detached: true });
      const sessionId = step.resume || step.sessionId;
      const done = new Promise((resolve) =>
        child.on('exit', (code, signal) => {
          const what = act(step, n, w, child.pid);
          if (what === 'write') for (const o of OUTPUTS[step.env.KIRUNAK_STEP]) put(w, o);
          resolve({ exitCode: what === 'exit 1' ? 1 : signal ? 143 : 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: sessionId, total_cost_usd: 0.1, usage: RUN_USAGE } });
        }),
      );
      return { pid: child.pid, sessionId, done };
    },
    keepAlive: () => null,
  };
  w.ws.seams.runner = runner;
  return calls;
}

const put = (w, rel, text = 'x') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};
const progress = (w) => readFileSync(join(w.p.dir, 'progress.md'), 'utf8');
// k run's last line on a stop for the owner, which the session's escalation hook pushes (S-2 design R7.2, E-16).
const PUSHED = (text) => `kirunak-push: The last forecast stays readable offline (weather/offline-forecast): ${text}`;
const pushes = (lines) => lines.filter((l) => l.startsWith('kirunak-push:'));
const QUESTION = PUSHED('S-1 waits for your answer. why: Three days or a week? answer in a session or in notes.md, then start k run again');
const watch = (w) => run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });

test('pending → ready → running → done, with the run records, the briefs and the flags', async () => {
  const w = await approvedWorkspace(PLAN);
  const seen = [];
  const calls = fakeRunner(w, (step, n, w2, pid) => {
    const rec = JSON.parse(readFileSync(join(w2.p.dir, 'steps', step.env.KIRUNAK_STEP, 'run-1.json'), 'utf8'));
    assert.deepEqual([rec.session_id, rec.kirunak.krun, rec.kirunak.claude, rec.kirunak.ended, rec.kirunak.result], [step.sessionId, process.pid, pid, null, false], 'the record is written before the run ends');
    assert.ok(Math.abs(Date.now() - Date.parse(rec.kirunak.claudeStart)) < 10000, 'the claude\'s start is recorded beside its pid');
    seen.push({ states: Object.fromEntries([...steps.load(w2.ws, w2.id).states].map(([s, v]) => [s, v.state])), pidFile: existsSync(join(w2.home, 'running', `${pid}.json`)) });
    return 'write';
  });
  const r = await watch(w);
  assert.deepEqual(r.states, BOTH);
  assert.deepEqual(seen, [
    { states: { 'S-1': 'running', 'S-2': 'pending', 'S-3': 'pending', 'S-4': 'pending' }, pidFile: true },
    { states: { 'S-1': 'done', 'S-2': 'running', 'S-3': 'pending', 'S-4': 'pending' }, pidFile: true },
  ]);
  assert.deepEqual(readdirSync(join(w.home, 'running')), [], 'the pid files go when the runs end');
  assert.match(progress(w), /S-1 started \(default model, session [0-9a-f-]{36}\)\n.*S-1 finished\n.*S-2 started .*\n.*S-2 finished\n$/);
  for (const c of calls) {
    assert.deepEqual([c.model, c.effort, c.cwd, c.maxTurns, c.maxBudgetUsd, c.permissionMode], [null, null, w.p.root, 100, 3, 'auto']);
    assert.deepEqual(c.disallowedTools, ['Agent']);
    assert.match(c.prompt, /^# weather\/offline-forecast S-\d: /);
  }
  assert.deepEqual(calls.map((c) => c.env), [{ KIRUNAK_TASK: w.id, KIRUNAK_STEP: 'S-1' }, { KIRUNAK_TASK: w.id, KIRUNAK_STEP: 'S-2' }]);
  const rec = JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-1', 'run-1.json'), 'utf8'));
  assert.deepEqual([rec.session_id, rec.num_turns, rec.kirunak.exitCode, rec.kirunak.result, typeof rec.kirunak.ended], [calls[0].sessionId, 3, 0, true, 'string']);
});

test('no --model or --effort when neither the plan nor the config names one; the plan line, then models.<kind>', async () => {
  const w = await approvedWorkspace(PLAN.replace('### S-2 Restart keeps it [agent]', '### S-2 Restart keeps it [agent, opus, high]'));
  const fake = fakeClaude();
  w.ws.seams.runner = runnerClaude(w.ws, { bin: fake.bin }).provides.runner;
  await run({ ws: w.ws, id: w.id });
  const [first] = fake.calls();
  assert.ok(!first.argv.includes('--model') && !first.argv.includes('--effort'), first.argv.join(' '));
  assert.match(first.stdin, /^# weather\/offline-forecast S-1/);
  // The fake wrote no outputs: S-1 failed once; with models.agent, its retry names the model.
  w.ws.models = { agent: { model: 'sonnet' } };
  await run({ ws: w.ws, id: w.id });
  const second = fake.calls()[1].argv;
  assert.deepEqual(second.slice(second.indexOf('--model'), second.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.ok(!second.includes('--effort'));
});

test('a missing output fails the step; the retry is a fresh conversation that reads the failure; then it climbs the ladder, and a design run with no design spends the top rung: k run stops for the owner', async () => {
  const w = await approvedWorkspace(PLAN);
  const lines = [];
  const calls = fakeRunner(w, () => 'nothing');
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  // Its own two attempts on the default model (the lowest rung), then Opus at high and Fable at high (S-2 design R2.2).
  assert.deepEqual(calls.map((c) => [c.model, c.effort]), [[null, null], [null, null], ['opus', 'high'], ['fable', 'high']]);
  assert.equal(new Set(calls.map((c) => c.sessionId)).size, 4, 'every attempt is a fresh conversation');
  assert.match(calls[1].prompt, /kirunak\/tasks\/offline-forecast\/steps\/S-1\/failure-1\.md \(the last attempt failed: read why first\)/);
  assert.match(calls[2].prompt, /## Why this step is yours\n\nIt failed 2 times \(sonnet 2\)\. Read every report first, in order: each says what that attempt tried\.\n\n- kirunak\/tasks\/offline-forecast\/steps\/S-1\/failure-1\.md\n- kirunak\/tasks\/offline-forecast\/steps\/S-1\/failure-2\.md\n/);
  assert.match(calls[3].prompt, /^# weather\/offline-forecast S-1: Keep the last forecast on disk, its design\n[^]*It failed 3 times \(sonnet 2, opus 1\)\.[^]*failure-3\.md\n/);
  assert.match(readFileSync(join(w.p.dir, 'steps', 'S-1', 'failure-1.md'), 'utf8'), /missing outputs: steps\/S-1\/report\.md, evidence\/S-1-cache-sizes\.tsv/);
  // The design run's one required output is its design (R2.4): without it the attempt fails, and the top rung is spent.
  assert.match(readFileSync(join(w.p.dir, 'steps', 'S-1', 'failure-4.md'), 'utf8'), /: missing outputs: steps\/S-1\/design-1\.md\n/);
  assert.equal(r.stopped, 'S-1 failed on every rung (sonnet 2, opus 1, fable 1); the owner decides: read steps/S-1/failure-4.md');
  // The stop line, then the push, the last line; the climbs before it pushed nothing (E-17).
  const spent = PUSHED('S-1 stopped, failed on every rung. read kirunak/tasks/offline-forecast/steps/S-1/ (failure-1.md … failure-4.md)');
  assert.deepEqual([lines.at(-2), lines.at(-1)], [`${w.id} stopped: ${r.stopped}`, spent]);
  assert.deepEqual([pushes(lines), `kirunak-push: ${r.push}`], [[spent], spent]);
  assert.match(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /^### S-1 Keep the last forecast on disk \[agent\] \[escalate\]$/m);
  assert.match(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /^failures: steps\/S-1\/failure-1\.md, steps\/S-1\/failure-2\.md, steps\/S-1\/failure-3\.md, steps\/S-1\/failure-4\.md$/m);
  assert.equal((progress(w).match(/S-1 failed: missing outputs/g) || []).length, 4);
  assert.match(progress(w), /S-1 escalated: to opus \(high, build\) after 2 failures on sonnet\n.*S-1 started \(opus high, session [0-9a-f-]{36}, rung opus\)\n/);
  assert.match(progress(w), /S-1 escalated: to fable \(high, design\) after 1 failure on opus\n.*S-1 started \(fable high, session [0-9a-f-]{36}, rung fable design\)\n.*S-1 failed: /);
  assert.ok(lines.includes(`${w.id} S-1 climbs to opus (high): attempt 1 of 1`) && lines.includes(`${w.id} S-1 climbs to fable (high): attempt 1 of 1`), lines.join('\n'));
  assert.equal(r.states['S-2'], 'pending');
  // The next k run stops at the mark, with the same push.
  const again = [];
  assert.match((await run({ ws: w.ws, id: w.id, out: (l) => again.push(l) })).stopped, /^S-1 is marked \[escalate\] in plan\.md/);
  assert.equal(again.at(-1), spent);
});

test('a k run --once that fails a step, then one that climbs it, prints no push: neither is a stop for the owner (E-17)', async () => {
  const w = await approvedWorkspace(PLAN);
  const lines = [];
  fakeRunner(w, (step, n) => (n <= 2 ? 'nothing' : 'write'));
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) }));
  assert.ok(lines.includes(`${w.id} S-1 climbs to opus (high): attempt 1 of 1`), lines.join('\n'));
  assert.deepEqual(results.map((r) => [r.states['S-1'], r.push]), [['ready', null], ['failed', null], ['done', null]]);
  assert.deepEqual(pushes(lines), []);
});

test('a step that fails twice climbs to opus and k run goes on by itself: an event and a plain line, nothing for the owner, a line on the card (AC-1, E-17)', async () => {
  const w = await approvedWorkspace(PLAN);
  const lines = [];
  const calls = fakeRunner(w, (step, n) => (n <= 2 ? 'nothing' : 'write'));
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.deepEqual(r.states, BOTH);
  assert.match(r.stopped, /^S-3 waits for the owner/, 'k run went on to the next step, and stops only at the owner\'s');
  assert.deepEqual(calls.map((c) => [c.env.KIRUNAK_STEP, c.model, c.effort]), [['S-1', null, null], ['S-1', null, null], ['S-1', 'opus', 'high'], ['S-2', null, null]]);
  assert.ok(lines.includes(`${w.id} S-1 climbs to opus (high): attempt 1 of 1`), lines.join('\n'));
  // The one push is the owner step's, the last line (E-16); the climb pushed nothing (E-17).
  const yours = PUSHED('S-3 is yours: Restart offline on a phone. once it is done: k step finish weather/offline-forecast S-3');
  assert.deepEqual([pushes(lines), lines.at(-1)], [[yours], yours]);
  const time = (e) => ({ ...e, time: typeof e.time });
  assert.deepEqual(events(w.home).filter((e) => /^escalate/.test(e.kind)).map(time), [
    { time: 'string', kind: 'escalate', trigger: 'k run failure count', task: w.id, step: 'S-1', failures: 2, from: { model: 'sonnet' }, to: { model: 'opus', effort: 'high', mode: 'build', attempt: 1 } },
    { time: 'string', kind: 'escalated-run', task: w.id, step: 'S-1', rung: { model: 'opus', effort: 'high', mode: 'build' }, phase: 'build', passed: true, tokens: TOKENS, costUsd: 0.1, record: 'steps/S-1/run-3.json' },
  ]);
  const list = await rows(w.ws, { all: true });
  assert.deepEqual(stoppedFor(list), [], 'k waiting shows nothing');
  assert.ok(!renderBrief(list, snapshot(w.ws)).groups.some((g) => g.name === 'Stopped for you'), 'nor does the brief board');
  assert.match(await card(w.ws, w.id), /\nClimbs:\n\n- \d{4}-\d\d-\d\d \d\d:\d\d S-1 escalated: to opus \(high, build\) after 2 failures on sonnet\n/);
});

test('a Sonnet step whose Opus attempt fails: Fable designs it (design-1.md its one output), a fresh Opus run builds it; when that fails too, k run stops with every report, the stop line, the events with tokens and the notices (AC-4, AC-6, AC-7, AC-21, E-15)', async () => {
  const w = await approvedWorkspace(PLAN);
  const lines = [];
  const calls = fakeRunner(w, (step, n, w2) => {
    if (n === 4) put(w2, 'steps/S-1/design-1.md', '# the design');
    return 'nothing';
  });
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.deepEqual(calls.map((c) => [c.model, c.effort]), [[null, null], [null, null], ['opus', 'high'], ['fable', 'high'], ['opus', 'high']]);
  assert.equal(new Set(calls.map((c) => c.sessionId)).size, 5, 'the build run is a fresh conversation');
  const T = 'kirunak/tasks/offline-forecast/steps/S-1';
  const [design, build] = [calls[3].prompt, calls[4].prompt];
  assert.match(design, /^# weather\/offline-forecast S-1: Keep the last forecast on disk, its design\n/);
  assert.ok(design.includes(`## Your one output\n\n\`${T}/design-1.md\`: the files and functions to change`), design);
  assert.ok(design.includes(`- Design only: write \`${T}/design-1.md\` and nothing under the step's outputs; the caller builds.`), design);
  assert.ok(design.includes(`It failed 3 times (sonnet 2, opus 1). Read every report first, in order: each says what that attempt tried.\n\n- ${T}/failure-1.md\n- ${T}/failure-2.md\n- ${T}/failure-3.md\n`), design);
  assert.match(build, /^# weather\/offline-forecast S-1: Keep the last forecast on disk\n/);
  assert.ok(build.includes(`It failed 3 times (sonnet 2, opus 1). Read the design first, then every report, in order: each says what that attempt tried.\n\n- ${T}/design-1.md: the design. Build exactly this design; where it is wrong, say so in the report.\n- ${T}/failure-1.md\n- ${T}/failure-2.md\n- ${T}/failure-3.md\n`), build);
  assert.match(progress(w), /S-1 started \(fable high, session [0-9a-f-]{36}, rung fable design\)\n.*S-1 started \(opus high, session [0-9a-f-]{36}, rung fable build on opus high\)\n.*S-1 failed: missing outputs: steps\/S-1\/report\.md, evidence\/S-1-cache-sizes\.tsv\n.*S-1 escalated: stopped for the owner, failed on every rung \(sonnet 2, opus 1, fable 1\)\n$/);
  assert.ok(lines.includes(`${w.id} S-1 builds steps/S-1/design-1.md on opus high`), lines.join('\n'));
  // The stop (AC-7, R2.7): the mark, every report in plan.md, one line naming the newest.
  assert.equal(r.stopped, 'S-1 failed on every rung (sonnet 2, opus 1, fable 1); the owner decides: read steps/S-1/failure-4.md');
  const plan = readFileSync(join(w.p.dir, 'plan.md'), 'utf8');
  assert.match(plan, /^### S-1 Keep the last forecast on disk \[agent\] \[escalate\]$/m);
  assert.match(plan, /^failures: steps\/S-1\/failure-1\.md, steps\/S-1\/failure-2\.md, steps\/S-1\/failure-3\.md, steps\/S-1\/failure-4\.md$/m);
  // Every escalation and every rung run in events.jsonl, its tokens from the run record (AC-21, R3.1).
  const run1 = (k, mode, phase, passed) => ({ kind: 'escalated-run', task: w.id, step: 'S-1', rung: mode === 'build' ? { model: 'opus', effort: 'high', mode } : { model: 'fable', effort: 'high', mode }, phase, passed, tokens: TOKENS, costUsd: 0.1, record: `steps/S-1/run-${k}.json` });
  assert.deepEqual(events(w.home).filter((e) => /^escalate/.test(e.kind)).map(({ time, ...e }) => e), [
    { kind: 'escalate', trigger: 'k run failure count', task: w.id, step: 'S-1', failures: 2, from: { model: 'sonnet' }, to: { model: 'opus', effort: 'high', mode: 'build', attempt: 1 } },
    run1(3, 'build', 'build', false),
    { kind: 'escalate', trigger: 'k run failure count', task: w.id, step: 'S-1', failures: 1, from: { model: 'opus' }, to: { model: 'fable', effort: 'high', mode: 'design', attempt: 1 } },
    run1(4, 'design', 'design', true),
    run1(5, 'design', 'build', false),
    { kind: 'escalate', trigger: 'k run failure count', task: w.id, step: 'S-1', failures: 4, from: { model: 'fable' }, to: null, stopped: true },
  ]);
  // The notices (R7.1, R7.3): at most 3 lines of at most 80 characters, the task's title and id first, the one thing
  // to do last; k waiting indents its lines two spaces.
  const list = await rows(w.ws, { all: true });
  const brief = renderBrief(list, snapshot(w.ws)).groups[0];
  // The title and id fill the first line, so what happened opens the second.
  assert.deepEqual(brief.lines, [
    'The last forecast stays readable offline (weather/offline-forecast)',
    'S-1 stopped, failed on every rung: missing outputs: steps/S-1/report.md, eviden…',
    'read kirunak/tasks/offline-forecast/steps/S-1/ (failure-1.md … failure-4.md)',
  ]);
  assert.deepEqual([brief.name, brief.count, brief.ids], ['Stopped for you', 1, [w.id]]);
  const [waiting] = stoppedFor(list);
  for (const ls of [brief.lines, waiting.lines]) {
    assert.ok(ls.length <= 3 && ls.every((l) => l.length <= 80), ls.join('\n'));
    assert.equal(ls[0], 'The last forecast stays readable offline (weather/offline-forecast)');
    assert.match(ls.at(-1), /^read kirunak\/tasks\/offline-forecast\/steps\/S-1\/ \(failure-1\.md … failure-4\.md\)$/);
  }
  assert.ok(waiting.lines.every((l) => l.length <= 78), 'k waiting indents them two spaces');
  assert.ok(waiting.one.length <= 200 && !waiting.one.includes('\n'));
});

test('a timeout counts as a failure, so the step climbs (E-2)', async () => {
  const w = await approvedWorkspace(PLAN.replace('outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv\n', 'outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv\nbudget: 0.005 minutes\n'));
  const calls = fakeRunner(w, (step, n) => (n <= 2 ? 'nothing' : 'write'));
  const original = w.ws.seams.runner.start;
  let n = 0;
  w.ws.seams.runner.start = (step) => original({ ...step, sleep: ++n <= 2 ? '30' : '0.05' });
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  assert.deepEqual(calls.slice(0, 3).map((c) => c.model), [null, null, 'opus']);
  assert.equal((progress(w).match(/S-1 failed: no end within the budget's 0\.005 minutes\n/g) || []).length, 2);
  assert.match(progress(w), /S-1 escalated: to opus \(high, build\) after 2 failures on sonnet\n.*S-1 started .*\n.*S-1 finished\n/);
});

test('a stop is not a failure: after an own failure and a stop the step retries on its own rung, and climbs after its second own failure (E-3)', async () => {
  const w = await approvedWorkspace(PLAN);
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', label: 'session s-1' });
  steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'exit 1' });
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', label: 'session s-2' });
  steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: steps.STOPPED.bySignal('SIGTERM') });
  const calls = fakeRunner(w, (step, n) => (n === 1 ? 'nothing' : 'write'));
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  assert.deepEqual(calls.slice(0, 2).map((c) => c.model), [null, 'opus']);
  assert.match(calls[0].prompt, /steps\/S-1\/failure-1\.md \(the last attempt failed: read why first\)/);
  assert.match(calls[1].prompt, /It failed 2 times \(sonnet 2\)\.[^]*failure-1\.md\n- [^\n]*failure-2\.md\n/);
  assert.ok(!existsSync(join(w.p.dir, 'steps', 'S-1', 'failure-3.md')), 'a stop writes no report');
});

test('a design run that asks the owner a question: the next k run resumes it on its rung, then the build run follows on the rung below', async () => {
  const w = await approvedWorkspace(PLAN.replace('### S-1 Keep the last forecast on disk [agent]', '### S-1 Keep the last forecast on disk [agent, opus, high]'));
  const calls = fakeRunner(w, (step, n, w2) => {
    if (n === 3) put(w2, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Which cache size?' }));
    if (n === 4) put(w2, 'steps/S-1/design-1.md', '# the design');
    return n === 5 ? 'write' : 'nothing';
  });
  const first = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  assert.match(first.stopped, /^S-1 waits for the owner: Which cache size\?/);
  assert.deepEqual(stoppedFor(await rows(w.ws, { all: true })).map((x) => x.lines.at(-1)), ['answer in a session or in notes.md, then start k run again']);
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });
  // An Opus step: opus twice, then Fable designs (asked, then resumed) and a fresh Opus run builds.
  assert.deepEqual(calls.slice(0, 5).map((c) => [c.model, c.resume ? 'resume' : 'fresh']), [['opus', 'fresh'], ['opus', 'fresh'], ['fable', 'fresh'], ['fable', 'resume'], ['opus', 'fresh']]);
  assert.equal(calls[3].sessionId, calls[2].sessionId);
  assert.ok(calls[4].prompt.includes('steps/S-1/design-1.md: the design. Build exactly this design'), calls[4].prompt);
  assert.match(progress(w), /S-1 started \(opus high, session [0-9a-f-]{36}, rung fable build on opus high\)\n.*S-1 finished\n/);
});

test('a heavy step has no rung: its second failure stops the task with every report named (R2.5)', async () => {
  const w = await approvedWorkspace(PLAN.replace('### S-1 Keep the last forecast on disk [agent]\ncovers: AC-1, AC-2, E-1\ninputs: task, docs/offline.md\n', '### S-1 Keep the last forecast on disk [heavy]\ncovers: AC-1, AC-2, E-1\ncommand: npm test\n'));
  w.ws.seams.resourceGuard = { run: () => ({ exitCode: 1, log: 'red' }), status: () => ({}), claim() {}, release() {}, resources: () => [] };
  const calls = fakeRunner(w);
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.equal(calls.length, 0);
  assert.equal(r.stopped, 'S-1 failed 2 times; the owner decides: read steps/S-1/failure-2.md');
  assert.equal(lines.at(-1), PUSHED('S-1 stopped, failed 2 times. why: exit 1. read kirunak/tasks/offline-forecast/steps/S-1/ (failure-1.md, failure-2.md)'));
  assert.match(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /^failures: steps\/S-1\/failure-1\.md, steps\/S-1\/failure-2\.md$/m);
  assert.ok(!/escalated: to /.test(progress(w)));
  assert.deepEqual(events(w.home).filter((e) => /^escalate/.test(e.kind)).map((e) => [e.kind, e.to, e.stopped]), [['escalate', null, true]]);
});

test('exit 1 fails the step with its exit code', async () => {
  const w = await approvedWorkspace(PLAN);
  fakeRunner(w, () => 'exit 1');
  await run({ ws: w.ws, id: w.id });
  assert.match(progress(w), /S-1 failed: exit 1\n$/);
});

test('a runner that throws after the step started fails the step instead of leaving it running', async () => {
  const w = await approvedWorkspace(PLAN);
  w.ws.seams.runner = { start() { throw new Error('no runner here'); }, keepAlive: () => null };
  const r = await run({ ws: w.ws, id: w.id });
  assert.equal(r.ended['S-1'], 'failed');
  assert.match(progress(w), /S-1 failed: kirunak stopped the step: no runner here\n$/);
});

test('a run past its budget minutes is killed and fails, rather than hanging', async () => {
  const w = await approvedWorkspace(PLAN.replace('outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv\n', 'outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv\nbudget: 0.005 minutes\n'));
  fakeRunner(w, () => 'nothing');
  const original = w.ws.seams.runner.start;
  w.ws.seams.runner.start = (step) => original({ ...step, sleep: '30' });
  const t0 = Date.now();
  await run({ ws: w.ws, id: w.id });
  assert.ok(Date.now() - t0 < 10000);
  assert.match(progress(w), /S-1 failed: no end within the budget's 0\.005 minutes\n$/);
});

test('needs.json heavy: the guard runs the job while running/ holds no pid of the step, then the same conversation resumes', async () => {
  const w = await approvedWorkspace(PLAN);
  const jobs = [];
  w.ws.seams.resourceGuard = {
    run(job) {
      jobs.push({ job, running: readdirSync(join(w.home, 'running')) });
      return { exitCode: 0, log: [...Array(100)].map((_, i) => `line ${i + 1}`).join('\n') + '\n' };
    },
    status: () => ({ held: null, queued: [], estimateMinutes: 0 }), claim() {}, release() {}, resources: () => [],
  };
  const calls = fakeRunner(w, (step, n) => {
    if (n === 1) {
      put(w, 'steps/S-1/needs.json', JSON.stringify({ heavy: { what: 'weather unit tests', command: ['npm', 'test'], maxMinutes: 10 }, then: 'resume' }));
      return 'nothing';
    }
    return 'write';
  });
  const start = w.ws.seams.runner.start;
  const slots = [];
  w.ws.seams.runner.start = (step) => (slots.push(readdirSync(join(w.home, 'running')).filter((f) => /^\d+-\d+\.json$/.test(f)).length), start(step));
  const r = await watch(w);
  assert.deepEqual(r.states, BOTH);
  assert.deepEqual(slots, [1, 1, 1], 'every start, the resume too, holds a reserved machine slot');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].running, [], 'no process of the step while the job runs');
  const { say, ...job } = jobs[0].job;
  assert.deepEqual(job, { session: 'kirunak:weather/offline-forecast', what: 'weather unit tests', maxMinutes: 10, command: ['npm', 'test'], cwd: w.p.root });
  assert.equal(typeof say, 'function', 'the guard may say through k run');
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.equal(calls[1].prompt, 'the job ended; read kirunak/tasks/offline-forecast/steps/S-1/heavy-1.json and continue');
  assert.equal(calls[1].maxTurns, 97, 'the step keeps one budget across the resume');
  const heavy = JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-1', 'heavy-1.json'), 'utf8'));
  assert.deepEqual([heavy.exitCode, heavy.report, heavy.lastLines.length, heavy.lastLines[0]], [0, 'kirunak/tasks/offline-forecast/steps/S-1/heavy-1.log', 60, 'line 41']);
  assert.ok(existsSync(join(w.p.dir, 'steps', 'S-1', 'needs-1.json')) && !existsSync(join(w.p.dir, 'steps', 'S-1', 'needs.json')));
  assert.match(progress(w), /S-1 waiting for a heavy job: weather unit tests\n.*S-1 heavy job ended: exit 0 after [\d.]+ min \(steps\/S-1\/heavy-1\.json\)\n.*S-1 resumed \(session /);
  const ended = events(w.home).filter((e) => e.kind === 'build-ended').map(({ time, minutes, ...e }) => e);
  assert.deepEqual(ended, [{ kind: 'build-ended', task: w.id, step: 'S-1', what: 'weather unit tests', exitCode: 0 }], 'the mod toasts it');
});

test('needs.json owner: the task stops with the question; the next k run resumes the conversation', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
    return 'nothing';
  });
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.equal(r.stopped, 'S-1 waits for the owner: Three days or a week?');
  assert.equal(lines.at(-1), QUESTION);
  assert.equal(calls.length, 1);
  assert.match(progress(w), /S-1 waiting for the owner: Three days or a week\?\n$/);
  assert.match(readFileSync(join(w.home, 'events.jsonl'), 'utf8'), /"kind":"awaiting owner".*"question":"Three days or a week\?"/);
  assert.match(k(w.home, ['list']).stdout, /awaiting owner +weather\/offline-forecast/);
  const again = await watch(w);
  assert.deepEqual([again.states, again.push], [BOTH, PUSHED('S-3 is yours: Restart offline on a phone. once it is done: k step finish weather/offline-forecast S-3').slice('kirunak-push: '.length)]);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.match(calls[1].prompt, /^the owner has answered the question of kirunak\/tasks\/offline-forecast\/steps\/S-1\/needs-1\.json; read kirunak\/tasks\/offline-forecast\/notes\.md/);
});

test('a k run --once whose step asks the owner ends with the push of the question, though no pass stopped it', async () => {
  const w = await approvedWorkspace(PLAN);
  fakeRunner(w, () => (put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' })), 'nothing'));
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
  assert.deepEqual([r.stopped, r.states['S-1'], lines.at(-1)], [null, 'waiting-owner', QUESTION]);
  assert.deepEqual(pushes(lines), [QUESTION]);
});

// A guard whose job only records what it was asked to run.
const jobGuard = (jobs) => ({ run: (job) => (jobs.push(job.what), { exitCode: 0, log: 'ok\n' }), status: () => ({ held: null, queued: [], estimateMinutes: 0 }), claim() {}, release() {}, resources: () => [] });
const HEAVY = (what) => JSON.stringify({ heavy: { what, command: ['npm', 'test'], maxMinutes: 10 }, then: 'resume' });
const stepFile = (w, f) => join(w.p.dir, 'steps', 'S-1', f);

test('a failed run\'s needs.json is moved aside and named in its failure: the retry is not failed by it and runs no job for it', async () => {
  // A malformed request fails the run; the retry does the step right.
  const a = await approvedWorkspace(PLAN);
  fakeRunner(a, (step, n) => (n === 1 ? (put(a, 'steps/S-1/needs.json', '{"heavy": '), 'nothing') : 'write'));
  const ra = await watch(a);
  assert.deepEqual(ra.states, BOTH);
  assert.equal((progress(a).match(/S-1 failed/g) || []).length, 1);
  assert.match(readFileSync(stepFile(a, 'failure-1.md'), 'utf8'), /Its needs\.json is now kirunak\/tasks\/offline-forecast\/steps\/S-1\/needs-1\.json; a retry starts without it\./);
  assert.equal(readFileSync(stepFile(a, 'needs-1.json'), 'utf8'), '{"heavy": ');
  // A valid request, then an error: the retry writes every output and no job runs.
  const b = await approvedWorkspace(PLAN);
  const jobs = [];
  b.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(b, (step, n) => (n === 1 ? (put(b, 'steps/S-1/needs.json', HEAVY('tests nobody asked for')), 'exit 1') : 'write'));
  const rb = await watch(b);
  assert.deepEqual(rb.states, BOTH);
  assert.deepEqual(jobs, []);
  assert.deepEqual(calls.map((c) => c.resume ?? null), [null, null, null], 'no conversation was resumed');
});

test('a step failed by hand while it waited for its job starts again without the request', async () => {
  const w = await approvedWorkspace(PLAN);
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  put(w, 'steps/S-1/needs.json', HEAVY('tests'));
  steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'the tests it asked for are not the ones it needs' });
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(w);
  const r = await run({ ws: w.ws, id: w.id });
  assert.equal(r.ended['S-1'], 'done');
  assert.deepEqual([jobs, calls.length, calls[0].resume], [[], 1, null]);
  assert.ok(existsSync(stepFile(w, 'needs-1.json')) && !existsSync(stepFile(w, 'needs.json')));
});

test('every needs-<k>.json takes its number from one index: heavy, the owner, heavy again, three files', async () => {
  const w = await approvedWorkspace(PLAN);
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const asks = { 1: HEAVY('first tests'), 2: JSON.stringify({ owner: 'Three days or a week?' }), 3: HEAVY('second tests') };
  fakeRunner(w, (step, n) => (step.env.KIRUNAK_STEP === 'S-1' && asks[n] ? (put(w, 'steps/S-1/needs.json', asks[n]), 'nothing') : 'write'));
  assert.equal((await watch(w)).stopped, 'S-1 waits for the owner: Three days or a week?');
  assert.deepEqual((await watch(w)).states, BOTH);
  assert.deepEqual(jobs, ['first tests', 'second tests']);
  const read = (k) => JSON.parse(readFileSync(stepFile(w, `needs-${k}.json`), 'utf8'));
  assert.deepEqual([read(1).heavy.what, read(2).owner, read(3).heavy.what], ['first tests', 'Three days or a week?', 'second tests']);
});

test('a step started by hand that asks for a job: k run runs it and starts no claude; one that asks the owner: k run stops', async () => {
  const w = await approvedWorkspace(PLAN);
  // Started by hand with its own session id, after an earlier k run's conversation that left a record.
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: 'an-earlier-run', num_turns: 2, kirunak: { krun: spawnSync('true').pid, claude: null, started: new Date().toISOString(), ended: new Date().toISOString(), result: true } }));
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: randomUUID() });
  put(w, 'steps/S-1/needs.json', HEAVY('weather unit tests'));
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(w);
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.deepEqual([jobs, calls.length], [['weather unit tests'], 0]);
  assert.ok(lines.includes(`${w.id} S-1 was started by hand: its session resumes itself; the job's record is steps/S-1/heavy-1.json`), lines.join('\n'));
  assert.ok(existsSync(stepFile(w, 'needs-1.json')) && !existsSync(stepFile(w, 'needs.json')));
  assert.match(progress(w), /S-1 heavy job ended: exit 0 after [\d.]+ min \(steps\/S-1\/heavy-1\.json\); started by hand, its session resumes itself\n$/);
  assert.equal(r.states['S-1'], 'running');
  put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
  lines.length = 0;
  const again = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
  assert.equal(again.stopped, 'S-1 was started by hand: its session resumes itself; its question is steps/S-1/needs.json');
  assert.equal(lines.at(-1), QUESTION);
  assert.equal(calls.length, 0);
  assert.ok(existsSync(stepFile(w, 'needs.json')), 'the question stays for the session that asked it');
});

test('k run refuses a step past the machine cap and says who runs', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w);
  const others = [spawn('sleep', ['5']), spawn('sleep', ['5'])];
  try {
    others.forEach((c, i) => register(w.ws, c.pid, { task: 'hub/other', step: `S-${i + 1}`, session: `s${i}` }));
    const r = await run({ ws: w.ws, id: w.id });
    assert.equal(calls.length, 0);
    assert.match(r.refused[0], /^S-1 waits for the machine: 2 of 2 steps run: hub\/other S-1 \(pid \d+ since .*\); hub\/other S-2/);
  } finally {
    others.forEach((c) => c.kill());
  }
});

test('k run starts no step of a parked task and names k queue add, which puts it back; parked during --watch, no other step starts', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w);
  queue.remove(w.ws, w.id);
  const parked = `${w.id} is parked, not in the queue: k queue add ${w.id} puts it back`;
  await assert.rejects(run({ ws: w.ws, id: w.id }), { message: `${w.id} cannot run:\n  ${parked}` });
  await assert.rejects(steps.start({ ws: w.ws, id: w.id, step: 'S-1' }), { message: `${w.id} cannot run a step:\n  ${parked}` }, 'k step start too');
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(w.p.dir, 'progress.md')), 'no step started');
  queue.add(w.ws, w.id);
  assert.deepEqual((await run({ ws: w.ws, id: w.id })).states, { 'S-1': 'done', 'S-2': 'ready', 'S-3': 'pending', 'S-4': 'pending' });
  assert.equal(calls.length, 1, 'back in the queue, its step starts');

  // Parked by the owner while S-1 ran: S-1 ends as it would, and S-2 never starts.
  const v = await approvedWorkspace(PLAN);
  const vCalls = fakeRunner(v, (step, n) => {
    if (n === 1) queue.remove(v.ws, v.id);
    return 'write';
  });
  const lines = [];
  const r = await run({ ws: v.ws, id: v.id, watch: true, intervalMs: 20, out: (l) => lines.push(l) });
  assert.equal(vCalls.length, 1);
  assert.equal(r.stopped, parked);
  assert.deepEqual([r.states['S-1'], r.states['S-2']], ['done', 'ready']);
  assert.ok(lines.some((l) => l.endsWith(`stopped: ${r.stopped}`)), lines.join('\n'));
  assert.equal(lines.at(-1), `kirunak-push: The last forecast stays readable offline (${v.id}): parked, not in the queue. k queue add ${v.id} puts it back, then start k run again`);
});

test('one k run per task: a second refuses, naming the pid, and starts nothing; a lock whose k run is dead is taken over', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w);
  const lock = join(w.home, 'k-run', `${encodeURIComponent(w.id)}.json`);
  const first = run({ ws: w.ws, id: w.id });
  await assert.rejects(run({ ws: w.ws, id: w.id }), new RegExp(`has a k run already \\(pid ${process.pid}\\)`));
  await first;
  assert.equal(calls.length, 1, 'the second k run started nothing');
  assert.ok(!existsSync(lock), 'the lock goes when k run ends');
  const dead = spawnSync('true').pid;
  writeFileSync(lock, JSON.stringify({ pid: dead, task: w.id }));
  const lines = [];
  await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
  assert.equal(calls.length, 2);
  assert.ok(lines.includes(`${w.id} took over the lock of k run ${dead}, which no longer runs`), lines.join('\n'));
  assert.ok(!existsSync(lock));
});

const until = async (ok, what) => {
  for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 20))) assert.ok(Date.now() - t0 < 10000, what);
};

test('k run stopped by a signal kills its claude, fails the step, frees the lock and exits with the signal; the next k run retries the step', async () => {
  const w = await approvedWorkspace(PLAN);
  // The real k run in a child, with a fake claude on PATH that says its pid and sleeps.
  const bin = mkdtempSync(join(tmpdir(), 'kirunak-sleepy-claude-'));
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho $$ > "${bin}/pid"\nexec sleep 30\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const child = spawn(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), 'run', w.id], { env: { ...process.env, KIRUNAK_HOME: w.home, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const pidOf = () => (existsSync(join(bin, 'pid')) ? Number(readFileSync(join(bin, 'pid'), 'utf8')) : 0);
  await until(pidOf, 'the fake claude never started');
  const claude = pidOf();
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  await until(() => !alive(claude), 'the fake claude is still running');
  assert.match(progress(w), /S-1 failed: k run was stopped \(SIGINT\)\n$/);
  assert.deepEqual(readdirSync(join(w.home, 'running')), []);
  assert.deepEqual(readdirSync(join(w.home, 'k-run')), [], 'the lock is released');
  const calls = fakeRunner(w);
  const r = await run({ ws: w.ws, id: w.id });
  assert.equal(r.ended['S-1'], 'done');
  assert.doesNotMatch(calls[0].prompt, /failure-1\.md|the last attempt failed/, 'a stop is not the attempt\'s failure');
});

test('k run --watch stopped by a signal while a step is left undecided exits with the signal and leaves that step and its claude', async () => {
  const w = await approvedWorkspace(PLAN);
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const claude = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  register(w.ws, claude.pid, { task: w.id, step: 'S-1', session: sid, since: start });
  const dead = spawnSync('true').pid;
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: dead, krunStart: start, claude: claude.pid, claudeStart: start, started: start, ended: null, result: false } }));
  // Nothing should start; a claude that did would fail at once rather than reach the real one.
  const bin = mkdtempSync(join(tmpdir(), 'kirunak-no-claude-'));
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const restore = fakePs('fails');
  let child;
  try {
    child = spawn(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), 'run', w.id, '--watch'], { env: { ...process.env, KIRUNAK_HOME: w.home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    restore();
  }
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  try {
    await until(() => out.includes(`S-1 is left running: ps gave no answer for pid ${claude.pid}`), `no left-running line: ${out}`);
    child.kill('SIGINT');
    assert.deepEqual(await Promise.race([exited, new Promise((r) => setTimeout(r, 3000)).then(() => 'still running')]), { code: 130, signal: null }, out);
    assert.equal(alive(claude.pid), true, 'the claude ps could not tell about is not killed');
    assert.ok(existsSync(join(w.home, 'running', `${claude.pid}.json`)), 'its running file is kept');
    assert.doesNotMatch(progress(w), /S-1 failed/);
    assert.deepEqual(readdirSync(join(w.home, 'k-run')), [], 'the lock is released');
  } finally {
    child.kill('SIGKILL');
    claude.kill();
  }
});

test('k run stopped while a step waits for its job ends the job and leaves the step waiting; the next k run runs the job and resumes the conversation', async () => {
  const w = await approvedWorkspace(PLAN);
  // The real k run --watch in a child, with a fake claude on PATH that asks for a long job.
  const bin = mkdtempSync(join(tmpdir(), 'kirunak-heavy-claude-'));
  const jobPid = join(bin, 'job.pid');
  const needs = JSON.stringify({ heavy: { what: 'a long build', command: ['/bin/sh', '-c', `echo $$ > ${jobPid}; sleep 30`], maxMinutes: 1 }, then: 'resume' });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
sid=""; for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
cat > /dev/null
mkdir -p "${stepFile(w, '')}" && printf '%s' '${needs}' > "${stepFile(w, 'needs.json')}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"num_turns\\":2,\\"session_id\\":\\"$sid\\",\\"total_cost_usd\\":0.1}"
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const child = spawn(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), 'run', w.id, '--watch'], { env: { ...process.env, KIRUNAK_HOME: w.home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'ignore'] });
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const owner = join(w.home, 'guard', 'lock', 'owner.json');
  await until(() => existsSync(jobPid) && existsSync(owner) && JSON.parse(readFileSync(owner, 'utf8')).job, 'the job never started');
  const job = Number(readFileSync(jobPid, 'utf8'));
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.equal(groupAlive(job), false, 'the guard ended the job');
  assert.equal(existsSync(join(w.home, 'guard', 'lock')), false);
  assert.deepEqual(readdirSync(join(w.home, 'k-run')), [], 'the lock is released');
  assert.doesNotMatch(progress(w), /failed/);
  assert.ok(existsSync(stepFile(w, 'needs.json')), 'the request stays for the next k run');
  assert.match(said, /S-1 waits for its job again: the next k run runs it/);
  const first = JSON.parse(readFileSync(stepFile(w, 'run-1.json'), 'utf8')).session_id;
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(w);
  const r = await run({ ws: w.ws, id: w.id });
  assert.deepEqual([jobs, calls.length, calls[0].resume], [['a long build'], 1, first], 'the job again, then a resume of the first conversation');
  assert.equal(r.ended['S-1'], 'done');
});

// The real k run in a child, with a fake claude on PATH that copies `ask` (if any) to the step's needs.json.
function childRun(w, ask = null) {
  const bin = mkdtempSync(join(tmpdir(), 'kirunak-asking-claude-'));
  if (ask) writeFileSync(join(bin, 'needs.json'), ask);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
sid=""; for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
cat > /dev/null
[ -f "${bin}/needs.json" ] && mkdir -p "${stepFile(w, '')}" && cp "${bin}/needs.json" "${stepFile(w, 'needs.json')}"
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"num_turns\\":2,\\"session_id\\":\\"$sid\\",\\"total_cost_usd\\":0.1}"
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const child = spawn(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), 'run', w.id], { env: { ...process.env, KIRUNAK_HOME: w.home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'ignore'] });
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  return { bin, child, said: () => said, exited: new Promise((r) => child.on('exit', (code, signal) => r({ code, signal }))) };
}

test('k run stopped while a resume waits for a machine slot, its job done, leaves the step waiting; the next k run runs the job again and resumes', async () => {
  const w = await approvedWorkspace(PLAN);
  // The job lowers the machine's cap to none, so the resume after it waits for a slot.
  const full = join(mkdtempSync(join(tmpdir(), 'kirunak-full-')), 'machine.json');
  writeFileSync(full, JSON.stringify({ maxAgents: 0 }));
  const { child, said, exited } = childRun(w, JSON.stringify({ heavy: { what: 'a build', command: ['cp', full, join(w.home, 'machine.json')], maxMinutes: 1 }, then: 'resume' }));
  await until(() => existsSync(join(w.p.dir, 'progress.md')) && /S-1 heavy job ended/.test(progress(w)), 'the job never ended');
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.doesNotMatch(progress(w), /failed|resumed/, 'nothing failed, and nothing resumed yet');
  assert.ok(existsSync(stepFile(w, 'needs.json')), 'the request stays until a claude resumes it');
  assert.match(said(), /S-1 waits for its job again: the next k run runs it/);
  rmSync(join(w.home, 'machine.json'));
  const first = JSON.parse(readFileSync(stepFile(w, 'run-1.json'), 'utf8')).session_id;
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(w);
  const r = await run({ ws: w.ws, id: w.id });
  assert.deepEqual([jobs, calls.length, calls[0].resume, r.ended['S-1']], [['a build'], 1, first, 'done'], 'the job again, then a resume of the first conversation');
  assert.equal(progress(w).match(/resumed/g).length, 1);
  assert.match(progress(w), /S-1 heavy job ended: .*\n.*S-1 heavy job ended: .*\n.*S-1 resumed \(session /);
});

test('k run stopped while the owner\'s answer waits for a machine slot leaves the step waiting for the owner; the next k run resumes it', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w, (step, n) => (n > 1 ? 'write' : (put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' })), 'nothing')));
  assert.equal((await watch(w)).stopped, 'S-1 waits for the owner: Three days or a week?');
  writeFileSync(join(w.home, 'machine.json'), JSON.stringify({ maxAgents: 0 }));
  const { child, said, exited } = childRun(w);
  await until(() => /S-1 starts/.test(said()), 'the resume never started');
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.doesNotMatch(progress(w), /failed|resumed/);
  assert.ok(existsSync(stepFile(w, 'needs.json')), 'the question stays until a claude reads the answer');
  assert.match(said(), /S-1 still waits for the owner: the next k run resumes it/);
  rmSync(join(w.home, 'machine.json'));
  assert.deepEqual((await watch(w)).states, BOTH);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.match(calls[1].prompt, /^the owner has answered the question of kirunak\/tasks\/offline-forecast\/steps\/S-1\/needs-1\.json; /);
  assert.match(progress(w), /S-1 resumed \(session [^)]+\): the owner answered\n/);
  assert.equal(progress(w).match(/resumed/g).length, 1);
});

test('k run stopped releases the device its step holds: a resume waiting for a machine slot leaves the device free', async () => {
  const w = await approvedWorkspace(PLAN.replace('outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv', '$&\ndevice: ios.low'));
  fakeRunner(w, () => (put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' })), 'nothing'));
  await run({ ws: w.ws, id: w.id });
  const device = () => w.ws.seams.resourceGuard.resources().find((x) => x.id === 'ios.low')?.state;
  assert.equal(device(), 'free');
  // No slot is free, so the resume waits for one holding its device, past any end of its own before the exit.
  writeFileSync(join(w.home, 'machine.json'), JSON.stringify({ maxAgents: 0 }));
  const { child, said, exited } = childRun(w);
  await until(() => device() === `claimed by kirunak:${w.id}`, 'the resume never claimed its device');
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.equal(device(), 'free');
  assert.match(said(), /S-1 still waits for the owner: the next k run resumes it/);
});

test('a k run that died while a resume waited for its slot leaves the step waiting: the next k run runs the job again and resumes', async () => {
  const w = await approvedWorkspace(PLAN);
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const dead = spawnSync('true').pid;
  const at = new Date().toISOString();
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: sid, total_cost_usd: 0.1, kirunak: { krun: dead, krunStart: at, claude: dead, claudeStart: at, started: at, ended: at, exitCode: 0, result: true } }));
  put(w, 'steps/S-1/needs.json', HEAVY('tests'));
  const jobs = [];
  w.ws.seams.resourceGuard = jobGuard(jobs);
  const calls = fakeRunner(w);
  const r = await run({ ws: w.ws, id: w.id });
  assert.deepEqual([jobs, calls.length, calls[0].resume, r.ended['S-1']], [['tests'], 1, sid, 'done']);
  assert.doesNotMatch(progress(w), /failed/);
});

test('the attempt after a stop reads the step\'s last own failure report; a stop writes none', async () => {
  for (const order of [['own', 'stop'], ['stop', 'own', 'stop']]) {
    const w = await approvedWorkspace(PLAN);
    for (const x of order) {
      await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
      steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: x === 'own' ? 'the cache test does not build' : steps.STOPPED.bySignal('SIGINT') });
    }
    assert.deepEqual([readdirSync(stepFile(w, '')).filter((f) => /^failure-/.test(f)), steps.historyOf(progress(w), 'S-1').failures], [['failure-1.md'], 1], order.join(', '));
    const calls = fakeRunner(w);
    assert.equal((await run({ ws: w.ws, id: w.id })).ended['S-1'], 'done');
    assert.match(calls[0].prompt, /kirunak\/tasks\/offline-forecast\/steps\/S-1\/failure-1\.md \(the last attempt failed: read why first\)/, order.join(', '));
  }
});

test('a step a dead k run left running is failed, its claude killed, and retried; a step started by hand is left alone', async () => {
  const w = await approvedWorkspace(PLAN.replace('needs: S-1\n', '').replace('inputs: task, evidence/S-1-cache-sizes.tsv', 'inputs: task'));
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const claude = spawn('sleep', ['30'], { detached: true });
  const gone = new Promise((r) => claude.on('exit', (code, signal) => r(signal)));
  register(w.ws, claude.pid, { task: w.id, step: 'S-1', session: sid });
  const dead = spawnSync('true').pid;
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: dead, claude: claude.pid, claudeStart: new Date().toISOString(), started: new Date().toISOString(), ended: null, result: false } }));
  await steps.start({ ws: w.ws, id: w.id, step: 'S-2' });
  const calls = fakeRunner(w);
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
  assert.equal(await gone, 'SIGTERM', 'the claude nobody would collect is killed');
  assert.ok(!existsSync(join(w.home, 'running', `${claude.pid}.json`)));
  assert.match(progress(w), /S-1 failed: the k run that started it stopped\n/);
  assert.ok(lines.includes(`${w.id} S-1 failed: the k run that started it (pid ${dead}) stopped; its claude (pid ${claude.pid}) was killed`), lines.join('\n'));
  assert.ok(lines.includes(`${w.id} S-2 is running by hand`));
  assert.deepEqual(calls.map((c) => c.env.KIRUNAK_STEP), ['S-1'], 'S-1 is retried, S-2 left alone');
  assert.deepEqual(r.states, { 'S-1': 'done', 'S-2': 'running', 'S-3': 'pending', 'S-4': 'pending' });
});

test('a dead k run\'s claude pid that a later process holds is left running; the step still fails and is retried', async () => {
  const w = await approvedWorkspace(PLAN.replace('needs: S-1\n', '').replace('inputs: task, evidence/S-1-cache-sizes.tsv', 'inputs: task'));
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  register(w.ws, other.pid, { task: w.id, step: 'S-1', session: sid, since: hourAgo });
  const dead = spawnSync('true').pid;
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: dead, claude: other.pid, claudeStart: hourAgo, started: hourAgo, ended: null, result: false } }));
  put(w, 'steps/S-2/report.md');
  const calls = fakeRunner(w);
  const lines = [];
  try {
    const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
    assert.equal(alive(other.pid), true, 'a process that is not that claude is not killed');
    assert.ok(lines.includes(`${w.id} S-1 failed: the k run that started it (pid ${dead}) stopped; pid ${other.pid} is not the claude of that run, so it was left running`), lines.join('\n'));
    assert.match(progress(w), /S-1 failed: the k run that started it stopped\n/);
    assert.ok(!existsSync(join(w.home, 'running', `${other.pid}.json`)), 'the dead step\'s running file goes');
    assert.equal(calls.filter((c) => c.env.KIRUNAK_STEP === 'S-1').length, 1, 'S-1 is retried');
    assert.equal(r.states['S-1'], 'done');
  } finally {
    other.kill();
  }
});

test('a heavy step a dead k run left running is failed and run again; its started line names its k run', async () => {
  const w = await approvedWorkspace(PLAN.replace('### S-2 Restart keeps it [agent]\nneeds: S-1\ncovers: AC-3\ninputs: task, evidence/S-1-cache-sizes.tsv\n', '### S-2 Restart keeps it [heavy]\ncovers: AC-3\ncommand: npm test\n'));
  const dead = spawnSync('true').pid;
  await steps.start({ ws: w.ws, id: w.id, step: 'S-2', label: `heavy: npm test, k run ${dead}` });
  const jobs = [];
  w.ws.seams.resourceGuard = { run: (job) => (jobs.push(job.what), job.say('waits: a line of the guard\'s'), put(w, 'steps/S-2/report.md'), { exitCode: 0, log: '' }), status: () => ({}), claim() {}, release() {}, resources: () => [] };
  fakeRunner(w);
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
  assert.ok(lines.includes(`${w.id} S-2 failed: the k run that started it (pid ${dead}) stopped`), lines.join('\n'));
  assert.ok(lines.includes(`${w.id} S-2 waits: a line of the guard's`), 'the guard says through k run');
  assert.deepEqual(jobs, ['Restart keeps it']);
  assert.equal(r.states['S-2'], 'done');
  assert.match(progress(w), new RegExp(`S-2 started \\(heavy: Restart keeps it, k run ${process.pid}\\)`));
});

test('a step whose k run\'s pid is now another process is failed and retried, as is a heavy step, whose line records no start', async () => {
  const w = await approvedWorkspace(PLAN.replace('### S-2 Restart keeps it [agent]\nneeds: S-1\ncovers: AC-3\ninputs: task, evidence/S-1-cache-sizes.tsv\n', '### S-2 Restart keeps it [heavy]\ncovers: AC-3\ncommand: npm test\n'));
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const sid = randomUUID();
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
    put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: other.pid, krunStart: hourAgo, claude: null, claudeStart: null, started: hourAgo, ended: null, result: false } }));
    await steps.start({ ws: w.ws, id: w.id, step: 'S-2', label: `heavy: npm test, k run ${other.pid}` });
    w.ws.seams.resourceGuard = { run: () => (put(w, 'steps/S-2/report.md'), { exitCode: 0, log: '' }), status: () => ({}), claim() {}, release() {}, resources: () => [] };
    const calls = fakeRunner(w);
    const lines = [];
    const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
    for (const s of ['S-1', 'S-2']) assert.ok(lines.includes(`${w.id} ${s} failed: the k run that started it (pid ${other.pid}) stopped`), lines.join('\n'));
    assert.equal(calls.length, 1, 'S-1 is retried');
    assert.deepEqual(r.states, BOTH);
    assert.equal(alive(other.pid), true, 'the process that holds the pid now is left alone');
  } finally {
    other.kill();
  }
});

test('a task lock whose pid is now another process, or that recorded no start, is taken over', async () => {
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    for (const pidStart of [new Date(Date.now() - 3600000).toISOString(), undefined]) {
      const w = await approvedWorkspace(PLAN);
      const calls = fakeRunner(w);
      mkdirSync(join(w.home, 'k-run'), { recursive: true });
      writeFileSync(join(w.home, 'k-run', `${encodeURIComponent(w.id)}.json`), JSON.stringify({ pid: other.pid, pidStart, task: w.id }));
      const lines = [];
      await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
      assert.equal(calls.length, 1, `pidStart ${pidStart}`);
      assert.ok(lines.includes(`${w.id} took over the lock of k run ${other.pid}, which no longer runs`), lines.join('\n'));
    }
  } finally {
    other.kill();
  }
});

test('while ps cannot answer, a live k run\'s task lock refuses a second, and a step it runs is left running', async () => {
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w);
  const lock = join(w.home, 'k-run', `${encodeURIComponent(w.id)}.json`);
  mkdirSync(join(w.home, 'k-run'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: other.pid, pidStart: start, task: w.id }));
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: other.pid, krunStart: start, claude: null, claudeStart: null, started: start, ended: null, result: false } }));
  const restore = fakePs('fails');
  try {
    await assert.rejects(run({ ws: w.ws, id: w.id }), new RegExp(`has a k run already \\(pid ${other.pid}\\)`));
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, other.pid, 'the lock is not taken over');
    rmSync(lock);
    const lines = [];
    const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
    assert.ok(lines.includes(`${w.id} S-1 is running under pid ${other.pid}`), lines.join('\n'));
    assert.equal(r.states['S-1'], 'running');
    assert.doesNotMatch(progress(w), /S-1 failed/);
    assert.equal(calls.length, 0, 'nothing started');
  } finally {
    restore();
    other.kill();
  }
});

test('while ps cannot answer, a step whose k run is dead and whose claude may still run is left running, its claude not killed', async () => {
  const w = await approvedWorkspace(PLAN.replace('needs: S-1\n', '').replace('inputs: task, evidence/S-1-cache-sizes.tsv', 'inputs: task'));
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const claude = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  register(w.ws, claude.pid, { task: w.id, step: 'S-1', session: sid, since: start });
  const dead = spawnSync('true').pid;
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: dead, krunStart: start, claude: claude.pid, claudeStart: start, started: start, ended: null, result: false } }));
  const calls = fakeRunner(w);
  const lines = [];
  const restore = fakePs('fails');
  try {
    const r = await run({ ws: w.ws, id: w.id, out: (l) => lines.push(l) });
    assert.ok(lines.includes(`${w.id} S-1 is left running: ps gave no answer for pid ${claude.pid}, so its claude is believed to run`), lines.join('\n'));
    assert.equal(alive(claude.pid), true, 'not killed');
    assert.ok(existsSync(join(w.home, 'running', `${claude.pid}.json`)), 'its running file is kept');
    assert.doesNotMatch(progress(w), /S-1 failed/);
    assert.equal(r.states['S-1'], 'running');
    assert.equal(calls.filter((c) => c.env.KIRUNAK_STEP === 'S-1').length, 0, 'S-1 is not started again');
  } finally {
    restore();
    claude.kill();
  }
});

test('under --watch, a step left running while ps cannot answer keeps the watch alive and is decided once ps answers', async () => {
  const w = await approvedWorkspace(PLAN);
  const sid = randomUUID();
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1', session: sid, label: `default model, session ${sid}` });
  const claude = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  register(w.ws, claude.pid, { task: w.id, step: 'S-1', session: sid, since: start });
  const dead = spawnSync('true').pid;
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: sid, kirunak: { krun: dead, krunStart: start, claude: claude.pid, claudeStart: start, started: start, ended: null, result: false } }));
  const calls = fakeRunner(w);
  const lines = [];
  const restore = fakePs('fails');
  let restored = false;
  try {
    const running = run({ ws: w.ws, id: w.id, watch: true, intervalMs: 50, out: (l) => lines.push(l) });
    assert.equal(await Promise.race([running, new Promise((r) => setTimeout(r, 2000)).then(() => 'waiting')]), 'waiting', lines.join('\n'));
    const left = `${w.id} S-1 is left running: ps gave no answer for pid ${claude.pid}, so its claude is believed to run`;
    assert.equal(lines.filter((l) => l === left).length, 1, 'said once, not once a pass');
    assert.equal(alive(claude.pid), true, 'not killed while ps cannot tell');
    restore();
    restored = true;
    const r = await running;
    assert.ok(lines.includes(`${w.id} S-1 failed: the k run that started it (pid ${dead}) stopped; its claude (pid ${claude.pid}) was killed`), lines.join('\n'));
    assert.equal(groupAlive(claude.pid), false, 'killed once ps could tell it was that claude');
    assert.match(progress(w), /S-1 failed: the k run that started it stopped\n/);
    assert.equal(calls.filter((c) => c.env.KIRUNAK_STEP === 'S-1').length, 1, 'S-1 is retried in the same k run');
    assert.deepEqual(r.states, BOTH, 'the night goes on: S-2 after it, up to the owner\'s step');
  } finally {
    if (!restored) restore();
    claude.kill();
  }
});

// The keeper in k run: a clock whose sleep moves time on at once, and runs whose records show a 1-hour cache.
function keeperClock() {
  let t = Date.parse('2026-11-03T12:00:00Z');
  return { now: () => new Date(t), sleep: async (ms) => ((t += ms), await new Promise(setImmediate)), advance: (m) => (t += m * 60000) };
}
const USAGE = { input_tokens: 900, cache_creation_input_tokens: 90000, cache_read_input_tokens: 300000, output_tokens: 4000, cache_creation: { ephemeral_1h_input_tokens: 90000 } };
const KEPT = (sid) => ({ type: 'result', session_id: sid, num_turns: 1, usage: { input_tokens: 3, cache_creation_input_tokens: 40, cache_read_input_tokens: 90900, output_tokens: 2 } });
function withCache(w) {
  const original = w.ws.seams.runner.start;
  w.ws.seams.runner.start = (step) => {
    const h = original(step);
    return { ...h, done: h.done.then((o) => ({ ...o, result: { ...o.result, usage: USAGE } })) };
  };
}

test('a heavy job past the cache\'s lifetime: k run keeps the conversation warm, records it, and the resume hits', async () => {
  const w = await approvedWorkspace(PLAN);
  const clock = keeperClock();
  let release;
  const job = new Promise((r) => (release = r));
  w.ws.seams.resourceGuard = {
    run: () => job.then(() => ({ exitCode: 0, log: 'ok\n' })),
    status: () => ({ held: { session: 'kirunak:weather/offline-forecast', what: 'tests', since: clock.now().toISOString(), estimateMinutes: 90 }, queued: [], estimateMinutes: 90 }),
    claim() {}, release() {}, resources: () => [],
  };
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ heavy: { what: 'tests', command: ['npm', 'test'], maxMinutes: 120 }, then: 'resume' }));
    return 'nothing';
  });
  withCache(w);
  const keeps = [];
  w.ws.seams.runner.keepAlive = (sid, cwd, flags) => (keeps.push({ sid, cwd, flags, at: clock.now().toISOString() }), release(), { pid: null, done: Promise.resolve({ exitCode: 0, result: KEPT(sid) }) });
  const lines = [];
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock, out: (l) => lines.push(l) });
  assert.deepEqual(r.states, BOTH);
  const sid = calls[0].sessionId;
  assert.deepEqual(keeps.map((x) => [x.sid, x.cwd, x.at, x.flags.env.KIRUNAK_STEP, x.flags.disallowedTools]), [[sid, w.p.root, '2026-11-03T12:50:00.000Z', 'S-1', ['Agent']]]);
  assert.equal(JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-1', 'keep-1.json'), 'utf8')).session_id, sid);
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.session, l.task, l.step]), [['keepalive', sid, w.id, 'S-1'], ['hit', sid, w.id, 'S-1']]);
  assert.ok(lines.some((l) => l.startsWith(`${w.id} keep-alive: session ${sid}`)), 'k run prints the keep-alive');
  assert.ok(!existsSync(join(w.home, 'sessions', `${sid}.json`)), 'a conversation that ended is no longer tracked');
  assert.match(k(w.home, ['cost', w.id]).stdout, /keep-alives 1, misses 0/);
});

test('a keep-alive that never ends is killed at its deadline, and the step resumes once the job ends', async () => {
  const w = await approvedWorkspace(PLAN);
  const clock = keeperClock();
  let release;
  const job = new Promise((r) => (release = r));
  w.ws.seams.resourceGuard = {
    run: () => job.then(() => ({ exitCode: 0, log: 'ok\n' })),
    status: () => ({ held: { session: 'kirunak:weather/offline-forecast', what: 'tests', since: clock.now().toISOString(), estimateMinutes: 90 }, queued: [], estimateMinutes: 90 }),
    claim() {}, release() {}, resources: () => [],
  };
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ heavy: { what: 'tests', command: ['npm', 'test'], maxMinutes: 120 }, then: 'resume' }));
    return 'nothing';
  });
  withCache(w);
  let ended = 'still running';
  w.ws.seams.runner.keepAlive = () => {
    const child = spawn('sleep', ['30'], { detached: true });
    const done = new Promise((r) => child.on('exit', (code, signal) => ((ended = signal), release(), r({ exitCode: 143, result: null }))));
    return { pid: child.pid, done };
  };
  const r = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock, keepAliveMinutes: 0.002 });
  assert.equal(ended, 'SIGTERM', 'the keep-alive was killed at its deadline');
  assert.deepEqual(r.states, BOTH);
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.deepEqual(readLines(w.home)[0].reason, 'the keep-alive did not end within 0.002 minutes');
});

test('a conversation that waits for the owner is skipped, never kept; after a long wait its resume misses', async () => {
  const w = await approvedWorkspace(PLAN);
  const clock = keeperClock();
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
    return 'nothing';
  });
  withCache(w);
  w.ws.seams.runner.keepAlive = () => assert.fail('no keep-alive for the owner');
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock });
  const sid = calls[0].sessionId;
  const file = JSON.parse(readFileSync(join(w.home, 'sessions', `${sid}.json`), 'utf8'));
  assert.deepEqual([file.kind, file.task, file.step, file.waitsFor, file.ttl], ['headless', w.id, 'S-1', 'owner', '1h']);
  assert.deepEqual(readLines(w.home).map((l) => [l.kind, l.reason]), [['skip', 'owner']]);
  clock.advance(180);
  const again = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock });
  assert.deepEqual(again.states, BOTH);
  const [, miss] = readLines(w.home);
  assert.deepEqual([miss.kind, miss.session, miss.context], ['miss', sid, 90900]);
  assert.equal(miss.costWeight, 2 * 90900);
});

test('a resume that waits for a machine slot past the expiry: the wait is a skip, and the resume a miss as it starts', async () => {
  const w = await approvedWorkspace(PLAN);
  const clock = keeperClock();
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
    return 'nothing';
  });
  withCache(w);
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock });
  const sid = calls[0].sessionId;
  // Another task's step holds the one slot, and the cache expires while the resume waits for it.
  let looks = 0;
  const other = { pid: 1, task: 'other/task', step: 'S-1', session: 'x', since: '2026-11-03T12:05:00.000Z' };
  w.ws.seams.machineGuard = { limits: () => ({ maxAgents: 1, maxHeavy: 1 }), running: () => (++looks === 2 && clock.advance(120), looks <= 2 ? [other] : []) };
  clock.advance(10);
  const again = await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock });
  assert.deepEqual([again.states, calls[1].resume], [BOTH, sid]);
  const [, wait, resumed] = readLines(w.home);
  assert.deepEqual([wait.kind, wait.ts, resumed.kind, resumed.ts], ['skip', '2026-11-03T12:10:00.000Z', 'miss', '2026-11-03T14:10:00.000Z']);
  assert.match(wait.reason, /^the resume waits for a machine slot, not kept warm meanwhile: 1 of 1 steps run: other\/task S-1/);
  assert.equal(resumed.reason, 'the cache expired at 2026-11-03T13:00:00.000Z');
});

test('a resume whose device claim fails never starts, and records neither a hit nor a miss', async () => {
  const w = await approvedWorkspace(PLAN.replace('outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv', '$&\ndevice: ios.low'));
  const clock = keeperClock();
  let refuse = false;
  w.ws.seams.resourceGuard = { claim: () => { if (refuse) throw new Error('ios.low is claimed by another session'); }, release() {}, run() {}, status: () => ({ held: null, queued: [] }), resources: () => [] };
  const calls = fakeRunner(w, (step, n) => (n > 1 ? 'write' : (put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' })), 'nothing')));
  withCache(w);
  await run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20, clock });
  refuse = true;
  await run({ ws: w.ws, id: w.id, clock });
  assert.equal(calls.length, 1);
  assert.deepEqual(readLines(w.home).map((l) => l.kind), ['skip']);
});

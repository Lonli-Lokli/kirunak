import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../lib/run.mjs';
import * as steps from '../lib/steps.mjs';
import { register } from '../plugins/machine-guard-pids.mjs';
import runnerClaude from '../plugins/runner-claude.mjs';
import { approvedWorkspace, fakeClaude, k } from './helpers.mjs';

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
`;

const OUTPUTS = { 'S-1': ['steps/S-1/report.md', 'evidence/S-1-cache-sizes.tsv'], 'S-2': ['steps/S-2/report.md'] };

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
          resolve({ exitCode: what === 'exit 1' ? 1 : signal ? 143 : 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: sessionId, total_cost_usd: 0.1 } });
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
const watch = (w) => run({ ws: w.ws, id: w.id, watch: true, intervalMs: 20 });

test('pending → ready → running → done, with the run records, the briefs and the flags', async () => {
  const w = await approvedWorkspace(PLAN);
  const seen = [];
  const calls = fakeRunner(w, (step, n, w2, pid) => {
    seen.push({ states: Object.fromEntries([...steps.load(w2.ws, w2.id).states].map(([s, v]) => [s, v.state])), pidFile: existsSync(join(w2.home, 'running', `${pid}.json`)) });
    return 'write';
  });
  const r = await watch(w);
  assert.deepEqual(r.states, { 'S-1': 'done', 'S-2': 'done' });
  assert.deepEqual(seen, [
    { states: { 'S-1': 'running', 'S-2': 'pending' }, pidFile: true },
    { states: { 'S-1': 'done', 'S-2': 'running' }, pidFile: true },
  ]);
  assert.deepEqual(readdirSync(join(w.home, 'running')), [], 'the pid files go when the runs end');
  assert.match(progress(w), /S-1 started \(default model, session [0-9a-f-]{36}\)\n.*S-1 finished\n.*S-2 started .*\n.*S-2 finished\n$/);
  for (const c of calls) {
    assert.deepEqual([c.model, c.effort, c.cwd, c.maxTurns, c.maxBudgetUsd, c.permissionMode], [null, null, w.p.root, 100, 3, 'auto']);
    assert.deepEqual(c.disallowedTools, ['Agent']);
    assert.match(c.prompt, /^# weather\/offline-forecast S-\d: /);
  }
  assert.deepEqual(calls.map((c) => c.env), [{ KIRUNAK_TASK: w.id, KIRUNAK_STEP: 'S-1' }, { KIRUNAK_TASK: w.id, KIRUNAK_STEP: 'S-2' }]);
  assert.equal(JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-1', 'run-1.json'), 'utf8')).session_id, calls[0].sessionId);
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

test('a missing output fails the step; the retry is a fresh conversation that reads the failure; a second failure marks [escalate]', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w, () => 'nothing');
  const r = await watch(w);
  assert.match(r.stopped, /S-1 is marked \[escalate\] in plan\.md/);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].sessionId, calls[1].sessionId);
  assert.match(calls[1].prompt, /kirunak\/tasks\/offline-forecast\/steps\/S-1\/failure-1\.md \(the last attempt failed: read why first\)/);
  assert.match(readFileSync(join(w.p.dir, 'steps', 'S-1', 'failure-1.md'), 'utf8'), /missing outputs: steps\/S-1\/report\.md, evidence\/S-1-cache-sizes\.tsv/);
  assert.match(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /^### S-1 Keep the last forecast on disk \[agent\] \[escalate\]$/m);
  assert.equal((progress(w).match(/S-1 failed: missing outputs/g) || []).length, 2);
  assert.equal(r.states['S-2'], 'pending');
});

test('exit 1 fails the step with its exit code', async () => {
  const w = await approvedWorkspace(PLAN);
  fakeRunner(w, () => 'exit 1');
  await run({ ws: w.ws, id: w.id });
  assert.match(progress(w), /S-1 failed: exit 1\n$/);
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
  const r = await watch(w);
  assert.deepEqual(r.states, { 'S-1': 'done', 'S-2': 'done' });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].running, [], 'no process of the step while the job runs');
  assert.deepEqual(jobs[0].job, { session: 'kirunak:weather/offline-forecast', what: 'weather unit tests', maxMinutes: 10, command: ['npm', 'test'], cwd: w.p.root });
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.equal(calls[1].prompt, 'the job ended; read kirunak/tasks/offline-forecast/steps/S-1/heavy-1.json and continue');
  assert.equal(calls[1].maxTurns, 97, 'the step keeps one budget across the resume');
  const heavy = JSON.parse(readFileSync(join(w.p.dir, 'steps', 'S-1', 'heavy-1.json'), 'utf8'));
  assert.deepEqual([heavy.exitCode, heavy.report, heavy.lastLines.length, heavy.lastLines[0]], [0, 'kirunak/tasks/offline-forecast/steps/S-1/heavy-1.log', 60, 'line 41']);
  assert.ok(existsSync(join(w.p.dir, 'steps', 'S-1', 'needs-1.json')) && !existsSync(join(w.p.dir, 'steps', 'S-1', 'needs.json')));
  assert.match(progress(w), /S-1 waiting for a heavy job: weather unit tests\n.*S-1 heavy job ended: exit 0 after [\d.]+ min \(steps\/S-1\/heavy-1\.json\)\n.*S-1 resumed \(session /);
});

test('needs.json owner: the task stops with the question; the next k run resumes the conversation', async () => {
  const w = await approvedWorkspace(PLAN);
  const calls = fakeRunner(w, (step, n) => {
    if (n > 1) return 'write';
    put(w, 'steps/S-1/needs.json', JSON.stringify({ owner: 'Three days or a week?' }));
    return 'nothing';
  });
  const r = await watch(w);
  assert.equal(r.stopped, 'S-1 waits for the owner: Three days or a week?');
  assert.equal(calls.length, 1);
  assert.match(progress(w), /S-1 waiting for the owner: Three days or a week\?\n$/);
  assert.match(readFileSync(join(w.home, 'events.jsonl'), 'utf8'), /"kind":"awaiting owner".*"question":"Three days or a week\?"/);
  assert.match(k(w.home, ['list']).stdout, /awaiting owner +weather\/offline-forecast/);
  const again = await watch(w);
  assert.deepEqual(again.states, { 'S-1': 'done', 'S-2': 'done' });
  assert.equal(calls[1].resume, calls[0].sessionId);
  assert.match(calls[1].prompt, /^the owner has answered the question of kirunak\/tasks\/offline-forecast\/steps\/S-1\/needs-1\.json; read kirunak\/tasks\/offline-forecast\/notes\.md/);
});

test('k run refuses a step past the machine cap and says who runs; a task not queued does not run', async () => {
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
  writeFileSync(w.ws.queue, '');
  await assert.rejects(run({ ws: w.ws, id: w.id }), /weather\/offline-forecast is not in the queue/);
});

// The notice after a long stretch outside any step (gulnya/usage-improve-11-22 AC-12): the count hook counts a main
// session's calls while it holds a task and is not a k run step, from its last step on (a Bash call running `k step
// finish` or `k step fail` starts a stretch, one running `k step start` stops the count until then), and at the
// stretch's 150th call or 150k tokens of context growth gives one notice naming the plan's next step, `k run <id>` and
// `k handoff <id>`. Fixtures only (a home, a task, a transcript), never this machine's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reply, STRETCH } from '../hooks/kirunak-count.mjs';
import { tempDir } from './helpers.mjs';

const SID = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TASK = 'app/demo';

const PLAN = `---
task: app/demo
---
### S-1 The first piece [agent]
outputs: steps/S-1/report.md

### S-2 The second piece [agent]
needs: S-1
outputs: steps/S-2/report.md

### S-3 The third piece [agent]
needs: S-2
outputs: steps/S-3/report.md
`;

// A home as k install and k start leave it: config.json naming the repo, the session's file holding the task, the
// task's plan with S-1 finished (so S-2 is ready and S-3 waits for it), and the session's transcript.
function fixture({ task = TASK, context = 40_000 } = {}) {
  const home = tempDir('kirunak-stretch-');
  const root = join(home, 'repo');
  const dir = join(root, 'kirunak', 'tasks', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.md'), PLAN);
  writeFileSync(join(dir, 'progress.md'), '2026-11-20 10:00 S-1 started (session s-run)\n2026-11-20 10:30 S-1 finished\n');
  mkdirSync(join(home, 'escalate'), { recursive: true });
  writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify({ repos: { app: root } }));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', `${SID}.json`), JSON.stringify(task ? { task } : { lastCall: '2026-11-20T10:00:00Z' }));
  const transcript = join(home, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const f = { home, dir, transcript, context: (n) => appendFileSync(transcript, line(n) + '\n') };
  f.context(context);
  return f;
}
const line = (context) => JSON.stringify({
  type: 'assistant', timestamp: '2026-11-22T10:00:00.000Z',
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: context - 10 } },
});
const call = (f, command = null) => ({
  session_id: SID, transcript_path: f.transcript, hook_event_name: 'PostToolUse',
  tool_name: command ? 'Bash' : 'Read', tool_input: command ? { command } : { file_path: '/x' },
});
const notice = (out) => out?.hookSpecificOutput?.additionalContext ?? null;
const ENV = {};
// The calls at which a notice came, of `n` calls.
function noticesOf(f, n, env = ENV, from = 1) {
  const at = [];
  for (let i = from; i < from + n; i++) if (reply(call(f), f.home, env)) at.push(i);
  return at;
}

test('AC-12: the thresholds are 150 calls and 150k tokens of context growth', () => {
  assert.deepEqual({ ...STRETCH }, { calls: 150, context: 150_000 });
});

test("AC-12: a session holding a task gets one notice at its 150th call outside a step, naming the next ready step, k run and k handoff", () => {
  const f = fixture();
  for (let n = 1; n <= 149; n++) assert.equal(reply(call(f), f.home, ENV), null, `call ${n} silent`);
  const out = reply(call(f), f.home, ENV);
  assert.equal(out?.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.equal(out.decision, undefined, 'never a decision');
  const text = notice(out);
  assert.match(text, /150 calls outside any step of app\/demo/);
  assert.match(text, /S-2 \(The second piece\)/, 'the first ready step, never S-1 (done) or S-3 (waiting)');
  assert.match(text, /`k run app\/demo`/);
  assert.match(text, /`k handoff app\/demo`/);
  assert.match(text, /fresh session/);
  assert.deepEqual(noticesOf(f, 250, ENV, 151), [], 'once per stretch');
});

test('AC-12: with no step ready the notice names the first step not finished', () => {
  const f = fixture();
  appendFileSync(join(f.dir, 'progress.md'), '2026-11-21 09:00 S-2 started (session s-run)\n');
  noticesOf(f, 149);
  assert.match(notice(reply(call(f), f.home, ENV)), /S-2 \(The second piece\)/, 'S-2 running, S-3 waiting for it');
});

test('AC-12: 150k tokens of context growth gives the notice with fewer calls', () => {
  const f = fixture({ context: 40_000 });
  assert.equal(reply(call(f), f.home, ENV), null, 'the stretch starts at 40k');
  for (let n = 2; n <= 9; n++) {
    f.context(40_000 + n * 10_000);
    assert.equal(reply(call(f), f.home, ENV), null);
  }
  f.context(189_999);
  assert.equal(reply(call(f), f.home, ENV), null, '149,999 grown: silent');
  f.context(190_000);
  const text = notice(reply(call(f), f.home, ENV));
  assert.match(text, /grown 150k tokens of context outside any step of app\/demo/);
  assert.match(text, /S-2/);
  assert.match(text, /`k run app\/demo`/);
  assert.match(text, /`k handoff app\/demo`/);
  f.context(400_000);
  assert.deepEqual(noticesOf(f, 200, ENV, 12), [], 'once per stretch, by calls or growth');
});

test('AC-12: none inside a step started by k step start; a new stretch after k step finish counts afresh', () => {
  const f = fixture();
  assert.deepEqual(noticesOf(f, 100), [], '100 calls before the step');
  assert.equal(reply(call(f, 'k step start app/demo S-2'), f.home, ENV), null);
  f.context(900_000);
  assert.deepEqual(noticesOf(f, 300), [], 'no count inside the step, by calls or by growth');
  assert.equal(reply(call(f, 'k step finish app/demo S-2 && git status'), f.home, ENV), null);
  appendFileSync(join(f.dir, 'progress.md'), '2026-11-22 09:00 S-2 started (session x)\n2026-11-22 09:40 S-2 finished\n');
  assert.deepEqual(noticesOf(f, 149), [], 'the 100 calls before the step do not carry over, nor the growth inside it');
  const text = notice(reply(call(f), f.home, ENV));
  assert.match(text, /150 calls/);
  assert.match(text, /S-3 \(The third piece\)/, 'the plan read afresh at the notice');
  // A step that fails ends it too, and the stretch after it has its own notice.
  reply(call(f, 'node ~/sources/kirunak/bin/k.mjs step start app/demo S-3'), f.home, ENV);
  assert.deepEqual(noticesOf(f, 200), []);
  reply(call(f, "k step fail app/demo S-3 'red'"), f.home, ENV);
  assert.deepEqual(noticesOf(f, 200), [150], 'a fresh stretch, its own notice');
});

test('AC-12: none for a session holding no task, nor for a k run step (KIRUNAK_STEP set)', () => {
  const none = fixture({ task: null });
  none.context(900_000);
  assert.deepEqual(noticesOf(none, 400), [], 'no task held');
  const file = join(none.home, 'counts', `${SID}.json`);
  const counts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  assert.equal(counts.main, undefined, 'nothing counted for it');
  const step = fixture();
  step.context(900_000);
  assert.deepEqual(noticesOf(step, 400, { KIRUNAK_STEP: 'S-2' }), [], 'a k run step');
  assert.deepEqual(noticesOf(step, 150, ENV), [150], 'the same session counted only once out of the step');
});

test("AC-12: a plan it cannot read still gives the notice with k run and k handoff; an agent's calls are not the session's", () => {
  const f = fixture();
  writeFileSync(join(f.home, 'escalate', 'config.json'), '{ not json');
  for (let n = 1; n <= 200; n++) reply({ ...call(f), agent_id: 'a1', agent_type: 'builder' }, f.home, ENV);
  noticesOf(f, 149);
  const text = notice(reply(call(f), f.home, ENV));
  assert.match(text, /`k run app\/demo`/);
  assert.match(text, /`k handoff app\/demo`/);
  assert.doesNotMatch(text, /S-\d/);
});

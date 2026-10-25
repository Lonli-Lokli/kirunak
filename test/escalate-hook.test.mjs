import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandOf, count, familyOf as hookFamily, message, modelOf, notificationOf, prune, readState, rungFor, signatureOf, statePath,
} from '../hooks/escalate-state.mjs';
import { escalationFile } from '../hooks/kirunak-freeze.mjs';
import { escalateConfig } from '../lib/install.mjs';
import { familyOf } from '../lib/ladder.mjs';

// gulnya/enforced-escalation S-5: the escalation hook counts a build or test failing again on the same test or error
// after an edit, and says so once (S-2 design §4).

const HOOK = fileURLToPath(new URL('../hooks/kirunak-escalate.mjs', import.meta.url));
const FREEZE = fileURLToPath(new URL('../hooks/kirunak-freeze.mjs', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/escalate/', import.meta.url));
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const EXPECTED = JSON.parse(fixture('expected.json'));
const TITLE = 'Escalation follows measured failures, not self-assessment';
const ID = 'gulnya/enforced-escalation';
const NODE_CMD = 'node --test test/ladder.test.mjs';
const NODE_FAIL = fixture('node-test.txt');

// ---- The signature and the commands that count (R4.3, R4.4) ----

test('each runner\'s failure text gives its signature: kind, label and items, hashed without line numbers', () => {
  assert.equal(Object.keys(EXPECTED).length, 16);
  for (const [name, want] of Object.entries(EXPECTED)) {
    const sig = signatureOf(fixture(name), want.command);
    assert.deepEqual({ kind: sig.kind, label: sig.label, items: sig.items }, { kind: want.kind, label: want.label, items: want.items }, name);
    assert.equal(sig.hash, createHash('sha1').update(`${want.kind}\n${want.items.join('\n')}`).digest('hex'), name);
    assert.ok(sig.label.length <= 80, name);
  }
});

test('a moved line, a new test time or a longer truncation leaves the signature as it was', () => {
  const moved = (text) => text.replace(/:(\d+)(?=[:\s)])/g, (_, n) => `:${Number(n) + 7}`).replace(/\((\d+\.\d+)ms\)/g, '(9.5ms)');
  for (const name of ['node-test.txt', 'compiler.txt', 'gradle-kotlin.txt', 'tsc.txt']) {
    const { command } = EXPECTED[name];
    assert.equal(signatureOf(moved(fixture(name)), command).hash, signatureOf(fixture(name), command).hash, name);
  }
  const longer = fixture('truncated.txt').replace('48213 characters', '91002 characters');
  assert.equal(signatureOf(longer, 'node --test').hash, signatureOf(fixture('truncated.txt'), 'node --test').hash);
  assert.equal(signatureOf('Error: spawn /bin/zsh ENOENT', 'npm test'), null, 'no exit code: the shell never started');
});

test('commandOf: heavy-lock\'s wrapper is the command it wraps, a cd before it is skipped, other commands never count', () => {
  const lock = 'node ~/sources/gulnya/tools/heavy-lock.mjs run --session s1 --max-minutes 30 --what "Gradle test" -- ./gradlew :engine:jvmTest';
  assert.equal(commandOf(lock), './gradlew :engine:jvmTest');
  assert.equal(commandOf(`cd ~/sources/slova && ${lock}`), './gradlew :engine:jvmTest');
  assert.equal(commandOf('node ~/sources/gulnya/tools/heavy-lock.mjs status'), null);
  assert.equal(commandOf('cd ~/sources/kirunak && npm test'), 'npm test');
  assert.equal(commandOf('npm test 2>&1 | tail -20'), 'npm test');
  assert.equal(commandOf('FORCE_COLOR=0 env -u CI npx vitest run'), 'npx vitest run');
  assert.equal(commandOf('npm run test:unit'), 'npm run test:unit');
  assert.equal(commandOf('xcodebuild test -scheme Hronka'), 'xcodebuild test -scheme Hronka');
  for (const other of ['ls -la nope', 'git push', 'cat build.log', 'npm install', 'node scripts/x.mjs', 'echo "npm test"']) {
    assert.equal(commandOf(other), null, other);
  }
  assert.equal(commandOf('./tools/check.sh --all', ['^\\./tools/check\\.sh']), './tools/check.sh --all', 'a workspace regex');
  assert.equal(commandOf('./tools/check.sh', ['[']), null, 'a bad regex counts nothing');
});

test('the freeze hook and the rules name the same state file, and read model families as lib/ladder.mjs does', () => {
  const home = '/tmp/h';
  assert.equal(escalationFile({ session_id: 's1' }, home), statePath(home, 's1'));
  assert.equal(escalationFile({ session_id: 's1', agent_id: 'a8e3f' }, home), statePath(home, 's1', 'a8e3f'));
  assert.equal(escalationFile({ session_id: '../x' }, home), null);
  assert.equal(statePath(home, '../x'), null);
  for (const m of ['claude-opus-5-5', 'claude-fable-5[1m]', 'sonnet', 'claude-haiku-5-5', '']) assert.equal(hookFamily(m), familyOf(m), m);
});

test('count: new, a rerun without an edit, a repeat after one, one fire, then only what follows it', () => {
  const state = { failures: {} };
  const sig = { kind: 'node', label: 'x', hash: 'h1' };
  const edit = () => { state.failures.h1.editedSince = true; };
  assert.equal(count(state, sig, 2), 'new');
  assert.equal(count(state, sig, 2), 'rerun');
  edit();
  assert.equal(count(state, sig, 2), 'repeat');
  edit();
  assert.equal(count(state, sig, 2), 'fire');
  edit();
  assert.equal(count(state, sig, 2), 'after');
  assert.equal(count(state, sig, 2), 'after');
  assert.equal(count(state, { ...sig, hash: 'h2' }, 2), 'new', 'a new signature after a fire is a new count');
});

// ---- The message (R4.9) ----

const fits = (lines) => {
  assert.ok(lines.length <= 3, lines.join('\n'));
  for (const l of lines) assert.ok(l.length <= 80, `${l.length}: ${l}`);
};

test('the message is at most three lines of at most 80 characters, with the task\'s title and id, in every shape', () => {
  const task = { id: ID, title: TITLE };
  const opus = { up: 'fable', agents: ['fable-step', 'music-deep'] };
  const long = 'GameBoardRotationTests > keeps the score and the selected word when the board turns twice()';
  const main = message({ label: long, repeats: 2, task, rung: opus });
  fits(main);
  assert.match(main[0], /^kirunak: GameBoardRotationTests > keeps .*… failed again after 2 fixes\.$/);
  assert.match(main[1], /^Task: Escalation follows .*… \(gulnya\/enforced-escalation\)\.$/);
  assert.equal(main[2], 'Hand this step to fable-step (or music-deep); its next failure blocks edits.');
  assert.equal(message({ label: 'x', repeats: 2, task, rung: opus, block: false })[2], 'Hand this step to fable-step (or music-deep) with what you tried.');
  const top = message({ label: 'x', repeats: 2, task, rung: { up: null, agents: [] } });
  fits(top);
  assert.equal(top[2], 'This is the top of the ladder: stop and say plainly what is missing.');
  assert.equal(message({ label: 'x', repeats: 2, task, rung: opus, subagent: true })[2], 'Stop and return to your caller with this failure marked NEEDS-FABLE.');
  assert.equal(message({ label: 'x', repeats: 2, task, rung: { up: null }, subagent: true })[2], 'Stop and return to your caller with this failure marked NEEDS-OWNER.');
  assert.equal(message({ label: 'x', repeats: 2, task: null, rung: opus })[1], 'No task named in this session.');
  assert.equal(message({ label: 'x', repeats: 2, task: { id: ID, title: null }, rung: opus })[1], `Task: ${ID}.`);
  assert.equal(message({ label: 'x', repeats: 1, task, rung: opus })[0], 'kirunak: x failed again after 1 fix.');
  fits(message({ label: long, repeats: 3, task: { id: 'kupalinka-web/a-very-long-repository-task-slug-of-many-words', title: TITLE }, rung: { up: 'opus', agents: ['opus-step', 'builder-one', 'builder-two', 'builder-three'] } }));
});

test('rungFor: by id, then by family; a model on no rung or none is the lowest, marked unknown', () => {
  const ladder = escalateConfig({ ladder: [{ model: 'sonnet' }, { model: 'opus', id: 'claude-opus-5-5', effort: 'high', mode: 'build', attempts: 1 }, { model: 'fable', effort: 'high', mode: 'design', attempts: 1, agents: ['music-deep'] }] }).ladder;
  assert.deepEqual(rungFor(ladder, 'claude-sonnet-5'), { from: 'sonnet', up: 'opus', agents: ['opus-step'], unknown: false });
  assert.deepEqual(rungFor(ladder, 'claude-opus-5-5'), { from: 'opus', up: 'fable', agents: ['fable-step', 'music-deep'], unknown: false });
  assert.deepEqual(rungFor(ladder, 'claude-fable-5'), { from: 'fable', up: null, agents: [], unknown: false });
  assert.deepEqual(rungFor(ladder, 'claude-haiku-5-5'), { from: 'sonnet', up: 'opus', agents: ['opus-step'], unknown: true });
  assert.equal(rungFor(ladder, null).unknown, true);
});

test('modelOf: the recorded model, else the transcript\'s newest; a subagent\'s from its launch, else its own transcript', () => {
  const top = mkdtempSync(join(tmpdir(), 'kirunak-escalate-'));
  const transcript = join(top, 's1.jsonl');
  writeFileSync(transcript, fixture('transcript.jsonl'));
  mkdirSync(join(top, 's1', 'subagents'), { recursive: true });
  writeFileSync(join(top, 's1', 'subagents', 'agent-a2.jsonl'), '{"type":"assistant","message":{"model":"claude-sonnet-5"}}\n');
  assert.equal(modelOf({ transcript_path: transcript }, { model: 'claude-fable-5' }), 'claude-fable-5');
  assert.equal(modelOf({ transcript_path: transcript }, {}), 'claude-opus-5-5', 'the newest assistant entry, not the advisor');
  assert.equal(modelOf({ transcript_path: transcript, agent_id: 'a1' }, { agents: { a1: { model: 'claude-opus-5-5' } } }), 'claude-opus-5-5');
  assert.equal(modelOf({ transcript_path: transcript, agent_id: 'a2' }, { agents: {} }), 'claude-sonnet-5');
  assert.equal(modelOf({ transcript_path: join(top, 'none.jsonl') }, {}), null);
});

test('notificationOf reads a background command\'s end (S-1 §8); any other prompt is null', () => {
  const n = notificationOf('<task-notification>\n<task-id>bxo7</task-id>\n<output-file>/t/bxo7.output</output-file>\n<status>failed</status>\n<summary>Background command "Run "quoted" tests" failed with exit code 4</summary>\n</task-notification>');
  assert.deepEqual(n, { status: 'failed', outputFile: '/t/bxo7.output', description: 'Run "quoted" tests', code: 4 });
  assert.equal(notificationOf('please run the tests'), null);
});

test('prune removes state files untouched for 14 days and leaves config.json and fresh ones', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-escalate-'));
  mkdirSync(join(home, 'escalate'));
  const old = (Date.now() - 15 * 24 * 3600 * 1000) / 1000;
  for (const name of ['config.json', 'old.json', 'old.a1.json', 'fresh.json', 'old.json.123.tmp', 'notes.txt']) {
    writeFileSync(join(home, 'escalate', name), '{}');
    if (name !== 'fresh.json') utimesSync(join(home, 'escalate', name), old, old);
  }
  assert.equal(prune(home), 3);
  assert.deepEqual(readdirSync(join(home, 'escalate')).sort(), ['config.json', 'fresh.json', 'notes.txt']);
  assert.deepEqual(readState(home, 'fresh').failures, {});
});

// ---- The hook, run as Claude Code runs it: the event on stdin, a temp KIRUNAK_HOME ----

const DEFAULT = [{ model: 'sonnet' }, { model: 'opus', effort: 'high', mode: 'build', attempts: 1 }, { model: 'fable', effort: 'high', mode: 'design', attempts: 1 }];

// A home with config.json as k install writes it, a repo `gulnya` holding the task, and session s1 on that task.
function makeHome(hook = {}, ladder = DEFAULT) {
  const top = mkdtempSync(join(tmpdir(), 'kirunak-escalate-'));
  const home = join(top, 'home');
  const repo = join(top, 'gulnya');
  mkdirSync(join(repo, 'kirunak', 'tasks', 'enforced-escalation'), { recursive: true });
  writeFileSync(join(repo, 'kirunak', 'tasks', 'enforced-escalation', 'task.md'), `---\nid: ${ID}\ntitle: ${TITLE}\n---\n\n## Goal\nx\n`);
  mkdirSync(join(home, 'escalate'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 's1.json'), JSON.stringify({ task: ID, step: 'S-5', since: '2026-10-25T19:25:04.627Z' }));
  const config = { written: new Date().toISOString(), ...escalateConfig({ ladder, hook, repos: [{ name: 'gulnya', root: repo }] }) };
  writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify(config, null, 2));
  const log = () => (existsSync(join(home, 'escalate.log')) ? readFileSync(join(home, 'escalate.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const files = () => readdirSync(join(home, 'escalate')).filter((n) => n !== 'config.json').sort();
  return { top, home, log, files, state: (agent = null) => JSON.parse(readFileSync(statePath(home, 's1', agent), 'utf8')) };
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('KIRUNAK_')) env[k] = v;
  return { ...env, ...extra };
}

function run(script, input, home, env = {}) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), env: cleanEnv({ KIRUNAK_HOME: home, ...env }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, out: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}
const hook = (input, home, env) => run(HOOK, input, home, env);
const freeze = (input, home, env) => run(FREEZE, input, home, env);

// Events as Claude Code sends them (S-1 §1..§3).
const failure = (extra = {}, command = NODE_CMD, error = NODE_FAIL) => ({
  session_id: 's1', transcript_path: '/dev/null', cwd: '/tmp', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command, description: 'Run the tests' }, error, is_interrupt: false, duration_ms: 900, ...extra,
});
const edit = (extra = {}) => ({
  session_id: 's1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: '/tmp/src/ladder.mjs', old_string: 'a', new_string: 'b' }, ...extra,
});
const start = (model) => ({ session_id: 's1', transcript_path: '/dev/null', hook_event_name: 'SessionStart', source: 'startup', model });
const textOf = (r) => r.out?.hookSpecificOutput?.additionalContext ?? null;

// fail, then (edit, fail) `fixes` times; the results of the failures.
function cycle(h, fixes, extra = {}, env = {}) {
  const out = [hook(failure(extra), h.home, env)];
  for (let i = 0; i < fixes; i++) {
    assert.equal(freeze(edit(extra), h.home, env).stdout, '', 'the freeze hook lets the edit through and says nothing');
    out.push(hook(failure(extra), h.home, env));
  }
  return out;
}

test('fail, edit, fail, edit, fail fires exactly once: three lines of at most 80 characters (E-6, AC-10, AC-11)', () => {
  const h = makeHome();
  hook(start('claude-opus-5-5'), h.home);
  const [a, b, c] = cycle(h, 2);
  assert.equal(a.stdout + b.stdout, '');
  assert.equal(c.out.systemMessage, textOf(c));
  assert.equal(c.out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  const lines = textOf(c).split('\n');
  fits(lines);
  assert.deepEqual(lines, [
    'kirunak: climbs one rung failed again after 2 fixes.',
    'Task: Escalation follows measured failures, not s… (gulnya/enforced-escalation).',
    'Hand this step to fable-step; its next failure blocks edits.',
  ]);
  assert.equal(freeze(edit(), h.home).stdout, '');
  assert.equal(hook(failure(), h.home).stdout, '', 'never again on the same failures');
  assert.equal(hook(failure(), h.home).stdout, '');
  const log = h.log();
  assert.deepEqual(log.map((l) => l.trigger), ['hook fired', 'repeat after fire', 'repeat after fire']);
  const { time, ...fired } = log[0];
  assert.ok(Date.parse(time));
  assert.deepEqual(fired, {
    session: 's1', agent: null, agentType: null, task: ID, step: 'S-5', trigger: 'hook fired',
    rung: { from: 'claude-opus-5-5', to: 'fable', agents: ['fable-step'] },
    signature: { kind: 'node', label: 'climbs one rung', hash: signatureOf(NODE_FAIL, NODE_CMD).hash }, count: 2, liftedBy: null,
  });
});

test('a test written red and then fixed never counts, nor does a rerun with no edit between (E-5)', () => {
  const h = makeHome();
  hook(failure(), h.home);
  freeze(edit(), h.home);
  // green now: a passing Bash call fires PostToolUse, which the hook is not wired on
  const [f] = Object.values(h.state().failures);
  assert.deepEqual([f.repeats, f.editedSince, f.fired], [0, true, false]);
  const r = makeHome();
  for (let i = 0; i < 4; i++) assert.equal(hook(failure(), r.home).stdout, '');
  assert.equal(Object.values(r.state().failures)[0].repeats, 0, 'fail, fail, fail, fail with no edit is no repeat');
  freeze(edit(), r.home);
  hook(failure(), r.home);
  assert.equal(Object.values(r.state().failures)[0].repeats, 1);
  assert.deepEqual(h.log().concat(r.log()), []);
});

test('repeats: 3 in config.json moves the fire to the third fix', () => {
  const h = makeHome({ repeats: 3 });
  hook(start('claude-sonnet-5'), h.home);
  const out = cycle(h, 3);
  assert.deepEqual(out.slice(0, 3).map((r) => r.stdout), ['', '', '']);
  assert.deepEqual(textOf(out[3]).split('\n').filter((l) => !l.startsWith('Task:')), [
    'kirunak: climbs one rung failed again after 3 fixes.',
    'Hand this step to opus-step; its next failure blocks edits.',
  ]);
});

test('quiet paths print nothing, and what does not count writes nothing (AC-9, O-2)', () => {
  const h = makeHome();
  const quiet = [
    failure({}, 'ls nope', 'Exit code 1\nls: nope: No such file or directory'),
    failure({}, 'git push', 'Exit code 128\nfatal: no upstream'),
    failure({ is_interrupt: true }),
    { ...failure(), tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, error: 'String to replace not found' },
    { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'run the tests again' },
    { session_id: 's1', hook_event_name: 'UserPromptExpansion', command_name: 'k-done', prompt: '/k-done' },
  ];
  for (const input of quiet) assert.equal(hook(input, h.home).stdout, '', JSON.stringify(input).slice(0, 80));
  assert.deepEqual(h.files(), [], 'nothing written');
  for (const input of [failure(), start('claude-opus-5-5'), { session_id: 's1', hook_event_name: 'PostModelSwitch', to_model: 'claude-fable-5' }]) {
    assert.equal(hook(input, h.home).stdout, '');
  }
  assert.deepEqual(h.log(), []);
});

test('in a k run step neither hook writes anything (E-12), and hook.enabled: false makes every event exit at once', () => {
  const step = makeHome();
  const out = cycle(step, 3, {}, { KIRUNAK_STEP: 'S-3', KIRUNAK_TASK: ID });
  hook(start('claude-opus-5-5'), step.home, { KIRUNAK_STEP: 'S-3' });
  assert.deepEqual([out.map((r) => r.stdout).join(''), step.files(), step.log()], ['', [], []]);
  hook(failure(), step.home);
  freeze(edit(), step.home, { KIRUNAK_STEP: 'S-3' });
  assert.equal(Object.values(step.state().failures)[0].editedSince, false, 'the freeze hook\'s edit flag is skipped too');
  const off = makeHome({ enabled: false });
  const offOut = cycle(off, 3);
  hook(start('claude-opus-5-5'), off.home);
  assert.deepEqual([offOut.map((r) => r.stdout).join(''), off.files(), off.log()], ['', [], []]);
});

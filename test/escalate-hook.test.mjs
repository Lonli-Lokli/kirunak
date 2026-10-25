import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandOf, count, EFFORTS as HOOK_EFFORTS, familyOf as hookFamily, message, modelOf, notificationOf, prune, readState, runEnd,
  rungFor, signatureOf, statePath, unfitFor, withState,
} from '../hooks/escalate-state.mjs';
import { escalationFile } from '../hooks/kirunak-freeze.mjs';
import { escalateConfig } from '../lib/install.mjs';
import { familyOf } from '../lib/ladder.mjs';
import { EFFORTS } from '../lib/plan.mjs';
import { stopNotice } from '../lib/notice.mjs';

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
  assert.deepEqual(HOOK_EFFORTS, EFFORTS, 'the effort levels in lib/plan.mjs\'s order');
});

test('a runner the hook knows with none of its lines left counts nothing; a workspace command keeps the fallback (S-10 S-5)', () => {
  const xcode = 'Exit code 65\n... [91002 characters truncated] ...\n** TEST FAILED **\n';
  const gradle = 'Exit code 1\n... [48213 characters truncated] ...\nBUILD FAILED in 12s\n';
  assert.equal(signatureOf(xcode, 'xcodebuild test -scheme Hronka'), null);
  assert.equal(signatureOf(gradle, './gradlew :engine:jvmTest'), null);
  assert.equal(signatureOf(xcode, './tools/check.sh').kind, 'other', 'a workspace command keeps the fallback');
  const h = makeHome();
  for (const [command, text] of [['xcodebuild test -scheme Hronka', xcode], ['./gradlew :engine:jvmTest', gradle]]) {
    for (let i = 0; i < 4; i++) {
      assert.equal(hook(failure({}, command, text), h.home).stdout, '', command);
      freeze(edit(), h.home);
    }
  }
  assert.deepEqual([h.files(), h.log()], [[], []], 'nothing counted, nothing logged');
});

test('count: new, a rerun without an edit, a repeat after one, one fire, the block, then only what follows it', () => {
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
  assert.equal(count(state, sig, 2), 'block', 'the first failure after the fire, edited or not');
  assert.equal(count(state, sig, 2), 'after');
  edit();
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
  assert.deepEqual(log.map((l) => l.trigger), ['hook fired', 'hook blocked', 'repeat after fire']);
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

test('a subagent counts in its own file apart from its caller, and is told to return marked NEEDS-FABLE (E-13, E-14)', () => {
  const h = makeHome();
  hook(start('claude-sonnet-5'), h.home);
  hook({
    session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'fix it', subagent_type: 'opus-step' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'a8e3f33bc6f2f458e', resolvedModel: 'claude-opus-5-5' },
  }, h.home);
  hook(failure(), h.home);
  const sub = { agent_id: 'a8e3f33bc6f2f458e', agent_type: 'opus-step' };
  const out = cycle(h, 2, sub);
  const lines = textOf(out[2]).split('\n');
  fits(lines);
  assert.equal(lines[2], 'Stop and return to your caller with this failure marked NEEDS-FABLE.');
  const caller = h.state();
  assert.deepEqual(Object.values(caller.failures).map((f) => [f.repeats, f.editedSince]), [[0, false]], 'the subagent\'s edits are not the caller\'s');
  assert.equal(caller.agents.a8e3f33bc6f2f458e.model, 'claude-opus-5-5');
  assert.equal(Object.values(h.state('a8e3f33bc6f2f458e').failures)[0].fired, true);
  assert.equal(h.state('a8e3f33bc6f2f458e').agents, undefined, 'launches live in the session\'s file only');
  assert.deepEqual([h.log()[0].agent, h.log()[0].agentType, h.log()[0].rung.to], ['a8e3f33bc6f2f458e', 'opus-step', 'fable']);
  hook({ ...sub, session_id: 's1', hook_event_name: 'SubagentStop', agent_transcript_path: '/dev/null' }, h.home);
  assert.ok(Date.parse(h.state().agents.a8e3f33bc6f2f458e.ended), 'its end is recorded for S-6\'s lift');
});

test('a background build is noted at launch and counted from its notification and output file (R4.5)', () => {
  const h = makeHome();
  hook(start('claude-opus-5-5'), h.home);
  const output = join(h.top, 'bxo7damvu.output');
  writeFileSync(output, fixture('gradle.txt').split('\n').slice(1).join('\n'));
  const command = 'node ~/sources/gulnya/tools/heavy-lock.mjs run --session s1 --max-minutes 30 --what "Gradle test" -- ./gradlew :engine:jvmTest';
  const launch = (cmd = command, description = 'Run the engine tests') => freeze({
    session_id: 's1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd, description, run_in_background: true },
  }, h.home);
  const ended = (status = 'failed', description = 'Run the engine tests') => hook({
    session_id: 's1', hook_event_name: 'UserPromptSubmit',
    prompt: `<task-notification>\n<task-id>bxo7damvu</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>${output}</output-file>\n<status>${status}</status>\n<summary>Background command "${description}" ${status === 'failed' ? 'failed with exit code 1' : 'completed (exit code 0)'}</summary>\n</task-notification>`,
  }, h.home);
  launch('sleep 30', 'Wait');
  freeze({ ...edit(), tool_name: 'Bash', tool_input: { command: './gradlew test' } }, h.home);
  assert.deepEqual(h.state().background, {}, 'a non-build in the background and a foreground build are not noted');
  launch();
  assert.equal(h.state().background['Run the engine tests'].command, './gradlew :engine:jvmTest');
  assert.equal(ended().stdout, '');
  assert.deepEqual(Object.values(h.state().failures).map((f) => f.label), ['ScoreTest > adds a word\'s letters()']);
  assert.deepEqual(h.state().background, {});
  assert.equal(ended().stdout, '', 'a notification with no note is ignored');
  launch();
  assert.equal(ended('completed').stdout, '');
  assert.deepEqual(h.state().background, {}, 'a build that passed takes its note away');
  for (let i = 0; i < 2; i++) {
    freeze(edit(), h.home);
    launch();
    const r = ended();
    if (i === 1) {
      assert.equal(r.out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      fits(textOf(r).split('\n'));
      assert.match(textOf(r), /^kirunak: ScoreTest > adds a word's letters\(\) failed again after 2 fixes\./);
    } else assert.equal(r.stdout, '');
  }
});

// ---- k run's push (S-2 design R7.2, E-16; S-7) ----

test('a noted k run whose output closes with kirunak-push: has the model told to send exactly that text; without the marker, or not noted, nothing (AC-9)', () => {
  const h = makeHome();
  hook(start('claude-opus-5-5'), h.home);
  const output = join(h.top, 'b2run.output');
  // The push k run prints (lib/run.mjs), from the task's title and the stop k waiting shows.
  const push = stopNotice({ title: TITLE, id: ID }, {
    step: 'S-7', kind: 'escalated', what: 'stopped, failed on every rung', why: 'exit 1', dir: 'kirunak/tasks/enforced-escalation/steps/S-7/',
    reports: [1, 2, 3, 4].map((k) => `steps/S-7/failure-${k}.md`),
  }).one;
  const launch = (description = 'Run the escalation task') => freeze({
    session_id: 's1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `k run ${ID} --watch`, description, run_in_background: true },
  }, h.home);
  const ended = (description = 'Run the escalation task', env = {}) => hook({
    session_id: 's1', hook_event_name: 'UserPromptSubmit',
    prompt: `<task-notification>\n<task-id>b2run</task-id>\n<tool-use-id>toolu_02</tool-use-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "${description}" completed (exit code 0)</summary>\n</task-notification>`,
  }, h.home, env);
  writeFileSync(output, `${ID} S-7 starts\n${ID} S-7 failed\n${ID} stopped: S-7 failed on every rung (sonnet 2, opus 1, fable 1); the owner decides: read steps/S-7/failure-4.md\nkirunak-push: ${push}\n`);
  launch();
  assert.deepEqual(h.state().background['Run the escalation task'].run, true);
  // To the model alone, as additionalContext: the push is its to send (S-1 §8).
  assert.deepEqual(ended().out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: [
    'kirunak: k run stopped for the owner. Send this with PushNotification now, exactly as written:',
    push,
    'k waiting and k board --brief show this stop too.',
  ].join('\n') } });
  assert.deepEqual(h.state().background, {}, 'its note is taken away');
  assert.equal(ended().stdout, '', 'the same notification again finds no note');
  assert.equal(h.log().length, 0, 'a k run\'s end is never counted as a failure');
  // Not noted: another command's end, or a k run run in the foreground.
  launch();
  assert.equal(ended('Run something else').stdout, '');
  // A k run that climbed and went on, or ended at no stop, printed no marker.
  writeFileSync(output, `${ID} S-7 climbs to opus (high): attempt 1 of 1\n${ID} S-7 finished\n`);
  assert.equal(ended().stdout, '');
  // Never more than a push holds (200 characters, one line).
  writeFileSync(output, `kirunak-push: ${'word '.repeat(60)}\n`);
  launch();
  assert.equal(textOf(ended()).split('\n')[1], 'word '.repeat(40).trim());
  // Quiet in a k run step, and with the hook off.
  writeFileSync(output, `kirunak-push: ${push}\n`);
  launch();
  assert.equal(ended(undefined, { KIRUNAK_STEP: 'S-2' }).stdout, '');
  const config = join(h.home, 'escalate', 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), hook: { enabled: false } }));
  assert.equal(ended().stdout, '');
});

test('the rung comes from PostModelSwitch, else the transcript\'s tail; a model on no rung is the lowest, logged', () => {
  const fable = makeHome();
  hook(start('claude-sonnet-5'), fable.home);
  hook({ session_id: 's1', hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-5', to_model: 'claude-fable-5', source: 'command' }, fable.home);
  assert.equal(fable.state().model, 'claude-fable-5');
  assert.equal(textOf(cycle(fable, 2)[2]).split('\n')[2], 'This is the top of the ladder: stop and say plainly what is missing.');
  const tail = makeHome({}, [...DEFAULT.slice(0, 2), { ...DEFAULT[2], agents: ['music-deep'] }]);
  const transcript = join(tail.top, 's1.jsonl');
  writeFileSync(transcript, fixture('transcript.jsonl'));
  assert.equal(textOf(cycle(tail, 2, { transcript_path: transcript })[2]).split('\n')[2], 'Hand this step to fable-step (or music-deep); its next failure blocks edits.');
  const haiku = makeHome({ block: false });
  hook(start('claude-haiku-5-5'), haiku.home);
  assert.equal(textOf(cycle(haiku, 2)[2]).split('\n')[2], 'Hand this step to opus-step with what you tried.');
  assert.deepEqual([haiku.log()[0].rungUnknown, haiku.log()[0].rung], [true, { from: 'claude-haiku-5-5', to: 'opus', agents: ['opus-step'] }]);
});

test('SessionStart on startup prunes state files untouched for 14 days', () => {
  const h = makeHome();
  const old = (Date.now() - 15 * 24 * 3600 * 1000) / 1000;
  writeFileSync(join(h.home, 'escalate', 'gone.json'), '{}');
  utimesSync(join(h.home, 'escalate', 'gone.json'), old, old);
  utimesSync(join(h.home, 'escalate', 'config.json'), old, old);
  hook(start('claude-opus-5-5'), h.home);
  assert.deepEqual(h.files(), ['s1.json']);
  assert.ok(existsSync(join(h.home, 'escalate', 'config.json')));
});

// ---- S-6: the block and what lifts it (S-2 design §5) ----

const FABLE_LADDER = [DEFAULT[0], DEFAULT[1], { ...DEFAULT[2], agents: ['music-deep'] }];
const OPUS_DENY = [
  'kirunak: edits blocked: climbs one rung failed again.',
  'Task: Escalation follows measured failures, not s… (gulnya/enforced-escalation).',
  'Launch fable-step (or music-deep) on this step; the owner can type /k-go-on.',
];
const launchOf = (type, agentId, extra = {}, { input = {}, response = {} } = {}) => ({
  session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'take the step', subagent_type: type, ...input },
  tool_response: { isAsync: true, status: 'async_launched', agentId, resolvedModel: type === 'opus-step' ? 'claude-opus-5-5' : 'claude-fable-5', ...response }, ...extra,
});
// A run that finished: its transcript closes with a SubagentHandback (S-1 §2).
const FINISHED = join(FIX, 'transcript-handback.jsonl');
const stopOf = (type, agentId, transcript = FINISHED, extra = {}) => ({
  session_id: 's1', hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, agent_transcript_path: transcript, ...extra,
});
const denied = (r) => r.out?.hookSpecificOutput?.permissionDecisionReason ?? null;

// A session on `model` whose test fired and then failed once more: blocked.
function blocked(model = 'claude-opus-5-5', hookConfig = {}, ladder = FABLE_LADDER) {
  const h = makeHome(hookConfig, ladder);
  hook(start(model), h.home);
  cycle(h, 2);
  freeze(edit(), h.home);
  hook(failure(), h.home);
  return h;
}

test('fire, then the next failure blocks the session\'s edits with three lines; Read, Bash, Agent and other skills go on (R5.1, E-10)', () => {
  const h = blocked();
  const { block } = h.state();
  assert.deepEqual([block.label, block.rung, block.lifted, block.agent], ['climbs one rung', { from: 'claude-opus-5-5', to: 'fable', agents: ['fable-step', 'music-deep'] }, null, null]);
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const reason = denied(freeze(edit({ tool_name: tool, tool_input: { file_path: '/tmp/src/a.mjs', notebook_path: '/tmp/a.ipynb', content: 'x' } }), h.home));
    assert.deepEqual(reason?.split('\n'), OPUS_DENY, tool);
  }
  fits(OPUS_DENY);
  for (const input of [
    { tool_name: 'Read', tool_input: { file_path: '/tmp/src/a.mjs' } },
    { tool_name: 'Bash', tool_input: { command: NODE_CMD } },
    { tool_name: 'Agent', tool_input: { description: 'take the step', subagent_type: 'fable-step', prompt: 'the failure' } },
    { tool_name: 'Skill', tool_input: { skill: 'k-draft' } },
  ]) assert.equal(freeze({ session_id: 's1', cwd: '/tmp', hook_event_name: 'PreToolUse', ...input }, h.home).stdout, '', input.tool_name);
  assert.deepEqual(h.log().map((l) => l.trigger), ['hook fired', 'hook blocked']);
  assert.equal(h.log()[1].signature.label, 'climbs one rung');
  hook(failure(), h.home);
  assert.deepEqual(h.log().map((l) => l.trigger).slice(2), ['repeat after fire'], 'a later failure logs, and the block stays as it was');
  assert.equal(h.state().block.at, block.at);
  assert.equal(freeze(edit(), h.home, { KIRUNAK_STEP: 'S-3' }).stdout, '', 'a k run step is never blocked (E-12)');
});

test('hook.block: false, or a block of another session, denies nothing; the fire still says nothing of a block', () => {
  const h = blocked('claude-opus-5-5', { block: false });
  assert.equal(h.state().block, null);
  assert.deepEqual(h.log().map((l) => l.trigger), ['hook fired', 'repeat after fire']);
  assert.equal(freeze(edit(), h.home).stdout, '');
  const other = blocked();
  assert.equal(freeze(edit({ session_id: 's2' }), other.home).stdout, '');
});

test('only an agent of the rung above, launched after the block, lifts it when it ends (R5.3, E-8)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  hook(launchOf('fable-step', 'aearly'), h.home);
  cycle(h, 2);
  freeze(edit(), h.home);
  hook(failure(), h.home);
  hook(launchOf('opus-step', 'asame'), h.home);
  hook(launchOf('fable-step', 'alate'), h.home);
  hook(launchOf('fable-step', 'anested', { agent_id: 'asame', agent_type: 'opus-step' }), h.home);
  for (const [type, id] of [['fable-step', 'aearly'], ['opus-step', 'asame'], ['fable-step', 'anested'], ['fable-step', 'aunknown']]) {
    hook(stopOf(type, id), h.home);
    assert.equal(h.state().block.lifted, null, `${type} ${id}`);
    assert.ok(denied(freeze(edit(), h.home)), `${id}: still blocked`);
  }
  assert.ok(h.state().agents.alate.at && !h.state().agents.alate.ended, 'the launch alone lifts nothing');
  assert.ok(denied(freeze(edit(), h.home)));
  hook(stopOf('fable-step', 'alate'), h.home);
  const { block, failures } = h.state();
  assert.deepEqual({ ...block.lifted, at: 0 }, { by: 'agent', agent: 'fable-step', agentId: 'alate', at: 0 });
  assert.deepEqual(failures, {}, 'the lifted failure is forgotten: its next failure is a new count');
  assert.equal(freeze(edit(), h.home).stdout, '');
  const lift = h.log().at(-1);
  assert.deepEqual([lift.trigger, lift.liftedBy, lift.signature.label, lift.task, lift.rung.agents], ['block lifted', { agent: 'fable-step', agentId: 'alate' }, 'climbs one rung', ID, ['fable-step', 'music-deep']]);
  assert.equal(lift.transcriptBytes, statSync(FINISHED).size, 'the run\'s size is logged with the lift');
  const deep = blocked();
  hook(launchOf('music-deep', 'amusic'), deep.home);
  hook(stopOf('music-deep', 'amusic'), deep.home);
  assert.equal(deep.state().block.lifted.agent, 'music-deep', 'an agent of the rung\'s `agents` lifts too');
});

test('a Fable session\'s block names no agent and waits for the owner (E-9)', () => {
  const h = blocked('claude-fable-5');
  assert.deepEqual(h.state().block.rung, { from: 'claude-fable-5', to: null, agents: [] });
  const lines = denied(freeze(edit(), h.home)).split('\n');
  fits(lines);
  assert.equal(lines[2], 'Stop and say plainly what is missing; the owner can type /k-go-on.');
  hook(launchOf('fable-step', 'atop'), h.home);
  hook(stopOf('fable-step', 'atop'), h.home);
  assert.equal(h.state().block.lifted, null);
  hook({ session_id: 's1', hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'k-go-on', command_args: '', prompt: '/k-go-on' }, h.home);
  assert.equal(h.state().block.lifted.by, 'override');
});

test('a subagent\'s failure after its fire blocks its caller\'s session, and its own edits are told NEEDS-FABLE (E-13)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  hook(launchOf('opus-step', 'asub'), h.home);
  const sub = { agent_id: 'asub', agent_type: 'opus-step' };
  cycle(h, 2, sub);
  freeze(edit(sub), h.home);
  hook(failure(sub), h.home);
  const { block } = h.state();
  assert.deepEqual([block.agent, block.agentType, block.rung.from, block.rung.to], ['asub', 'opus-step', 'claude-opus-5-5', 'fable'], 'the rung of the model that failed');
  assert.equal(h.state('asub').block, undefined, 'the block lives in the caller\'s file');
  assert.deepEqual(denied(freeze(edit(), h.home)).split('\n'), OPUS_DENY);
  const own = denied(freeze(edit(sub), h.home)).split('\n');
  fits(own);
  assert.equal(own[2], 'Stop and return to your caller marked NEEDS-FABLE; the owner can type /k-go-on.');
  assert.deepEqual([h.log().at(-1).trigger, h.log().at(-1).agent], ['hook blocked', 'asub']);
  hook({ session_id: 's1', hook_event_name: 'UserPromptExpansion', command_name: 'k-go-on', prompt: '/k-go-on' }, h.home);
  assert.deepEqual(h.state('asub').failures, {}, 'the override clears the subagent\'s count that set the block');
});

test('/k-go-on typed lifts the block and clears the counts; the same prompt from a cron, or inside a subagent, does not (E-11)', () => {
  const h = blocked();
  const go = { session_id: 's1', hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'k-go-on', command_args: '', prompt: '/k-go-on' };
  for (const input of [
    { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '/k-go-on' },
    { ...go, agent_id: 'asub', agent_type: 'general-purpose' },
    { ...go, command_name: 'k-done', prompt: '/k-done' },
  ]) {
    assert.equal(hook(input, h.home).stdout, '');
    assert.equal(h.state().block.lifted, null, JSON.stringify(input).slice(0, 80));
  }
  assert.equal(hook(go, h.home).stdout, '');
  const { block, failures } = h.state();
  assert.deepEqual([block.lifted.by, block.lifted.agent, failures], ['override', null, {}]);
  assert.equal(freeze(edit(), h.home).stdout, '');
  const last = h.log().at(-1);
  assert.deepEqual([last.trigger, last.liftedBy, last.signature.hash], ['/k-go-on override', 'override', block.hash]);
  hook(go, h.home);
  assert.deepEqual([h.log().at(-1).trigger, h.log().at(-1).signature], ['/k-go-on override', null], 'logged even with nothing to lift');
  assert.deepEqual(h.log().map((l) => l.trigger), ['hook fired', 'hook blocked', '/k-go-on override', '/k-go-on override'], 'every block and override logged (AC-21)');
});

test('an edit that fails to apply takes back its flag, so the next failure is no repeat (O-2)', () => {
  const h = makeHome();
  hook(failure(), h.home);
  freeze(edit({ tool_use_id: 'toolu_1' }), h.home);
  assert.equal(Object.values(h.state().failures)[0].editedBy, 'toolu_1');
  const failed = (id, tool = 'Edit') => hook({
    session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_use_id: id, tool_input: { file_path: '/tmp/x' }, error: 'EACCES: permission denied',
  }, h.home);
  assert.equal(failed('toolu_other').stdout, '');
  assert.equal(Object.values(h.state().failures)[0].editedSince, true, 'another edit\'s failure takes back nothing');
  failed('toolu_1', 'Write');
  assert.equal(Object.values(h.state().failures)[0].editedSince, false);
  hook(failure(), h.home);
  assert.equal(Object.values(h.state().failures)[0].repeats, 0, 'a rerun, not a fix that failed');
  freeze(edit({ tool_use_id: 'toolu_2' }), h.home);
  hook(failure(), h.home);
  assert.equal(Object.values(h.state().failures)[0].repeats, 1, 'an edit that applied still counts');
});

// ---- S-16: the review's findings (S-10 review.md) ----

const lastRow = (h) => h.log().at(-1);

test('unfitFor: a launch runs as a rung when its models are of the rung\'s family and its effort not below; runEnd: a run finished with a hand-back or a last text, not interrupted (S-10 B-1, S-2)', () => {
  const ladder = [{ model: 'sonnet' }, { model: 'fable', id: 'claude-fable-5[1m]', effort: 'high' }];
  assert.equal(unfitFor(ladder, 'fable', { model: 'claude-fable-5' }), null, 'the rung\'s id names its family');
  assert.equal(unfitFor(ladder, 'fable', { model: 'claude-fable-5', effort: 'medium' }), 'effort below high');
  assert.equal(unfitFor(ladder, 'fable', { model: 'claude-fable-5', effort: 'max' }), null);
  assert.equal(unfitFor(ladder, 'fable', { model: 'claude-fable-5', asked: 'haiku' }), 'model not fable', 'the Agent call\'s own model counts');
  assert.equal(unfitFor(ladder, 'fable', {}), 'model unknown');
  const t = (name) => join(FIX, `transcript-${name}.jsonl`);
  assert.deepEqual(runEnd(t('handback')), { finished: true, bytes: statSync(t('handback')).size });
  assert.equal(runEnd(t('text')).finished, true, 'a last assistant text');
  assert.equal(runEnd(t('interrupted')).finished, false);
  assert.equal(runEnd(t('interrupted'), 'Reading the failure.').finished, false, 'the interrupt wins over a last message');
  assert.equal(runEnd(t('prompt')).finished, false, 'the prompt alone, never answered');
  assert.deepEqual(runEnd('/dev/null'), { finished: false, bytes: 0 });
  assert.equal(runEnd('/nonexistent/agent-x.jsonl', 'Done: the design.').finished, true, 'SubagentStop\'s last_assistant_message');
});

test('a rung agent launched on a cheaper model or a lower effort ends and the block stays; at Fable it lifts (S-10 B-1)', () => {
  const h = blocked();
  for (const [id, opts, why] of [
    ['ahaiku', { response: { resolvedModel: 'claude-haiku-5-5' } }, 'model not fable'],
    ['aasked', { input: { model: 'haiku' } }, 'model not fable'],
    ['alow', { input: { effort: 'low' } }, 'effort below high'],
    ['anone', { response: { resolvedModel: undefined } }, 'model unknown'],
  ]) {
    hook(launchOf('fable-step', id, {}, opts), h.home);
    hook(stopOf('fable-step', id), h.home);
    assert.equal(h.state().block.lifted, null, id);
    assert.ok(denied(freeze(edit(), h.home)), `${id}: still blocked`);
    const row = lastRow(h);
    assert.deepEqual([row.trigger, row.refused.agentId, row.refused.why], ['lift refused', id, why], id);
  }
  assert.deepEqual([lastRow(h).refused.model, h.log().at(-2).refused.effort, h.log().at(-3).refused.asked], [null, 'low', 'haiku']);
  hook(launchOf('fable-step', 'afable', {}, { input: { model: 'fable', effort: 'xhigh' } }), h.home);
  hook(stopOf('fable-step', 'afable'), h.home);
  assert.equal(h.state().block.lifted.agentId, 'afable', 'Fable at an effort above the rung\'s lifts');
});

test('a rung agent that was interrupted or said nothing lifts nothing; one that finished lifts, its size logged (S-10 S-2)', () => {
  const t = (name) => join(FIX, `transcript-${name}.jsonl`);
  const h = blocked();
  for (const [id, transcript] of [['astopped', t('interrupted')], ['aempty', '/dev/null'], ['aprompt', t('prompt')]]) {
    hook(launchOf('fable-step', id), h.home);
    hook(stopOf('fable-step', id, transcript), h.home);
    assert.equal(h.state().block.lifted, null, id);
    assert.deepEqual([lastRow(h).trigger, lastRow(h).refused.why], ['lift refused', 'not finished'], id);
    assert.equal(h.state().agents[id].finished, false);
  }
  hook(launchOf('fable-step', 'adone'), h.home);
  hook(stopOf('fable-step', 'adone', t('text')), h.home);
  assert.equal(h.state().block.lifted.agentId, 'adone');
  assert.deepEqual([lastRow(h).trigger, lastRow(h).transcriptBytes], ['block lifted', statSync(t('text')).size]);
});

test('a Sonnet subagent\'s block in an Opus session is lifted by opus-step\'s finished run, one rung above the model that failed (A-2, N-1)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  hook(launchOf('general-purpose', 'asub', {}, { response: { resolvedModel: 'claude-sonnet-5' } }), h.home);
  const sub = { agent_id: 'asub', agent_type: 'general-purpose' };
  cycle(h, 2, sub);
  freeze(edit(sub), h.home);
  hook(failure(sub), h.home);
  assert.deepEqual(h.state().block.rung, { from: 'claude-sonnet-5', to: 'opus', agents: ['opus-step'] });
  // A-2's E-8: "Only an agent one rung up from the model that failed lifts the block", so fable-step, two rungs above
  // Sonnet, does not.
  hook(launchOf('fable-step', 'afable'), h.home);
  hook(stopOf('fable-step', 'afable'), h.home);
  assert.equal(h.state().block.lifted, null);
  hook(launchOf('opus-step', 'aopus'), h.home);
  hook(stopOf('opus-step', 'aopus', join(FIX, 'transcript-text.jsonl')), h.home);
  assert.equal(h.state().block.lifted.agentId, 'aopus');
});

test('fire, fable-step finishes, the test fails again: the block names no agent and waits for the owner (S-10 S-1)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  cycle(h, 2);
  hook(launchOf('fable-step', 'adesign'), h.home);
  hook(stopOf('fable-step', 'adesign'), h.home);
  assert.deepEqual(h.log().map((l) => l.trigger), ['hook fired'], 'no block yet, so nothing to lift');
  freeze(edit(), h.home);
  hook(failure(), h.home);
  const { block } = h.state();
  assert.deepEqual(block.rung, { from: 'claude-opus-5-5', to: null, agents: [], failedOn: 'fable' });
  const lines = denied(freeze(edit(), h.home)).split('\n');
  fits(lines);
  assert.equal(lines[2], 'Stop and say plainly what is missing; the owner can type /k-go-on.');
  hook(launchOf('fable-step', 'again'), h.home);
  hook(stopOf('fable-step', 'again'), h.home);
  assert.equal(h.state().block.lifted, null, 'a second Fable run lifts nothing');
  const sonnet = makeHome({}, FABLE_LADDER);
  hook(start('claude-sonnet-5'), sonnet.home);
  cycle(sonnet, 2);
  hook(launchOf('opus-step', 'abuild'), sonnet.home);
  hook(stopOf('opus-step', 'abuild', join(FIX, 'transcript-text.jsonl')), sonnet.home);
  freeze(edit(), sonnet.home);
  hook(failure(), sonnet.home);
  assert.deepEqual(sonnet.state().block.rung, { from: 'claude-sonnet-5', to: 'fable', agents: ['fable-step', 'music-deep'], failedOn: 'opus' });
  assert.equal(denied(freeze(edit(), sonnet.home)).split('\n')[2], 'Launch fable-step (or music-deep) on this step; the owner can type /k-go-on.');
});

test('fire, fable-step launched, the test fails again, fable-step ends: lifted by that one run (S-10 S-1)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  cycle(h, 2);
  hook(launchOf('fable-step', 'adesign'), h.home);
  freeze(edit(), h.home);
  hook(failure(), h.home);
  const { block, failures } = h.state();
  assert.equal(block.firedAt, Object.values(failures)[0].firedAt, 'the threshold is the fire');
  assert.deepEqual(block.rung.agents, ['fable-step', 'music-deep']);
  assert.ok(denied(freeze(edit(), h.home)));
  hook(stopOf('fable-step', 'adesign'), h.home);
  assert.equal(h.state().block.lifted.agentId, 'adesign');
  assert.equal(freeze(edit(), h.home).stdout, '');
});

test('a signature blocked while another block was in force blocks once that one is lifted (S-10 N-3)', () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  const other = 'Exit code 1\nnot ok 3 - reads the queue\n';
  const both = () => [hook(failure(), h.home), hook(failure({}, NODE_CMD, other), h.home)];
  both();
  for (let i = 0; i < 2; i++) {
    freeze(edit(), h.home);
    both();
  }
  freeze(edit(), h.home);
  both();
  const first = h.state().block;
  assert.equal(first.label, 'climbs one rung');
  const queue = Object.values(h.state().failures).find((f) => f.label === 'reads the queue');
  assert.deepEqual([queue.fired, queue.blocked], [true, true], 'blocked while the first block was in force');
  hook(launchOf('fable-step', 'alift'), h.home);
  hook(stopOf('fable-step', 'alift'), h.home);
  assert.ok(h.state().block.lifted);
  hook(failure({}, NODE_CMD, other), h.home);
  const { block } = h.state();
  assert.deepEqual([block.label, block.lifted], ['reads the queue', null]);
  assert.equal(lastRow(h).trigger, 'hook blocked');
  assert.ok(denied(freeze(edit(), h.home)));
});

// A hook run as Claude Code runs it, not waited for, so several run at once.
const hookAsync = (script, input, home) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], { env: cleanEnv({ KIRUNAK_HOME: home }), stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', reject);
  child.on('close', resolve);
  child.stdin.end(JSON.stringify(input));
});

test('writers at once all land: each waits for the state file\'s lock (S-10 S-3)', async () => {
  const h = makeHome({}, FABLE_LADDER);
  hook(start('claude-opus-5-5'), h.home);
  hook(failure(), h.home);
  const lock = `${statePath(h.home, 's1')}.lock`;
  mkdirSync(lock);
  const ids = ['ap1', 'ap2'];
  const runs = [...ids.map((id) => hookAsync(HOOK, launchOf('fable-step', id), h.home)), hookAsync(FREEZE, edit(), h.home)];
  setTimeout(() => rmdirSync(lock), 25);
  assert.deepEqual(await Promise.all(runs), [0, 0, 0]);
  const state = h.state();
  assert.deepEqual(ids.filter((id) => state.agents[id]), ids, 'every launch recorded');
  assert.equal(Object.values(state.failures)[0].editedSince, true, 'and the edit\'s flag');
  assert.ok(!existsSync(lock), 'the lock is gone');
});

test('a state file\'s lock held by another hook is skipped within about 100 ms, and one older than 2 s taken over (S-10 S-3)', () => {
  const h = makeHome();
  hook(failure(), h.home);
  const lock = `${statePath(h.home, 's1')}.lock`;
  mkdirSync(lock);
  const t = Date.now();
  assert.equal(withState(h.home, 's1', null, () => 'ran'), undefined, 'a held lock: skipped, not waited on');
  assert.ok(Date.now() - t < 1000, `waited ${Date.now() - t} ms`);
  const old = new Date(Date.now() - 3000);
  utimesSync(lock, old, old);
  assert.equal(withState(h.home, 's1', null, () => 'ran'), 'ran', 'a lock older than 2 s is a crashed hook\'s');
  assert.ok(!existsSync(lock));
  assert.equal(withState(h.home, 's1', null, () => 'again'), 'again', 'released after the run');
});

// ---- AC-12: the time the hook adds, machine-bound, so only with KIRUNAK_TIMING=1 ----

// Median and p95 of 30 runs after one warm-up, as S-1 §6 measured (spawnSync, the event on stdin).
function timing(args, input, env) {
  const once = () => {
    const t = process.hrtime.bigint();
    spawnSync(process.execPath, args, { input, env, encoding: 'utf8' });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  once();
  const ms = Array.from({ length: 30 }, once).sort((a, b) => a - b);
  return { median: (ms[14] + ms[15]) / 2, p95: ms[Math.ceil(0.95 * ms.length) - 1] };
}

test('the hook\'s quiet path: median at most 50 ms and node\'s + 12, p95 at most the freeze hook\'s + 5 (AC-12)', { skip: process.env.KIRUNAK_TIMING !== '1' }, (t) => {
  const h = makeHome();
  const env = cleanEnv({ KIRUNAK_HOME: h.home });
  hook(failure(), h.home);
  const node = timing(['-e', ''], '', env);
  const freezeEdit = timing([FREEZE], JSON.stringify(edit({ tool_input: { file_path: fileURLToPath(new URL('../lib/home.mjs', import.meta.url)), old_string: 'a', new_string: 'b' } })), env);
  const other = timing([HOOK], JSON.stringify(failure({}, 'ls nope', 'Exit code 1\nls: nope: No such file or directory')), env);
  const build = timing([HOOK], JSON.stringify(failure()), env);
  const show = (name, r) => `${name}: median=${r.median.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms`;
  for (const [name, r] of [['node -e ""', node], ['freeze Edit', freezeEdit], ['escalate non-matching', other], ['escalate matching', build]]) t.diagnostic(show(name, r));
  for (const r of [other, build]) {
    assert.ok(r.median <= 50 && r.median <= node.median + 12, `median ${r.median.toFixed(1)} against node's ${node.median.toFixed(1)}`);
    assert.ok(r.p95 <= freezeEdit.p95 + 5, `p95 ${r.p95.toFixed(1)} against the freeze hook's ${freezeEdit.p95.toFixed(1)}`);
  }
});

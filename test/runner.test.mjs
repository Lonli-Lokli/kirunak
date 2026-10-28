import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runnerClaude, { claudeArgs, KEEP_ALIVE_PROMPT, limitsArgs, LIMITS_PROMPT, parseResult, readLimits } from '../plugins/runner-claude.mjs';
import { fakeClaude, FIXTURES, RESULT } from './helpers.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const BASE = { permissionMode: 'auto', maxTurns: 100, maxBudgetUsd: 3, sessionId: '11111111-2222-4333-8444-555555555555' };

test('the command of orchestrator.md §3: no --model or --effort when none is named', () => {
  assert.deepEqual(claudeArgs(BASE), [
    '-p', '--output-format', 'json', '--permission-mode', 'auto', '--max-turns', '100', '--max-budget-usd', '3',
    '--disallowedTools', 'Agent', '--session-id', BASE.sessionId,
  ]);
  assert.deepEqual(claudeArgs({ ...BASE, model: 'sonnet', effort: 'high', addDirs: ['/w/hub'] }), [
    '-p', '--output-format', 'json', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'auto', '--max-turns', '100',
    '--max-budget-usd', '3', '--disallowedTools', 'Agent', '--session-id', BASE.sessionId, '--add-dir', '/w/hub',
  ]);
});

test('a step that names its tools starts with only those, as --tools; none named keeps every tool', () => {
  const args = claudeArgs({ ...BASE, tools: ['Bash', 'Read', 'Write'] });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Bash,Read,Write']);
  assert.equal(claudeArgs(BASE).includes('--tools'), false);
});

test('deny rules go as --settings with permissions.deny and auto memory off, and only when there are some', () => {
  const deny = ['Read(//w/weather/kirunak/tasks/offline-forecast/progress.md)', 'Read(~/.claude/projects/**)'];
  const args = claudeArgs({ ...BASE, deny });
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), ['--settings', JSON.stringify({ permissions: { deny }, autoMemoryEnabled: false })]);
  assert.equal(claudeArgs({ ...BASE, deny: [] }).includes('--settings'), false);
});

test('a resume takes the prompt after -p, the same flags, --resume and no new session id', () => {
  const args = claudeArgs({ ...BASE, resume: 'abc-session', prompt: 'the job ended; read x and continue', addDirs: ['/w/hub'] });
  assert.deepEqual(args, [
    '-p', 'the job ended; read x and continue', '--output-format', 'json', '--permission-mode', 'auto', '--max-turns', '100',
    '--max-budget-usd', '3', '--disallowedTools', 'Agent', '--add-dir', '/w/hub', '--resume', 'abc-session',
  ]);
});

test('the result parser reads the documented JSON result, a stream, and a line after a warning', () => {
  const r = parseResult(RESULT);
  assert.equal(r.session_id, '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f');
  assert.equal(r.num_turns, 12);
  assert.equal(r.is_error, false);
  assert.equal(r.usage.cache_creation.ephemeral_1h_input_tokens, 30000);
  assert.equal(parseResult(JSON.stringify([{ type: 'system' }, { type: 'result', num_turns: 2 }])).num_turns, 2);
  assert.equal(parseResult('warning: something\n' + JSON.stringify(JSON.parse(RESULT))).num_turns, 12);
  assert.equal(parseResult('not json'), null);
  assert.equal(parseResult(''), null);
});

test('start: the brief on stdin, the repo as cwd, the step in the environment, a minted session id, the result parsed', async () => {
  const fake = fakeClaude();
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-repo-')));
  const runner = runnerClaude({ runner: { permissionMode: 'acceptEdits' } }, { bin: fake.bin }).provides.runner;
  const run = runner.start({ prompt: '# the brief\n', cwd, maxTurns: 100, maxBudgetUsd: 3, env: { KIRUNAK_TASK: 'weather/x', KIRUNAK_STEP: 'S-1' } });
  assert.match(run.sessionId, UUID);
  assert.equal(typeof run.pid, 'number');
  const done = await run.done;
  assert.equal(done.exitCode, 0);
  assert.equal(done.result.session_id, '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f');
  assert.equal(done.usage.input_tokens, 3000);
  const [call] = fake.calls();
  assert.equal(call.stdin, '# the brief\n');
  assert.equal(call.cwd, cwd);
  assert.deepEqual([call.task, call.step], ['weather/x', 'S-1']);
  assert.deepEqual(call.argv.slice(call.argv.indexOf('--permission-mode'), call.argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
  assert.equal(call.argv[call.argv.indexOf('--session-id') + 1], run.sessionId);
});

test('a run that prints no result ends with its exit code and no result', async () => {
  const fake = fakeClaude('');
  const runner = runnerClaude({}, { bin: fake.bin }).provides.runner;
  const done = await runner.start({ prompt: 'x', cwd: fake.dir }).done;
  assert.deepEqual([done.exitCode, done.result, done.usage], [0, null, null]);
  const missing = await runnerClaude({}, { bin: join(fake.dir, 'no-such-claude') }).provides.runner.start({ prompt: 'x', cwd: fake.dir }).done;
  assert.equal(missing.exitCode, 127);
});

test('keepAlive: one turn on the conversation with the step\'s flags, its handle\'s done the whole result', async () => {
  const fake = fakeClaude();
  const runner = runnerClaude({}, { bin: fake.bin }).provides.runner;
  const handle = runner.keepAlive('abc-session', fake.dir, { addDirs: ['/w/hub'] });
  assert.ok(Number.isInteger(handle.pid), 'a pid, so a deadline can kill it');
  const { exitCode, result, usage } = await handle.done;
  assert.equal(exitCode, 0);
  assert.equal(usage.cache_read_input_tokens, 600000);
  assert.equal(result.session_id, '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', 'the record keep-<k>.json is');
  const [call] = fake.calls();
  assert.deepEqual(call.argv, [
    '-p', KEEP_ALIVE_PROMPT, '--output-format', 'json', '--permission-mode', 'auto', '--max-turns', '1',
    '--disallowedTools', 'Agent', '--add-dir', '/w/hub', '--resume', 'abc-session',
  ]);
});

// gulnya/quad-damage AC-9, AC-10: the limits reading. limits.jsonl is a real session's stream (`claude -p` on Haiku,
// stream-json), its ids, paths and request ids replaced by dummies, its hook lines left out.
const STREAM = readFileSync(join(FIXTURES, 'run', 'limits.jsonl'), 'utf8');
const lines = STREAM.trim().split('\n').map((l) => JSON.parse(l));
const EVENT = lines.find((x) => x.type === 'rate_limit_event');
const stream = (...xs) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
const withInfo = (info) => ({ ...EVENT, rate_limit_info: { ...EVENT.rate_limit_info, ...info } });
const windows = (five, week) => ({ unifiedWindows: { five_hour: { utilization: five, resetsAt: 1793142600, status: 'allowed' }, seven_day: { utilization: week, resetsAt: 1793545200, status: 'allowed' } } });

// A node script as `claude`, for what fakeClaude cannot do: fail, or never end.
function fakeBin(body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-fake-claude-')));
  writeFileSync(join(dir, 'claude'), `#!${process.execPath}\n${body}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return join(dir, 'claude');
}

test('limits: one turn on Haiku with no tools, read from the stream\'s rate_limit_event, used in percent', () => {
  assert.deepEqual(limitsArgs(), ['-p', LIMITS_PROMPT, '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', '--tools', '']);
  const reading = { fiveHour: { used: 33, resetsAt: 1793142600 }, week: { used: 52, resetsAt: 1793545200 }, overage: false };
  assert.deepEqual(readLimits(STREAM), reading);
  assert.deepEqual(readLimits(`not json\n${STREAM}\n{"partial`), reading, 'a line not JSON is passed over');
  const later = readLimits(stream(...lines, withInfo({ ...windows(0.29, 0.987), isUsingOverage: true })));
  assert.deepEqual(later, { fiveHour: { used: 29, resetsAt: 1793142600 }, week: { used: 98.7, resetsAt: 1793545200 }, overage: true }, 'the last event, its floats rounded');
  // A turn refused for a window used up still says how full the windows are.
  const refused = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", num_turns: 1 };
  assert.deepEqual(readLimits(stream(withInfo({ ...windows(1, 0.6), status: 'rejected' }), refused), { exitCode: 1 }).fiveHour, { used: 100, resetsAt: 1793142600 });
});

test('limits: no reading says why, an event without its windows, a failed session, the login gone, no event', () => {
  const [init, said, , result] = lines;
  const { unifiedWindows, ...bare } = EVENT.rate_limit_info;
  assert.deepEqual(readLimits(stream(init, said, { ...EVENT, rate_limit_info: bare }, result)), { error: 'its rate_limit_event has no unifiedWindows with five_hour and seven_day' });
  const half = { ...EVENT, rate_limit_info: { ...bare, unifiedWindows: { five_hour: unifiedWindows.five_hour } } };
  assert.deepEqual(readLimits(stream(half, result)), { error: 'its rate_limit_event has no unifiedWindows with five_hour and seven_day' });
  assert.deepEqual(readLimits(stream(init, said, result)), { error: 'the session gave no rate_limit_event' });
  assert.deepEqual(readLimits(''), { error: 'the session gave no rate_limit_event' });

  const failed = { ...result, is_error: true, subtype: 'error_during_execution', result: 'API Error: 529 overloaded' };
  assert.deepEqual(readLimits(stream(init, failed), { exitCode: 1, stderr: '' }), { error: 'the session failed (exit 1): API Error: 529 overloaded' });
  assert.deepEqual(readLimits('', { exitCode: 2, stderr: 'error: unknown option\n' }), { error: 'the session failed (exit 2): error: unknown option' });
  assert.deepEqual(readLimits(stream(init, failed)), { error: 'the session failed (exit 0): API Error: 529 overloaded' });

  // The login gone: the assistant message's `error` (the SDK's authentication_failed), or the words that ask for /login.
  const text = 'Not logged in · Please run /login';
  const authSaid = { ...said, error: 'authentication_failed', message: { ...said.message, content: [{ type: 'text', text }] } };
  const authResult = { ...result, is_error: true, result: text };
  assert.deepEqual(readLimits(stream(init, authSaid, authResult), { exitCode: 1 }), { error: `the login is gone: ${text}` });
  assert.deepEqual(readLimits(stream(init, { ...authSaid, message: { ...said.message, content: [] } }, { ...result, result: '' }), { exitCode: 1 }), { error: 'the login is gone: authentication failed' });
  assert.deepEqual(readLimits('', { exitCode: 1, stderr: 'Invalid API key · Fix external API key' }), { error: 'the login is gone: Invalid API key · Fix external API key' });
});

test('limits(): the runner spawns the reading in the temporary folder and reads its stream; a failure or a hang is an error', async () => {
  const fake = fakeClaude(STREAM);
  const runner = runnerClaude({}, { bin: fake.bin }).provides.runner;
  assert.deepEqual(await runner.limits(), readLimits(STREAM));
  assert.deepEqual(await runner.limits({ cwd: fake.dir }), readLimits(STREAM));
  const [first, second] = fake.calls();
  assert.deepEqual([first.argv, first.stdin, first.cwd, second.cwd], [limitsArgs(), '', realpathSync(tmpdir()), fake.dir]);

  const failing = runnerClaude({}, { bin: fakeBin("process.stderr.write('Not logged in · Please run /login\\n'); process.exit(1);") }).provides.runner;
  assert.deepEqual(await failing.limits(), { error: 'the login is gone: Not logged in · Please run /login' });
  const missing = await runnerClaude({}, { bin: join(fake.dir, 'no-such-claude') }).provides.runner.limits();
  assert.match(missing.error, /^the session failed \(exit 127\)/);
  const hung = runnerClaude({}, { bin: fakeBin('setInterval(() => {}, 1000);') }).provides.runner;
  assert.deepEqual(await hung.limits({ timeoutMs: 300 }), { error: 'no reading in 0.3 s: the session was stopped' });
});

// gulnya/quad-damage AC-11: a session read as it goes streams, and each message reaches onMessage whole, however its
// lines are cut; what onMessage throws does not end the session.
test('start with onMessage: stream-json with --verbose, each line handed over as it comes, the result still parsed', async () => {
  assert.deepEqual(claudeArgs({ ...BASE, stream: true }).slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
  const res = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } };
  const end = { type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done', session_id: 's' };
  const text = [use, res, end].map((x) => JSON.stringify(x)).join('\n');
  const bin = fakeBin(`const t = ${JSON.stringify(text)};
process.stdout.write('not json\\n' + t.slice(0, 30));
setTimeout(() => process.stdout.write(t.slice(30)), 50);`);
  const seen = [];
  const runner = runnerClaude({}, { bin }).provides.runner;
  const run = runner.start({ prompt: 'p', cwd: tmpdir(), maxTurns: 150, onMessage: (m) => {
    seen.push(m.type);
    if (m.type === 'user') throw new Error('a reader fault');
  } });
  const done = await run.done;
  assert.deepEqual(seen, ['assistant', 'user', 'result']);
  assert.equal(done.exitCode, 0);
  assert.equal(done.result.num_turns, 2);
});

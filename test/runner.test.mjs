import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runnerClaude, { claudeArgs, KEEP_ALIVE_PROMPT, parseResult } from '../plugins/runner-claude.mjs';
import { fakeClaude, RESULT } from './helpers.mjs';

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

test('keepAlive: one turn on the conversation with the step\'s flags, returning its whole result', async () => {
  const fake = fakeClaude();
  const runner = runnerClaude({}, { bin: fake.bin }).provides.runner;
  const { exitCode, result, usage } = await runner.keepAlive('abc-session', fake.dir, { addDirs: ['/w/hub'] });
  assert.equal(exitCode, 0);
  assert.equal(usage.cache_read_input_tokens, 600000);
  assert.equal(result.session_id, '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', 'the record keep-<k>.json is');
  const [call] = fake.calls();
  assert.deepEqual(call.argv, [
    '-p', KEEP_ALIVE_PROMPT, '--output-format', 'json', '--permission-mode', 'auto', '--max-turns', '1',
    '--disallowedTools', 'Agent', '--add-dir', '/w/hub', '--resume', 'abc-session',
  ]);
});

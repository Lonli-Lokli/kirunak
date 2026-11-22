// The agent's notices at its 75th and 100th call (gulnya/usage-improve-11-22 AC-15): the count hook on PostToolUse,
// every tool, counts each agent of a session apart in <home>/counts/<session>.json and gives each notice once as
// additionalContext; a main session's call gets no agent notice; it never blocks and fails open; k install wires it
// once, k install --print shows it and k doctor reads it. Fixtures only, never this machine's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_LAST, AGENT_SOON, reply } from '../hooks/kirunak-count.mjs';
import { countHookLine } from '../lib/doctor.mjs';
import { install } from '../lib/install.mjs';
import { KIRUNAK, tempDir } from './helpers.mjs';

const SID = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const tmp = () => tempDir('kirunak-count-');
const call = (agent, tool = 'Read') => ({
  session_id: SID, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {},
  ...(agent ? { agent_id: agent, agent_type: 'builder' } : {}),
});
const notice = (out) => out?.hookSpecificOutput?.additionalContext ?? null;

test('AC-15: an agent\'s 74th call is silent, its 75th gets the first notice, its 76th is silent, its 100th the second', () => {
  const home = tmp();
  const said = [];
  for (let n = 1; n <= 120; n++) said.push(notice(reply(call('a1'), home)));
  assert.deepEqual(said.map((s, i) => (s ? i + 1 : 0)).filter(Boolean), [75, 100], 'only the 75th and the 100th speak');
  assert.equal(said[73], null, '74th silent');
  assert.equal(said[74], AGENT_SOON);
  assert.equal(said[75], null, '76th silent');
  assert.equal(said[99], AGENT_LAST);
  assert.match(AGENT_SOON, /^About 25 calls are left for this agent: finish the piece in hand, and write what is left to a handoff file by call 100\.$/);
  assert.equal(AGENT_LAST, "Return now with the short report and the handoff file's path.");
  const out = reply(call('a2'), home);
  assert.equal(out, null, 'a first call says nothing');
  const counts = JSON.parse(readFileSync(join(home, 'counts', `${SID}.json`), 'utf8'));
  assert.equal(counts.agents.a1.calls, 120);
});

test('AC-15: the notice is PostToolUse additionalContext, never a decision', () => {
  const home = tmp();
  let out = null;
  for (let n = 1; n <= 75; n++) out = reply(call('a1'), home);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: AGENT_SOON } });
});

test('AC-15: two agents of one session are counted apart', () => {
  const home = tmp();
  for (let n = 1; n <= 74; n++) reply(call('a1'), home);
  for (let n = 1; n <= 50; n++) assert.equal(reply(call('a2'), home), null, 'a2 under 75');
  assert.equal(notice(reply(call('a1'), home)), AGENT_SOON, "a1's 75th, whatever a2 did");
  for (let n = 51; n <= 74; n++) reply(call('a2'), home);
  assert.equal(notice(reply(call('a2'), home)), AGENT_SOON, "a2's own 75th");
});

test("AC-15: a main session's call never gets an agent notice, and is not counted to an agent", () => {
  const home = tmp();
  for (let n = 1; n <= 120; n++) assert.equal(reply(call(null, 'Bash'), home), null);
  for (let n = 1; n <= 74; n++) reply(call('a1'), home);
  assert.equal(notice(reply(call('a1'), home)), AGENT_SOON, "the main session's calls did not move the agent's count");
});

test('AC-15: an unwritable count file lets the call through silent; unreadable input and a bad session id too', () => {
  // A count file that cannot be written on every OS: a folder where it goes (chmod makes no folder read-only on
  // Windows, so a mode would let the writes through there).
  const locked = tmp();
  mkdirSync(join(locked, 'counts', `${SID}.json`), { recursive: true });
  for (let n = 1; n <= 100; n++) assert.equal(reply(call('a1'), locked), null);
  const home = tmp();
  mkdirSync(join(home, 'counts'));
  assert.equal(reply({ ...call('a1'), session_id: '../escape' }, home), null);
  assert.equal(existsSync(join(home, 'escape.json')), false);
  assert.equal(reply(null, home), null);
  // A count file that is not JSON starts again, never throws.
  writeFileSync(join(home, 'counts', `${SID}.json`), '{not json');
  assert.equal(reply(call('a1'), home), null);
  // The hook as Claude Code runs it: exit 0 and nothing printed, even on input that is not JSON.
  const run = (input, h) => spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'kirunak-count.mjs')],
    { input, encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: h } });
  const r = run('not json', home);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const blocked = tmp();
  writeFileSync(join(blocked, 'counts'), 'a file where the folder goes');
  const s = run(JSON.stringify(call('a1')), blocked);
  assert.equal(s.status, 0);
  assert.equal(s.stdout, '');
});

test('AC-15: the hook run as a process prints the notice at the 75th call', () => {
  const home = tmp();
  for (let n = 1; n <= 74; n++) reply(call('a1'), home);
  const r = spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'kirunak-count.mjs')],
    { input: JSON.stringify(call('a1')), encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, AGENT_SOON);
});

// An install into a temporary settings file, never the user's.
const installInto = (dir, extra = {}) => install({
  settingsPath: join(dir, 'settings.json'), kirunakRoot: KIRUNAK, skillsDir: join(dir, 'skills'),
  agentsDir: join(dir, 'agents'), home: join(dir, 'home'), ...extra,
});

test("AC-15: k install's plan adds the count hook once on PostToolUse for every tool, beside the escalation hook's Agent block; k doctor reads it", () => {
  const dir = tmp();
  const settingsPath = join(dir, 'settings.json');
  // The command as k install writes it on this machine: on Windows the path quoted, each backslash doubled.
  const script = join(KIRUNAK, 'hooks', 'kirunak-count.mjs');
  const count = { type: 'command', command: process.platform === 'win32' ? `node "${script.replaceAll('\\', '\\\\')}"` : `node ${script}`, timeout: 10 };
  assert.deepEqual(countHookLine({ settingsPath }), [false, `the count hook: not wired on PostToolUse in ${settingsPath} (run k install)`]);
  const printed = installInto(dir, { print: true }).actions;
  assert.equal(printed.filter((a) => a === `would add to ${settingsPath} hooks.PostToolUse: ${JSON.stringify({ hooks: [count] })}`).length, 1, printed.join('\n'));
  installInto(dir);
  installInto(dir);
  const post = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PostToolUse;
  assert.deepEqual(post.filter((b) => b.hooks.some((h) => h.command.includes('kirunak-count.mjs'))), [{ hooks: [count] }], 'once, no matcher: every tool');
  assert.equal(post.filter((b) => b.matcher === 'Agent' && b.hooks[0].command.includes('kirunak-escalate.mjs')).length, 1, "the escalation hook's block kept");
  assert.match(installInto(dir, { print: true }).actions.join('\n'), /already has the kirunak PostToolUse hook/);
  assert.deepEqual(countHookLine({ settingsPath }), [true, 'the count hook: wired on PostToolUse, every tool']);
  // A block of ours given a matcher is set back to every tool, and k doctor says so until then.
  const json = JSON.parse(readFileSync(settingsPath, 'utf8'));
  json.hooks.PostToolUse.find((b) => b.hooks[0].command.includes('kirunak-count.mjs')).matcher = 'Bash';
  writeFileSync(settingsPath, JSON.stringify(json));
  assert.deepEqual(countHookLine({ settingsPath }), [false, "the count hook: wired on PostToolUse with matcher Bash, kirunak's none (run k install)"]);
  installInto(dir);
  assert.deepEqual(countHookLine({ settingsPath }), [true, 'the count hook: wired on PostToolUse, every tool']);
});

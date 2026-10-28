// The stale-session hook and the rate-limit line (gulnya/k-usage S-3: AC-3, AC-4, D-4, D-5, D-8): the hook speaks once,
// past both the gap and the context, naming `k handoff <id>` with a task and "start fresh" without; it never blocks and
// lets every prompt it cannot read through silent; k install wires it once on UserPromptSubmit; the status line's
// tracker appends the limits log's line on a change only; Quad Damage still finds its log under bugs.limitsLog.
// Fixtures only, never this machine's transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advice, lastCall, reply } from '../hooks/kirunak-stale.mjs';
import { limitsOf, track } from '../hooks/statusline-track.mjs';
import { install } from '../lib/install.mjs';
import { logLimits } from '../lib/limits.mjs';
import { loadWorkspace } from '../lib/workspace.mjs';
import { KIRUNAK, makeWorkspace } from './helpers.mjs';

const SID = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const NOW = Date.parse('2026-11-03T15:00:00Z');
const MIN = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'kirunak-stale-'));

// An invented transcript: a user line, an assistant call `ago` minutes before NOW holding `context` tokens, and a
// synthetic call after it, which never counts.
function transcript(dir, { ago, context, now = NOW }) {
  const at = (m) => new Date(now - m * MIN).toISOString();
  const call = (m, model, ctx) => JSON.stringify({
    type: 'assistant', timestamp: at(m),
    message: { model, usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: ctx - 1000, output_tokens: 50 } },
  });
  const file = join(dir, `${SID}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: at(ago + 1), message: { content: 'go on' } }),
    call(ago, 'claude-opus-5-5', context),
    call(ago - 1, '<synthetic>', 5),
  ].join('\n') + '\n');
  return file;
}

// A KIRUNAK_HOME with the session's file (its task, when given) and config.json's usage block (when given).
function kHome({ task = null, stale = null } = {}) {
  const home = tmp();
  if (task) {
    mkdirSync(join(home, 'sessions'));
    writeFileSync(join(home, 'sessions', `${SID}.json`), JSON.stringify({ task, since: '2026-11-03T09:00:00Z' }));
  }
  if (stale) {
    mkdirSync(join(home, 'escalate'));
    writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify({ usage: { stale, limitsLog: null } }));
  }
  return home;
}

const run = (home, input) => spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'kirunak-stale.mjs')],
  { input, encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });

test('the stale-session hook: silent under the gap, silent under the context, one line past both', () => {
  const dir = tmp(), home = kHome();
  const ask = (ago, context) => reply({ session_id: SID, transcript_path: transcript(dir, { ago, context }) }, home, NOW);
  assert.equal(ask(59, 400_000), null, 'under the gap');
  assert.equal(ask(60, 400_000), null, 'at the gap');
  assert.equal(ask(180, 150_000), null, 'at the context');
  assert.equal(ask(180, 90_000), null, 'under the context');
  const r = ask(61, 150_001);
  assert.equal(r.systemMessage.split('\n').length, 1, 'one line');
  assert.match(r.systemMessage, /idle 61 minutes and holds 150k tokens/);
  assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ask(185, 300_000).systemMessage, /idle 3 hours and holds 300k tokens/);
  assert.equal(lastCall(transcript(dir, { ago: 10, context: 200_000 })).context, 200_000, 'the synthetic call after it is skipped');
});

test('the workspace\'s usage.stale, from config.json, sets both thresholds', () => {
  const dir = tmp(), home = kHome({ stale: { minutes: 30, context: 50_000 } });
  const ask = (ago, context) => reply({ session_id: SID, transcript_path: transcript(dir, { ago, context }) }, home, NOW);
  assert.ok(ask(31, 50_001));
  assert.equal(ask(29, 400_000), null);
  assert.equal(ask(31, 50_000), null);
});

test('with a task it names `k handoff <id>`, without one it says to start fresh', () => {
  const dir = tmp();
  const input = { session_id: SID, transcript_path: transcript(dir, { ago: 120, context: 250_000 }) };
  const withTask = reply(input, kHome({ task: 'weather/offline-forecast' }), NOW);
  assert.match(withTask.systemMessage, /`k handoff weather\/offline-forecast`/);
  assert.match(withTask.hookSpecificOutput.additionalContext, /k handoff weather\/offline-forecast/);
  const without = reply(input, kHome(), NOW);
  assert.match(without.systemMessage, /Start fresh/);
  assert.doesNotMatch(JSON.stringify(without), /k handoff/);
  assert.equal(advice({ at: NOW - 120 * MIN, context: 250_000 }, { now: NOW, task: null }).systemMessage, without.systemMessage);
});

test('a missing, empty or garbled transcript lets the prompt through silent, exit 0; no reply ever carries a decision', () => {
  const dir = tmp(), home = kHome({ task: 'weather/offline-forecast' });
  const empty = join(dir, 'empty.jsonl'), garbled = join(dir, 'garbled.jsonl'), noTime = join(dir, 'no-time.jsonl');
  writeFileSync(empty, '');
  writeFileSync(garbled, '{"type":"assistant","message":{"usage":\n\0\0 not json "usage" at all\n[1,2,"usage"]\n');
  writeFileSync(noTime, JSON.stringify({ type: 'assistant', timestamp: 'yesterday', message: { model: 'x', usage: { input_tokens: 900000 } } }) + '\n');
  for (const stdin of [
    JSON.stringify({ session_id: SID, transcript_path: join(dir, 'missing.jsonl') }),
    JSON.stringify({ session_id: SID, transcript_path: empty }),
    JSON.stringify({ session_id: SID, transcript_path: garbled }),
    JSON.stringify({ session_id: SID, transcript_path: noTime }),
    JSON.stringify({ session_id: SID, transcript_path: dir }),
    JSON.stringify({ session_id: SID }),
    'not json',
    '',
  ]) {
    const r = run(home, stdin);
    assert.equal(r.status, 0, stdin);
    assert.equal(r.stdout, '', stdin);
  }
  const stale = run(home, JSON.stringify({ session_id: SID, transcript_path: transcript(dir, { ago: 600, context: 900_000, now: Date.now() }) }));
  assert.equal(stale.status, 0);
  const out = JSON.parse(stale.stdout);
  assert.ok(!('decision' in out) && !('continue' in out), 'it never blocks');
  assert.match(out.systemMessage, /idle 10 hours/);
});

// An install into a temporary settings file, never the user's.
function installInto(dir, extra = {}) {
  return install({
    settingsPath: join(dir, 'settings.json'), kirunakRoot: KIRUNAK, skillsDir: join(dir, 'skills'),
    agentsDir: join(dir, 'agents'), home: join(dir, 'home'), ...extra,
  });
}

test('k install wires the stale-session hook once on UserPromptSubmit beside the escalation hook, and --print shows it', () => {
  const dir = tmp();
  const printed = installInto(dir, { print: true }).actions.join('\n');
  assert.match(printed, /would add to .*settings\.json hooks\.UserPromptSubmit: .*hooks\/kirunak-stale\.mjs/);
  installInto(dir);
  installInto(dir);
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  const commands = settings.hooks.UserPromptSubmit.flatMap((b) => b.hooks.map((h) => h.command));
  assert.equal(commands.filter((c) => c.endsWith('hooks/kirunak-stale.mjs')).length, 1, 'once after two installs');
  assert.equal(commands.filter((c) => c.endsWith('hooks/kirunak-escalate.mjs')).length, 1);
  assert.match(installInto(dir, { print: true }).actions.join('\n'), /already has the kirunak UserPromptSubmit hook/);
  // An entry from another checkout is pointed here, never doubled.
  const old = structuredClone(settings);
  old.hooks.UserPromptSubmit = old.hooks.UserPromptSubmit.map((b) => (b.hooks[0].command.endsWith('kirunak-stale.mjs')
    ? { hooks: [{ type: 'command', command: 'node /old/kirunak/hooks/kirunak-stale.mjs', timeout: 5 }] } : b));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(old));
  installInto(dir);
  const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks.UserPromptSubmit.flatMap((b) => b.hooks);
  assert.deepEqual(after.filter((h) => h.command.includes('kirunak-stale.mjs')),
    [{ type: 'command', command: `node ${join(KIRUNAK, 'hooks', 'kirunak-stale.mjs')}`, timeout: 10 }]);
  const config = JSON.parse(readFileSync(join(dir, 'home', 'escalate', 'config.json'), 'utf8'));
  assert.deepEqual(config.usage, { stale: { minutes: 60, context: 150000 }, limitsLog: null }, 'no workspace: the defaults');
});

const STATUS = (week, fiveHour, name) => ({
  session_id: SID, ...(name === undefined ? {} : { session_name: name }),
  rate_limits: { seven_day: { used_percentage: week, resets_at: 1793545200 }, five_hour: { used_percentage: fiveHour, resets_at: 1793142600 } },
});

test('the tracker appends the rate-limit line on a change and not on a repeat, in the status line\'s format', () => {
  const home = tmp(), log = join(home, 'rate-limits.log');
  track(STATUS(53.99, 1.5, 'k-usage S-3'), home, new Date('2026-10-27T23:18:51.456Z'));
  track(STATUS(53.2, 1.9, 'another'), home, new Date('2026-10-27T23:19:21Z'));
  track(STATUS(54, 1.5), home, new Date('2026-10-27T23:25:00Z'));
  track({ session_id: SID }, home, new Date('2026-10-27T23:26:00Z'));
  assert.equal(readFileSync(log, 'utf8'), '2026-10-27T23:18:51Z\t53\t1\tk-usage S-3\n2026-10-27T23:25:00Z\t54\t1\t-\n');
  assert.deepEqual(limitsOf({ rate_limits: { seven_day: { used_percentage: 7 } } }).reading, { week: { used: 7 }, fiveHour: { used: -1 } });
  assert.equal(limitsOf({ rate_limits: {} }), null);
  // The workspace's log, through config.json.
  mkdirSync(join(home, 'escalate'));
  const own = join(home, 'state', 'limits.log');
  writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify({ usage: { limitsLog: own } }));
  track(STATUS(60, 3, 'x'), home, new Date('2026-10-28T01:00:00Z'));
  assert.equal(readFileSync(own, 'utf8'), '2026-10-28T01:00:00Z\t60\t3\tx\n');
});

test('a failed write of the tracker is silent, and the hook still exits 0 and prints nothing', () => {
  const home = tmp();
  mkdirSync(join(home, 'rate-limits.log'));
  assert.doesNotThrow(() => track(STATUS(10, 2, 'x'), home));
  const r = spawnSync(process.execPath, [join(KIRUNAK, 'hooks', 'statusline-track.mjs')],
    { input: JSON.stringify(STATUS(11, 2, 'x')), encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('Quad Damage\'s log is still found under bugs.limitsLog, the older name, once the workspace loads', async () => {
  const w = await makeWorkspace();
  const module = join(w.hub, 'kirunak', 'workspace-limits.mjs');
  writeFileSync(module, `export default {
  repos: [{ name: 'weather', root: '../../weather' }, { name: 'hub', root: '..' }],
  queue: './queue.md',
  plugins: ['./plugins/checklist.mjs'],
  bugs: { limitsLog: './state/limits.log' },
};
`);
  writeFileSync(join(w.home, 'workspace'), `${module}\n`);
  const ws = await loadWorkspace(join(w.home, 'workspace'));
  const reading = { week: { used: 41.7 }, fiveHour: { used: 12.2 } };
  assert.equal(logLimits(ws, reading, { label: 'quad-damage', now: new Date('2026-10-28T02:00:00Z') }), '2026-10-28T02:00:00Z\t41\t12\tquad-damage');
  assert.equal(readFileSync(join(w.hub, 'kirunak', 'state', 'limits.log'), 'utf8'), '2026-10-28T02:00:00Z\t41\t12\tquad-damage\n');
});

import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compactChecks } from '../lib/doctor.mjs';
import { configPath } from '../lib/install.mjs';
import { sh } from './helpers.mjs';
import { json, LOCAL, put, setup } from './fixtures/compact/install.mjs';

// k doctor's lines on the handover (orchestrator.md §5, R8.3), after k install into scratch repos.

const installed = (opts) => {
  const s = setup(opts);
  s.go();
  const check = ({ env = {}, cwd = s.hub } = {}) => compactChecks({ ws: s.ws, settingsPath: s.paths.settingsPath, env, cwd });
  const fails = (o) => check(o).filter(([ok]) => !ok).map(([, l]) => l);
  return { ...s, check, fails };
};

test('after k install every compact line is ok: the settings, the wiring, each root, the user\'s own window and here', () => {
  const s = installed();
  const user = s.paths.settingsPath;
  assert.deepEqual(s.check(), [
    [true, 'compact (kirunak\'s defaults): handover size 150000, window 183000, mid-step limit 167000 (a 200000 window)'],
    [true, 'compact hook: wired on PreCompact auto|manual, SessionEnd clear, SessionStart compact|clear (4 parts)'],
    [true, `weather: autoCompactWindow 183000 in ${s.local(s.weather)}, ignored by git`],
    [true, `hub: autoCompactWindow 183000 in ${s.local(s.hub)}, ignored by git`],
    [true, `${user}: autoCompactWindow 500000, yours (outside the workspace repos and in k run steps); kirunak never writes it`],
    [true, `${user}: modelSettings.opus.autoCompactWindow 400000, yours (for opus outside the workspace repos and in k run steps); kirunak never writes it`],
    [true, `here (${s.hub}): the handover window 183000 from ${s.local(s.hub)}`],
  ]);
});

test('a root not written, not ignored, the owner\'s, kirunak\'s earlier window, a committed window or a tracked file FAILs; the wiring too', () => {
  const s = installed();
  put(s.local(s.weather), {});
  writeFileSync(join(s.hub, '.git', 'info', 'exclude'), '');
  assert.deepEqual(s.fails(), [
    `weather: autoCompactWindow not set in ${s.local(s.weather)} (run k install)`,
    `hub: ${s.local(s.hub)} is not ignored by git (run k install)`,
  ]);
  put(s.local(s.weather), { autoCompactWindow: 300000 });
  const config = json(configPath(s.paths.home));
  writeFileSync(configPath(s.paths.home), JSON.stringify({ ...config, compact: { ...config.compact, window: 133000 } }));
  put(s.local(s.hub), { autoCompactWindow: 133000 });
  assert.deepEqual(s.fails(), [
    `weather: ${s.local(s.weather)}: autoCompactWindow is 300000, yours; kept. The handover window is 183000: set it there yourself, or remove the key and run k install again`,
    `hub: autoCompactWindow 133000 in ${s.local(s.hub)} is kirunak's earlier window (run k install)`,
  ]);
  put(s.local(s.weather), {});
  put(join(s.weather, '.claude', 'settings.json'), { autoCompactWindow: 250000 });
  sh(s.hub, 'git', ['add', '-f', join(...LOCAL)]);
  const settings = json(s.paths.settingsPath);
  delete settings.hooks.PreCompact;
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter((b) => !b.hooks[0].command.endsWith('--part task'));
  writeFileSync(s.paths.settingsPath, JSON.stringify(settings));
  assert.deepEqual(s.fails(), [
    'compact hook: not wired on PreCompact auto|manual, SessionStart compact|clear (run k install)',
    `weather: ${join(s.weather, '.claude', 'settings.json')} sets autoCompactWindow 250000 (the repo's own, committed); kept. For the handover set it to 183000 there, or put 183000 in ${s.local(s.weather)} yourself`,
    `hub: ${s.local(s.hub)} is tracked by git: a window there would be committed; untrack it (git rm --cached .claude/settings.local.json) or set 183000 in it yourself`,
  ]);
});

test('a compact hook block with a timeout other than kirunak\'s FAILs naming the event and both timeouts (gulnya/kirunak-install-hook-timeouts)', () => {
  const s = installed();
  const settings = json(s.paths.settingsPath);
  settings.hooks.SessionEnd[0].hooks[0].timeout = 1;
  settings.hooks.SessionStart.find((b) => b.hooks[0].command.endsWith('--part plan')).hooks[0].timeout = 30;
  writeFileSync(s.paths.settingsPath, JSON.stringify(settings));
  assert.deepEqual(s.fails(), ['compact hook: not wired on SessionEnd clear (timeout 1 s, kirunak\'s 5 s), SessionStart compact|clear (timeout 30 s, kirunak\'s 20 s) (run k install)']);
});

test('the default limit: a small user window passes, one under the limit\'s window noted; with \'user\' one not above the handover size FAILs; the variable and a per-model key FAIL', () => {
  const s = installed({ user: { autoCompactWindow: 100000, modelSettings: {} } });
  assert.deepEqual(s.fails(), [], 'a number is the limit: the user\'s window is not in force in a workspace repo');
  const noted = (x) => x.check().filter(([, l]) => l.startsWith('the user\'s own window'));
  assert.deepEqual(noted(s), [[true, 'the user\'s own window 100000 is under the mid-step limit\'s window 200000: in a workspace repo a step is compacted in its middle later than the window would elsewhere']]);
  const between = installed({ user: { autoCompactWindow: 250000, modelSettings: {} } });
  assert.deepEqual([between.fails(), noted(between)], [[], []], 'under 283000 and above the limit\'s window: nothing');
  const own = installed({ compact: { midStepLimit: 'user' }, user: { autoCompactWindow: 150000, modelSettings: {} } });
  assert.deepEqual(own.fails(), [`the user's own window 150000 is not above the handover size 150000: as the mid-step limit, a compaction in the middle of a step would never wait for the step boundary; set compact.midStepLimit to a number above 150000 in ${own.ws.modulePath}, or raise the window`]);
  assert.equal(own.check()[0][1], `compact (${own.ws.modulePath}): handover size 150000, window 183000, mid-step limit the user's own window: 150000 (autoCompactWindow in ${own.paths.settingsPath})`);
  assert.deepEqual(installed({ compact: { midStepLimit: 'user' }, user: { autoCompactWindow: 250000, modelSettings: {} } }).fails(), [], 'above the handover size passes');
  s.ws.compact = { ...s.ws.compact, midStepLimit: 400000 };
  assert.equal(s.check()[0][1], `compact (${s.ws.modulePath}): handover size 150000, window 183000, mid-step limit 400000 (a 433000 window)`);
  put(s.local(s.hub), { autoCompactWindow: 183000, modelSettings: { opus: { autoCompactWindow: 200000 } } });
  assert.deepEqual(s.fails({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000' } }), [
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000 in the shell beats every setting: the handover window is not in force while it is set',
    `hub: ${s.local(s.hub)}: modelSettings.opus.autoCompactWindow 200000 beats the handover window for opus; remove it, or set it to 183000`,
  ]);
  const none = installed({ compact: { midStepLimit: 'user' }, user: { autoCompactWindow: undefined, modelSettings: undefined } });
  assert.match(none.check()[0][1], /mid-step limit the user's own window: none set, the model's own window$/);
});

test('here: outside the roots the user\'s own window, under the variable its value, never blocking; the session\'s model and its window', () => {
  const s = installed();
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-compact-outside-')));
  const here = (o) => s.check(o).find(([, l]) => l.startsWith('here'));
  const never = 'not a workspace root\'s handover window, so the compact hook never blocks here';
  assert.deepEqual(here({ cwd: out }), [true, `here (${out}): the user's own window 500000 from ${s.paths.settingsPath}; ${never}`]);
  assert.deepEqual(here({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000' } }), [true, `here (${s.hub}): the window 800000 from CLAUDE_CODE_AUTO_COMPACT_WINDOW; ${never}`]);
  const sid = '5f0c9a1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
  put(join(s.paths.home, 'escalate', `${sid}.json`), { model: 'claude-opus-5-5' });
  const model = (o) => s.check(o).find(([, l]) => l.startsWith('compact hook on'));
  assert.deepEqual(model({ env: { CLAUDE_CODE_SESSION_ID: sid } }), [true, 'compact hook on claude-opus-5-5: window 1000000']);
  put(join(s.paths.home, 'escalate', `${sid}.json`), { model: 'claude-other-2' });
  assert.deepEqual(model({ env: { CLAUDE_CODE_SESSION_ID: sid } }), [false, 'compact hook on claude-other-2: claude-other-2 is not in the window table: the hook holds at most one request on it']);
  assert.equal(model(), undefined, 'no session, no line');
});

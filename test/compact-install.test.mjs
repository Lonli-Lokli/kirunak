import { strict as assert } from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { compactEvents, configPath, install } from '../lib/install.mjs';
import { KIRUNAK, sh } from './helpers.mjs';
import { json, LOCAL, put, read, setup } from './fixtures/compact/install.mjs';

// k install's compact part (orchestrator.md §5, R8.1, R8.2): the compact hook's blocks in the user's file, and the
// handover window in each root's own .claude/settings.local.json, in every case; the user's file never changes for it,
// and its own window is named on every run.

test('R8.1: the compact hook on PreCompact, SessionEnd and four SessionStart parts, each its own block; a second run adds none', () => {
  const s = setup();
  const hooks = json(s.paths.settingsPath).hooks;
  const command = (part) => `node ${join(KIRUNAK, 'hooks', 'kirunak-compact.mjs')}${part ? ` --part ${part}` : ''}`;
  assert.deepEqual(hooks.PreCompact, [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: command(), timeout: 10 }] }]);
  assert.deepEqual(hooks.SessionEnd, [{ matcher: 'clear', hooks: [{ type: 'command', command: command(), timeout: 5 }] }]);
  const parts = hooks.SessionStart.filter((b) => b.hooks[0].command.includes('kirunak-compact.mjs'));
  assert.deepEqual(parts, ['state', 'task', 'plan', 'progress'].map((p) => ({ matcher: 'compact|clear', hooks: [{ type: 'command', command: command(p), timeout: 20 }] })));
  const evs = compactEvents();
  for (const e of evs) assert.deepEqual(evs.filter((x) => x.own.test(command(e.part))).map((x) => x.part), e.part ? [e.part] : [null, null], 'one pattern per part');
  const actions = s.go();
  assert.equal(actions.filter((a) => /already has the kirunak (PreCompact|SessionEnd|SessionStart) hook/.test(a)).length, 8, 'the six, the escalation hook\'s and the session hook\'s');
  const user = json(s.paths.settingsPath);
  user.hooks.SessionStart.find((b) => b.hooks[0].command.endsWith('--part plan')).hooks[0].command = 'node /old/kirunak/hooks/kirunak-compact.mjs --part plan';
  writeFileSync(s.paths.settingsPath, JSON.stringify(user, null, 2) + '\n');
  const again = install({ ...s.paths, ws: s.ws });
  assert.ok(again.actions.includes(`updated the kirunak SessionStart hook in ${s.paths.settingsPath} to ${command('plan')} (matcher compact|clear)`));
  assert.equal(json(s.paths.settingsPath).hooks.SessionStart.length, 6, 'pointed here, never added twice');
});

test('a: the window written into each root\'s local file, its keys and indent kept, the not-ignored root given the exclude line once; b: already; the user\'s own window named, kept', () => {
  const s = setup();
  put(s.local(s.hub), '{\n    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    }\n}\n');
  writeFileSync(join(s.weather, '.gitignore'), '.claude/settings.local.json\n');
  const actions = s.go();
  assert.ok(actions.includes(`set autoCompactWindow 183000 in ${s.local(s.weather)} (handover size 150000 + 33000); ignored by git`));
  assert.ok(actions.includes(`set autoCompactWindow 183000 in ${s.local(s.hub)} (handover size 150000 + 33000)`));
  assert.ok(actions.includes(`added /.claude/settings.local.json to ${join(s.hub, '.git', 'info', 'exclude')} (or put it in the repo's .gitignore yourself)`));
  assert.deepEqual(json(s.local(s.weather)), { autoCompactWindow: 183000 }, 'the .claude folder made');
  assert.equal(read(s.local(s.hub)), '{\n    "permissions": {\n        "allow": [\n            "Bash(ls:*)"\n        ]\n    },\n    "autoCompactWindow": 183000\n}\n');
  const exclude = read(join(s.hub, '.git', 'info', 'exclude'));
  assert.ok(exclude.endsWith('\n/.claude/settings.local.json\n'));
  const again = s.go();
  assert.ok(again.includes(`${s.local(s.hub)}: autoCompactWindow is already 183000; ignored by git`));
  assert.equal(read(join(s.hub, '.git', 'info', 'exclude')), exclude, 'appended once');
  const yours = [
    `${s.paths.settingsPath}: autoCompactWindow 500000, yours (the mid-step limit); kirunak never writes it`,
    `${s.paths.settingsPath}: modelSettings.opus.autoCompactWindow 400000, yours (the mid-step limit for opus); kirunak never writes it`,
  ];
  const aboutUser = (list) => list.filter((a) => a.includes(s.paths.settingsPath) && a.includes('autoCompactWindow'));
  assert.deepEqual(aboutUser(actions), yours, 'the user\'s own window and its per-model value named, and nothing else of the window in their file');
  assert.deepEqual(aboutUser(again), yours, 'named on every run');
});

test('c: kirunak\'s earlier window replaced once config.json carried it; d: the owner\'s own kept and named; f: a per-model window named', () => {
  const s = setup();
  s.go();
  const config = json(configPath(s.paths.home));
  writeFileSync(configPath(s.paths.home), JSON.stringify({ ...config, compact: { ...config.compact, window: 133000 } }));
  put(s.local(s.weather), { autoCompactWindow: 133000 });
  put(s.local(s.hub), { autoCompactWindow: 300000, modelSettings: { haiku: { autoCompactWindow: 120000 } } });
  const hubBytes = read(s.local(s.hub));
  const actions = s.go();
  assert.ok(actions.includes(`replaced autoCompactWindow 133000 with 183000 in ${s.local(s.weather)} (kirunak's own, the handover size changed); ignored by git`));
  assert.equal(json(s.local(s.weather)).autoCompactWindow, 183000);
  assert.ok(actions.includes(`${s.local(s.hub)}: autoCompactWindow is 300000, yours; kept. The handover window is 183000: set it there yourself, or remove the key and run k install again; ignored by git`));
  assert.ok(actions.includes(`${s.local(s.hub)}: modelSettings.haiku.autoCompactWindow 120000 beats the handover window for haiku; remove it, or set it to 183000`));
  assert.equal(read(s.local(s.hub)), hubBytes, 'the owner\'s file untouched');
  put(s.local(s.hub), { modelSettings: { haiku: { autoCompactWindow: 120000 } } });
  assert.ok(s.go().some((a) => a.startsWith(`set autoCompactWindow 183000 in ${s.local(s.hub)}`)), 'the top-level still written beside a per-model key');
});

test('e: a window in the repo\'s committed settings.json is kept and named, nothing written; g: the variable named wherever it is set', () => {
  const s = setup({ user: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' } } });
  put(join(s.weather, '.claude', 'settings.json'), { autoCompactWindow: 250000 });
  put(join(s.hub, '.claude', 'settings.json'), { modelSettings: { opus: { autoCompactWindow: 260000 } } });
  put(s.local(s.hub), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' }, autoCompactWindow: 183000 });
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '800000';
  let actions;
  try {
    actions = s.go();
  } finally {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
  const shared = join(s.weather, '.claude', 'settings.json');
  assert.ok(actions.includes(`${shared} sets autoCompactWindow 250000 (the repo's own, committed); kept. For the handover set it to 183000 there, or put 183000 in ${s.local(s.weather)} yourself`));
  assert.ok(!existsSync(s.local(s.weather)), 'nothing written');
  const tail = 'beats every setting: the handover window is not in force while it is set';
  assert.ok(actions.includes(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000 in the shell ${tail}`));
  assert.ok(actions.includes(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000 in ${s.paths.settingsPath} env ${tail}`));
  assert.ok(actions.includes(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000 in ${s.local(s.hub)} env ${tail}`));
  assert.ok(actions.some((a) => a.startsWith(`${s.local(s.hub)}: autoCompactWindow is already 183000`)), 'a local window beats the shared per-model one');
});

test('compact.enabled false removes kirunak\'s own window and keeps the owner\'s; a tracked file and one not JSON are named, the others still written', () => {
  const s = setup();
  s.go();
  put(s.local(s.hub), { autoCompactWindow: 300000 });
  s.ws.compact = { ...s.ws.compact, enabled: false };
  const off = s.go();
  assert.ok(off.includes(`removed autoCompactWindow 183000 from ${s.local(s.weather)} (compact.enabled: false)`));
  assert.deepEqual(json(s.local(s.weather)), {});
  assert.ok(off.includes(`${s.local(s.hub)}: autoCompactWindow is 300000, yours; kept (compact.enabled: false)`));
  s.ws.compact = { ...s.ws.compact, enabled: true };
  put(s.local(s.weather), { autoCompactWindow: 190000 });
  sh(s.weather, 'git', ['add', '-f', join(...LOCAL)]);
  sh(s.weather, 'git', ['commit', '-q', '-m', 'local settings']);
  put(s.local(s.hub), '{ nope');
  const actions = s.go();
  assert.ok(actions.includes(`${s.local(s.weather)} is tracked by git: a window there would be committed; untrack it (git rm --cached .claude/settings.local.json) or set 183000 in it yourself`));
  assert.ok(actions.some((a) => a.startsWith(`${s.local(s.hub)} is not a JSON object (`) && a.endsWith('): fix it; the window was not written')));
  assert.deepEqual(json(s.local(s.weather)), { autoCompactWindow: 190000 });
  assert.equal(read(s.local(s.hub)), '{ nope');
});

test('a root that is a worktree is written at its main checkout\'s file; --print writes no window and no exclude line', () => {
  const s = setup();
  const wt = join(s.dir, 'hub-wt');
  sh(s.hub, 'git', ['worktree', 'add', '-q', '-b', 'side', wt]);
  s.ws.repos = [{ name: 'side', root: wt }];
  const exclude = read(join(s.hub, '.git', 'info', 'exclude'));
  const printed = s.go({ print: true });
  assert.ok(printed.includes(`${wt} is a worktree: sessions there read ${s.local(s.hub)}`));
  assert.ok(printed.includes(`would set autoCompactWindow 183000 in ${s.local(s.hub)} (handover size 150000 + 33000)`));
  assert.ok(printed.some((a) => a.startsWith('would add /.claude/settings.local.json to ')));
  assert.ok(printed.includes(`${s.paths.settingsPath}: autoCompactWindow 500000, yours (the mid-step limit); kirunak never writes it`));
  assert.ok(printed.includes(`${s.paths.settingsPath}: modelSettings.opus.autoCompactWindow 400000, yours (the mid-step limit for opus); kirunak never writes it`), '--print names the user\'s window as a run does');
  assert.ok(!existsSync(s.local(s.hub)) && !existsSync(join(wt, ...LOCAL)), 'nothing written');
  assert.equal(read(join(s.hub, '.git', 'info', 'exclude')), exclude);
  s.go();
  assert.deepEqual(json(s.local(s.hub)), { autoCompactWindow: 183000 });
  assert.ok(!existsSync(join(wt, ...LOCAL)), 'the worktree reads the main checkout\'s');
  assert.deepEqual(json(configPath(s.paths.home)).compact.roots, [s.hub]);
});

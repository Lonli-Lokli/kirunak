import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bugsHookLine, frontmatter, ladderChecks, trackerLine } from '../lib/doctor.mjs';
import { install } from '../lib/install.mjs';
import { k, KIRUNAK, ladderWorkspace } from './helpers.mjs';

// design/plugins.md §3: k doctor's lines on the ladder, its agents, settings.json's
// modelSettings, the escalation hook's wiring, its config.json and its switches.

// A workspace with the given keys, k installed for it into temp settings and agents folders, push to the phone on as
// /config turns it on.
async function installed(extra = {}) {
  const w = await ladderWorkspace(extra);
  const paths = { settingsPath: join(w.dir, 'settings.json'), agentsDir: join(w.dir, 'agents'), skillsDir: join(w.dir, 'skills') };
  install({ ...paths, kirunakRoot: KIRUNAK, home: w.home, ws: w.ws });
  writeFileSync(paths.settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(paths.settingsPath, 'utf8')), agentPushNotifEnabled: true }, null, 2));
  const check = (ws = w.ws) => ladderChecks({ ws, settingsPath: paths.settingsPath, agentsDir: paths.agentsDir });
  const fails = (ws) => check(ws).filter(([ok]) => !ok).map(([, line]) => line);
  const settings = (change) => {
    const json = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    change(json);
    writeFileSync(paths.settingsPath, JSON.stringify(json, null, 2));
  };
  return { ...w, ...paths, check, fails, settings };
}

test('after k install every ladder line is ok, the ladder first', async () => {
  const w = await installed();
  const lines = w.check();
  assert.deepEqual(lines.filter(([ok]) => !ok), []);
  assert.deepEqual(lines.map(([, l]) => l), [
    'ladder: sonnet → opus (high, build) → fable (high, design)',
    `rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')}, opus, high`,
    `rung agent fable-step: ${join(w.agentsDir, 'fable-step.md')}, fable, high`,
    'escalation hook: wired on 8 events',
    'escalate/config.json matches the workspace',
    `push to the phone: on (agentPushNotifEnabled in ${w.settingsPath})`,
  ]);
});

test('push to the phone FAILs when settings.json does not set agentPushNotifEnabled true, naming /config from the phone or the terminal (E-16, A-1)', async () => {
  const w = await installed();
  const off = `push to the phone: off, agentPushNotifEnabled is not true in ${w.settingsPath}: type /config agentPushNotifEnabled=true in a session, on the phone or in the terminal`;
  for (const value of [false, 'true', undefined]) {
    w.settings((json) => {
      if (value === undefined) delete json.agentPushNotifEnabled;
      else json.agentPushNotifEnabled = value;
    });
    assert.deepEqual(w.fails(), [off], String(value));
  }
  rmSync(w.settingsPath);
  assert.ok(w.fails().includes(off), 'no settings.json');
  writeFileSync(w.settingsPath, JSON.stringify({ agentPushNotifEnabled: true }));
  assert.ok(w.check().some(([ok, l]) => ok && l.startsWith('push to the phone: on')));
});

test('a rung agent missing, of another family or at another effort FAILs, naming k install', async () => {
  const w = await installed();
  rmSync(join(w.agentsDir, 'opus-step.md'));
  const fable = join(w.agentsDir, 'fable-step.md');
  writeFileSync(fable, readFileSync(fable, 'utf8').replace('effort: high', 'effort: xhigh'));
  assert.deepEqual(w.fails(), [
    `rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')} is missing (run k install)`,
    `rung agent fable-step: ${fable}, fable, xhigh: the ladder says high (run k install)`,
  ]);
  writeFileSync(fable, readFileSync(fable, 'utf8').replace('model: fable', 'model: claude-opus-5-5'));
  assert.ok(w.fails().includes(`rung agent fable-step: ${fable}, claude-opus-5-5, xhigh: its model is not of the fable family (run k install)`));
});

test('the workspace\'s own agents on a rung are checked the same, through a link, and fixed by hand', async () => {
  const ladder = [{ model: 'sonnet' }, { model: 'opus', effort: 'high' }, { model: 'fable', id: 'claude-fable-5-1', effort: 'high', mode: 'design', agents: ['domain-deep'] }];
  const w = await installed({ ladder });
  const path = join(w.agentsDir, 'domain-deep.md');
  assert.ok(w.fails().includes(`rung agent domain-deep (the workspace's own): ${path} is missing (write it, or take it off the fable rung's agents)`));
  const repo = join(w.dir, 'portfolio');
  mkdirSync(repo);
  writeFileSync(join(repo, 'domain-deep.md'), '---\nname: domain-deep\nmodel: claude-fable-5-1\neffort: xhigh\ntools: "*"\n---\nDomain.\n');
  symlinkSync(join(repo, 'domain-deep.md'), path);
  const real = realpathSync(path);
  assert.deepEqual(w.fails(), [`rung agent domain-deep (the workspace's own): ${path} → ${real}, claude-fable-5-1, xhigh: the ladder says high (set it in ${real})`]);
  writeFileSync(real, readFileSync(real, 'utf8').replace('xhigh', 'high'));
  assert.deepEqual(w.fails(), []);
  assert.ok(w.check().some(([ok, l]) => ok && l === `rung agent fable-step: ${join(w.agentsDir, 'fable-step.md')}, claude-fable-5-1, high`));
});

test('modelSettings: Opus at xhigh disagrees with the rung at high, and any effort for Fable FAILs (AC-19, AC-20)', async () => {
  const w = await installed();
  w.settings((json) => {
    json.modelSettings = { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'high' } };
  });
  assert.deepEqual(w.fails(), [
    'settings.json modelSettings claude-opus-5-5: effortLevel xhigh disagrees with the opus rung (high): remove it, or set the rung\'s effort to xhigh',
    'settings.json modelSettings claude-fable-5-1: effortLevel high, but settings name no effort for fable: remove it',
  ]);
});

test('modelSettings: an entry at the rung\'s effort is ok; one of no rung\'s family, or naming no effort, says nothing', async () => {
  const w = await installed();
  w.settings((json) => {
    json.modelSettings = { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-haiku-4-5': { effortLevel: 'low' }, 'claude-fable-5-1': {} };
  });
  const lines = w.check().filter(([, l]) => l.startsWith('settings.json'));
  assert.deepEqual(lines, [[true, 'settings.json modelSettings claude-opus-5-5: effortLevel high, as the opus rung']]);
});

test('the escalation hook not wired, or wired as before the agent records (the rung agents\' matcher, no Stop), FAILs naming the events', async () => {
  const w = await installed();
  const was = readFileSync(w.settingsPath, 'utf8');
  w.settings((json) => {
    delete json.hooks.UserPromptExpansion;
    delete json.hooks.PostModelSwitch;
  });
  assert.deepEqual(w.fails(), ['escalation hook: not wired on UserPromptExpansion, PostModelSwitch (run k install)']);
  writeFileSync(w.settingsPath, was);
  const { ws } = await ladderWorkspace({ ladder: [{ model: 'sonnet' }, { model: 'opus', effort: 'high' }] });
  ws.home = w.home;
  assert.ok(!w.fails(ws).some((l) => l.startsWith('escalation hook')), 'the matchers are the same for every ladder');
  w.settings((json) => {
    json.hooks.SubagentStop.find((b) => b.matcher === '.+').matcher = 'opus-step|fable-step';
    delete json.hooks.Stop;
  });
  assert.deepEqual(w.fails().filter((l) => l.startsWith('escalation hook')), ['escalation hook: not wired on SubagentStop (matcher opus-step|fable-step, kirunak\'s .+), Stop (run k install)']);
  writeFileSync(w.settingsPath, '{}');
  assert.match(w.fails().find((l) => l.startsWith('escalation hook')), /not wired on PostToolUseFailure, PostToolUse, SubagentStop, UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch, Stop \(/);
});

test('config.json missing, disagreeing with the workspace, or older than its module FAILs', async () => {
  const w = await installed();
  const path = join(w.home, 'escalate', 'config.json');
  const was = readFileSync(path, 'utf8');
  const line = (ws) => w.check(ws).find(([, l]) => l.startsWith('escalate/config.json'));
  rmSync(path);
  assert.deepEqual(line(), [false, `escalate/config.json: ${path} is missing or not JSON (run k install)`]);
  writeFileSync(path, was.replace('"repeats": 2', '"repeats": 3'));
  assert.deepEqual(line(), [false, 'escalate/config.json disagrees with the workspace (run k install)']);
  writeFileSync(path, was);
  const later = new Date(Date.now() + 60_000);
  utimesSync(w.modulePath, later, later);
  assert.deepEqual(line(), [false, `escalate/config.json is older than ${w.modulePath} (run k install)`]);
});

test('the hook off and the block off are FAIL lines, so k doctor says when either is off (AC-29)', async () => {
  const w = await installed({ hook: { enabled: false, block: false } });
  assert.deepEqual(w.fails(), [`hook off (hook.enabled: false in ${w.modulePath})`, `block off (hook.block: false in ${w.modulePath})`]);
});

test('a workspace still naming models.escalate gets the FAIL line of R1.4', async () => {
  const w = await installed({ models: { escalate: { model: 'fable', effort: 'xhigh' } } });
  assert.deepEqual(w.fails(), [`models.escalate is no longer read: the ladder's rungs replace it; remove it from ${w.modulePath}`]);
});

test('frontmatter reads the key: value lines, quotes off, and nothing past the closing line', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "x: y"\nmodel: claude-opus-5-5\nexperimental:\n  cacheTtl: 1h\n---\nmodel: no\n'),
    { name: 'a', description: 'x: y', model: 'claude-opus-5-5' });
  assert.deepEqual(frontmatter('no front matter\n'), {});
});

test('k doctor --settings --agents prints the ladder lines', async () => {
  const w = await installed({ models: { escalate: { model: 'fable' } } });
  writeFileSync(join(w.home, 'workspace'), w.modulePath + '\n');
  const r = k(w.home, ['doctor', '--settings', w.settingsPath, '--agents', w.agentsDir]);
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /^ok {3}ladder: sonnet → opus \(high, build\) → fable \(high, design\)$/m);
  assert.ok(out.includes(`ok   rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')}, opus, high`));
  assert.match(out, /^ok {3}escalation hook: wired on 8 events$/m);
  assert.match(out, /^ok {3}hook kirunak-escalate\.mjs$/m);
  assert.match(out, /^FAIL models\.escalate is no longer read/m);
  assert.match(out, /^ok {3}push to the phone: on \(agentPushNotifEnabled in .*settings\.json\)$/m);
  assert.match(out, /^WARN status line tracker: no statusLine command in .*settings\.json, so sessions' cost is not tracked/m);
  assert.match(out, /^ok {3}bugs' notice: wired on SessionStart startup\|clear$/m);
  assert.match(out, /^ok {3}hook kirunak-bugs\.mjs$/m);
});

test('the bugs\' notice is ok after k install, and FAILs naming k install when it is not wired or wired with another matcher (gulnya/kirunak-bugs AC-7)', async () => {
  const w = await installed();
  const check = () => bugsHookLine({ settingsPath: w.settingsPath });
  assert.deepEqual(check(), [true, "bugs' notice: wired on SessionStart startup|clear"]);
  const ours = (json) => json.hooks.SessionStart.find((b) => b.hooks[0].command.endsWith('hooks/kirunak-bugs.mjs'));
  w.settings((json) => { ours(json).matcher = 'startup|resume|clear'; });
  assert.deepEqual(check(), [false, "bugs' notice: wired on SessionStart with matcher startup|resume|clear, kirunak's startup|clear (run k install)"]);
  w.settings((json) => { delete ours(json).matcher; });
  assert.deepEqual(check(), [false, "bugs' notice: wired on SessionStart with matcher none, kirunak's startup|clear (run k install)"]);
  w.settings((json) => { json.hooks.SessionStart = json.hooks.SessionStart.filter((b) => !b.hooks[0].command.endsWith('hooks/kirunak-bugs.mjs')); });
  assert.deepEqual(check(), [false, `bugs' notice: not wired on SessionStart in ${w.settingsPath} (run k install)`]);
  writeFileSync(w.settingsPath, 'not json');
  assert.equal(check()[0], false, 'a settings file it cannot read');
});

test('the status line tracker is a WARN naming the line to add until statusLine, or a script it names, runs it (cost-untracked-sessions AC-3)', async () => {
  const w = await installed();
  const check = () => trackerLine({ settingsPath: w.settingsPath, kirunakRoot: KIRUNAK, home: w.dir });
  const add = `add this line to the status line command, fed the same JSON on stdin, with "refreshInterval": 30: node ${join(KIRUNAK, 'hooks', 'statusline-track.mjs')}`;
  assert.deepEqual(check(), ['warn', `status line tracker: no statusLine command in ${w.settingsPath}, so sessions' cost is not tracked and the cache keeper cannot see them: ${add}`]);
  // A script of the user's, named from the home folder, that prints a status line without the tracker.
  const script = join(w.dir, 'statusline.sh');
  writeFileSync(script, '#!/usr/bin/env bash\necho status\n');
  w.settings((s) => { s.statusLine = { type: 'command', command: '~/statusline.sh', refreshInterval: 30 }; });
  assert.deepEqual(check(), ['warn', `status line tracker: statusLine in ${w.settingsPath} and ${script} do not run it, so sessions' cost is not tracked and the cache keeper cannot see them: ${add}`]);
  writeFileSync(script, `#!/usr/bin/env bash\ninput=$(cat)\nprintf '%s' "$input" | node ${join(KIRUNAK, 'hooks', 'statusline-track.mjs')}\necho status\n`);
  assert.deepEqual(check(), [true, `status line tracker: run by ${script}`]);
  w.settings((s) => { s.statusLine.command = `bash -c 'node ${join(KIRUNAK, 'hooks', 'statusline-track.mjs')}'`; });
  assert.deepEqual(check(), [true, `status line tracker: run by statusLine in ${w.settingsPath}`]);
});

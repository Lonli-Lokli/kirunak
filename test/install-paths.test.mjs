import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bugsHookLine, compactChecks, ladderChecks, unlockHookLine } from '../lib/doctor.mjs';
import { install, SKILLS } from '../lib/install.mjs';
import { k, ladderWorkspace } from './helpers.mjs';

// kirunak's own hooks whatever separator the OS wrote (bug asilak/kirunak-install-hook-paths-windows): k install on
// win32 writes `node "D:\\sources\\kirunak\\hooks\\kirunak-x.mjs"`, its backslashes doubled inside the quotes, and
// k install and k doctor must read those commands as kirunak's, fold the copies an earlier install added, and leave
// another tool's hook whose path merely ends the same way alone.

const WIN = 'D:\\sources\\kirunak';
// The command k install writes on win32 for the hook `name`: quoted, each backslash doubled.
const win = (name) => `node "${[...WIN.split('\\'), 'hooks', name].join('\\\\')}"`;

const OTHERS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:\\tools\\guard.mjs', timeout: 5 }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
};

// A workspace and a settings file holding another tool's hooks; `fixture` is that file after k install on win32, made
// here from this machine's install by rewriting each kirunak command as win32 writes it, so it does not depend on the
// fix it tests.
async function windows() {
  const w = await ladderWorkspace();
  const root = join(w.dir, 'kirunak');
  for (const s of SKILLS) mkdirSync(join(root, 'skills', s), { recursive: true });
  const paths = { settingsPath: join(w.dir, 'settings.json'), agentsDir: join(w.dir, 'agents'), skillsDir: join(w.dir, 'skills') };
  const put = (json) => writeFileSync(paths.settingsPath, JSON.stringify(json, null, 2) + '\n');
  const read = () => JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
  put({ hooks: structuredClone(OTHERS) });
  install({ ...paths, kirunakRoot: root, home: w.home, ws: w.ws });
  const here = `node ${join(root, 'hooks')}/`;
  const fixture = read();
  for (const h of Object.values(fixture.hooks).flat().flatMap((b) => b.hooks)) {
    if (!h.command.startsWith(here)) continue;
    const [name, ...rest] = h.command.slice(here.length).split(' ');
    h.command = [win(name), ...rest].join(' ');
  }
  return { ...w, ...paths, root, put, read, fixture };
}

test('the fixture is what k install writes on win32: each kirunak command quoted, its backslashes doubled', async () => {
  const w = await windows();
  const all = Object.values(w.fixture.hooks).flat().flatMap((b) => b.hooks.map((h) => h.command));
  const ours = all.filter((c) => c.includes('kirunak-'));
  assert.equal(ours.length, 19, 'freeze, session, bugs, 8 escalation, stale, 6 compact, unlock');
  for (const c of ours) assert.match(c, /^node "D:\\\\sources\\\\kirunak\\\\hooks\\\\kirunak-[\w-]+\.mjs"( --part \w+)?$/, c);
  assert.ok(ours.includes(win('kirunak-escalate.mjs')) && ours.includes(`${win('kirunak-compact.mjs')} --part plan`));
  const fresh = join(w.dir, 'fresh.json');
  writeFileSync(fresh, JSON.stringify({ hooks: structuredClone(OTHERS) }));
  install({ settingsPath: fresh, agentsDir: w.agentsDir, skillsDir: join(w.dir, 'win-skills'), kirunakRoot: WIN, platform: 'win32', home: w.home, ws: w.ws });
  assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')), w.fixture, 'k install on win32 writes the fixture');
});

test('k doctor reads every kirunak hook of a win32 settings file as wired, and forward slashes, single backslashes or both as well', async () => {
  const w = await windows();
  w.put({ ...w.fixture, agentPushNotifEnabled: true });
  const line = (lines, head) => lines.find(([, l]) => l.startsWith(head));
  const check = () => ({
    escalation: line(ladderChecks({ ws: w.ws, settingsPath: w.settingsPath, agentsDir: w.agentsDir }), 'escalation hook:'),
    compact: line(compactChecks({ ws: w.ws, settingsPath: w.settingsPath, env: {}, cwd: w.dir }), 'compact hook:'),
    bugs: bugsHookLine(w),
    unlock: unlockHookLine(w),
  });
  const wired = {
    escalation: [true, 'escalation hook: wired on 8 events'],
    compact: [true, 'compact hook: wired on PreCompact auto|manual, SessionEnd clear, SessionStart compact|clear (4 parts)'],
    bugs: [true, "bugs' notice: wired on SessionStart startup|clear"],
    unlock: [true, 'worktree lock release: wired on SessionEnd, every end'],
  };
  assert.deepEqual(check(), wired);
  const json = w.read();
  const set = (event, from, to) => {
    const h = json.hooks[event].flatMap((b) => b.hooks).find((x) => x.command === from);
    h.command = to;
  };
  set('PostToolUse', win('kirunak-escalate.mjs'), 'node /old/place/kirunak/hooks/kirunak-escalate.mjs');
  set('SubagentStop', win('kirunak-escalate.mjs'), 'node D:\\sources\\kirunak\\hooks\\kirunak-escalate.mjs');
  set('Stop', win('kirunak-escalate.mjs'), 'node "D:/sources/kirunak/hooks\\kirunak-escalate.mjs"');
  set('SessionEnd', win('kirunak-unlock.mjs'), "node 'D:\\sources\\kirunak\\hooks\\kirunak-unlock.mjs'");
  set('SessionStart', `${win('kirunak-compact.mjs')} --part plan`, 'node D:\\sources\\kirunak\\hooks\\kirunak-compact.mjs --part plan');
  w.put(json);
  assert.deepEqual(check(), wired);
  writeFileSync(join(w.home, 'workspace'), w.modulePath + '\n');
  const r = k(w.home, ['doctor', '--settings', w.settingsPath, '--agents', w.agentsDir]);
  const text = r.stdout + r.stderr;
  assert.ok(text.includes(`ok   the freeze hook is wired in ${w.settingsPath}`), text);
  assert.match(text, /^ok {3}escalation hook: wired on 8 events$/m);
  assert.match(text, /^ok {3}kirunak's hooks: one copy of each in /m);
});

test('a second k install on win32 plans nothing, and one from this machine points each block here without adding one', async () => {
  const w = await windows();
  w.put(w.fixture);
  const winPaths = { settingsPath: w.settingsPath, agentsDir: w.agentsDir, skillsDir: join(w.dir, 'win-skills'), home: w.home, ws: w.ws };
  const { actions } = install({ ...winPaths, kirunakRoot: WIN, platform: 'win32', print: true });
  const settingsLines = actions.filter((a) => a.includes(`${w.settingsPath} hooks.`));
  assert.deepEqual(settingsLines, [], 'nothing to add or set');
  assert.equal(actions.filter((a) => a.includes(`${w.settingsPath} already has the kirunak`)).length, 19);
  const bytes = readFileSync(w.settingsPath);
  const mtime = statSync(w.settingsPath).mtimeMs;
  install({ ...winPaths, kirunakRoot: WIN, platform: 'win32' });
  assert.ok(readFileSync(w.settingsPath).equals(bytes), 'byte-identical');
  assert.equal(statSync(w.settingsPath).mtimeMs, mtime, 'not rewritten');
  install({ settingsPath: w.settingsPath, agentsDir: w.agentsDir, skillsDir: w.skillsDir, kirunakRoot: w.root, home: w.home, ws: w.ws });
  const after = w.read().hooks;
  for (const [event, list] of Object.entries(w.fixture.hooks)) assert.equal(after[event].length, list.length, `${event}: no block added`);
  assert.deepEqual(after.PreToolUse[0], OTHERS.PreToolUse[0]);
  assert.equal(after.PreToolUse[1].hooks[0].command, `node ${join(w.root, 'hooks', 'kirunak-freeze.mjs')}`);
});

test('k install folds each kirunak block an earlier install added twice down to one; another tool\'s hooks stay as they were', async () => {
  const w = await windows();
  const doubled = structuredClone(w.fixture);
  const keep = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:\\tools\\after.mjs' }] };
  for (const [event, list] of Object.entries(doubled.hooks)) {
    const ours = list.filter((b) => b.hooks[0].command.includes('kirunak-'));
    list.push(...(event === 'PreToolUse' ? [keep] : []), ...structuredClone(ours));
  }
  // A block holding another tool's hook beside a copy of ours: the copy goes, the other hook stays.
  doubled.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'node C:\\tools\\prompt.mjs' }, { type: 'command', command: win('kirunak-stale.mjs'), timeout: 10 }] });
  w.put(doubled);
  const winPaths = { settingsPath: w.settingsPath, agentsDir: w.agentsDir, skillsDir: join(w.dir, 'win-skills'), home: w.home, ws: w.ws };
  const { actions } = install({ ...winPaths, kirunakRoot: WIN, platform: 'win32' });
  const expected = structuredClone(w.fixture);
  expected.hooks.PreToolUse.push(keep);
  expected.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'node C:\\tools\\prompt.mjs' }] });
  assert.deepEqual(w.read(), expected);
  assert.ok(actions.includes(`folded 2 copies of the kirunak UserPromptSubmit hook in ${w.settingsPath} into one`), actions.join('\n'));
  assert.ok(actions.includes(`folded 3 copies of the kirunak UserPromptSubmit hook in ${w.settingsPath} into one`), 'the stale hook\'s');
  assert.ok(actions.includes(`folded 2 copies of the kirunak PreToolUse hook in ${w.settingsPath} into one`), actions.join('\n'));
  const r = install({ ...winPaths, kirunakRoot: WIN, platform: 'win32', print: true });
  assert.deepEqual(r.actions.filter((a) => a.includes(`${w.settingsPath} hooks.`)), [], 'folded once, then nothing to do');
});

test('k doctor names a kirunak hook wired twice, which k install folds', async () => {
  const w = await windows();
  const doubled = structuredClone(w.fixture);
  doubled.hooks.SessionEnd.push(...structuredClone(doubled.hooks.SessionEnd));
  doubled.hooks.Stop.push(structuredClone(doubled.hooks.Stop[0]));
  w.put(doubled);
  writeFileSync(join(w.home, 'workspace'), w.modulePath + '\n');
  const r = k(w.home, ['doctor', '--settings', w.settingsPath, '--agents', w.agentsDir]);
  const text = r.stdout + r.stderr;
  assert.match(text, /^FAIL kirunak's hooks: kirunak-escalate\.mjs 2 times on Stop, kirunak-compact\.mjs 2 times on SessionEnd, kirunak-unlock\.mjs 2 times on SessionEnd in .*settings\.json \(run k install, which folds them to one\)$/m, text);
});

test('another tool\'s hook whose path merely ends like kirunak\'s, outside a hooks folder or without the kirunak- prefix, is never taken for kirunak\'s', async () => {
  const w = await windows();
  const lookalikes = {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:\\\\tools\\\\myhooks\\\\kirunak-freeze.mjs"', timeout: 5 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'node /opt/other/prehooks/kirunak-unlock.mjs', timeout: 5 }] }],
    SessionStart: [{ matcher: 'startup|clear', hooks: [{ type: 'command', command: 'node C:\\tools\\hooks\\my-kirunak-bugs.mjs', timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node C:\\tools\\hooks\\kirunak-escalate.mjs.bak', timeout: 10 }] }],
  };
  w.put({ hooks: structuredClone(lookalikes) });
  assert.equal(unlockHookLine(w)[0], false, 'prehooks/ is not kirunak\'s hooks folder');
  assert.equal(bugsHookLine(w)[0], false, 'my-kirunak-bugs.mjs is not kirunak\'s');
  install({ settingsPath: w.settingsPath, agentsDir: w.agentsDir, skillsDir: join(w.dir, 'win-skills'), kirunakRoot: WIN, platform: 'win32', home: w.home, ws: w.ws });
  const after = w.read().hooks;
  for (const [event, list] of Object.entries(lookalikes)) assert.deepEqual(after[event][0], list[0], `${event}: the other tool's block as it was`);
  assert.deepEqual(after.PreToolUse.map((b) => b.hooks[0].command), [lookalikes.PreToolUse[0].hooks[0].command, win('kirunak-freeze.mjs')]);
  assert.ok(after.SessionEnd.some((b) => b.hooks[0].command === win('kirunak-unlock.mjs')), 'kirunak\'s own beside it');
  assert.ok(after.SessionStart.some((b) => b.hooks[0].command === win('kirunak-bugs.mjs')));
  assert.deepEqual(unlockHookLine(w), [true, 'worktree lock release: wired on SessionEnd, every end']);
});

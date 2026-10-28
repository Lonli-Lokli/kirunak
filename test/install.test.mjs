import { strict as assert } from 'node:assert';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { BUGS_MATCHER, FREEZE_MATCHER, install, MARKER, SKILLS } from '../lib/install.mjs';
import { DEFAULT_HOOK } from '../lib/ladder.mjs';
import { gitInit, KIRUNAK } from './helpers.mjs';

// A temp home: a settings file with someone else's hooks, an empty skills folder, a kirunak checkout.
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-install-'));
  const kirunakRoot = join(dir, 'kirunak');
  for (const s of SKILLS) mkdirSync(join(kirunakRoot, 'skills', s), { recursive: true });
  const settingsPath = join(dir, '.claude', 'settings.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const settings = {
    model: 'sonnet',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/other/guard.mjs', timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { dir, kirunakRoot, settingsPath, skillsDir: join(dir, '.claude', 'skills'), agentsDir: join(dir, '.claude', 'agents'), settings, home: join(dir, 'state') };
}

const repo = (dir, name) => {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  gitInit(r);
  return r;
};

test('the block is written with the absolute path, and every other hook and key is kept', () => {
  const h = home();
  const { actions } = install(h);
  const text = readFileSync(h.settingsPath, 'utf8');
  assert.ok(!text.includes('<kirunak>'));
  const json = JSON.parse(text);
  assert.deepEqual(json.hooks.PreToolUse[1], {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Monitor|Skill|CronCreate|ScheduleWakeup|SendMessage',
    hooks: [{ type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-freeze.mjs')}`, timeout: 10 }],
  });
  assert.ok(json.hooks.PreToolUse[1].hooks[0].command.split(' ')[1].startsWith('/'), 'an absolute path');
  assert.deepEqual(json.hooks.PreToolUse[0], h.settings.hooks.PreToolUse[0]);
  assert.deepEqual(json.hooks.SessionStart.slice(0, 2), [...h.settings.hooks.SessionStart, {
    matcher: 'resume', hooks: [{ type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-session.mjs')}`, timeout: 10 }],
  }]);
  assert.equal(json.model, 'sonnet');
  assert.deepEqual(json.permissions, h.settings.permissions);
  assert.deepEqual(SKILLS, ['k-intake', 'k-done', 'k-board-page', 'k-draft', 'k-bug', 'k-go-on', 'usage-review']);
  for (const s of SKILLS) {
    const link = join(h.skillsDir, s);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(resolve(h.skillsDir, readlinkSync(link)), join(h.kirunakRoot, 'skills', s));
  }
  assert.ok(lstatSync(join(h.skillsDir, 'k-go-on')).isSymbolicLink(), 'the owner\'s override, /k-go-on, is linked (R5.4)');
  // The PreToolUse block, the links, the escalation hook's 8 blocks, the stale-session hook's, the compact hook's 6, 2
  // rung agents, config.json, the windows' line (no workspace yet), the bugs' notice, SessionStart, the tracker.
  assert.equal(actions.length, 1 + SKILLS.length + 8 + 1 + 6 + 2 + 1 + 1 + 3);
  assert.match(actions[0], /added the kirunak PreToolUse hook/);
  assert.match(actions.at(-2), /added the kirunak SessionStart hook/);
  assert.ok(actions.at(-1).endsWith(`: node ${join(h.kirunakRoot, 'hooks', 'statusline-track.mjs')}`), 'the status line\'s line, printed');
});

test('a missing settings file is created; a second run changes nothing', () => {
  const h = home();
  const settingsPath = join(h.dir, 'fresh', 'settings.json');
  install({ ...h, settingsPath });
  const first = readFileSync(settingsPath);
  const mtime = statSync(settingsPath).mtimeMs;
  const { actions } = install({ ...h, settingsPath });
  assert.ok(readFileSync(settingsPath).equals(first), 'byte-identical');
  assert.equal(statSync(settingsPath).mtimeMs, mtime, 'not rewritten');
  assert.match(actions[0], /already has the kirunak PreToolUse hook/);
  assert.match(actions[1], /already links to/);
  assert.equal(JSON.parse(first).hooks.PreToolUse.length, 1);
  assert.equal(JSON.parse(first).hooks.SessionStart.length, 7, 'the session hook, the bugs\' notice, the escalation hook and the compact hook\'s 4 parts');
  assert.match(actions.at(-2), /already has the kirunak SessionStart hook/);
});

test('the SessionStart block from an older checkout is updated; a status line that runs the tracker is left alone', () => {
  const h = home();
  const json = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  json.hooks.SessionStart.push({ matcher: 'resume', hooks: [{ type: 'command', command: 'node /old/place/hooks/kirunak-session.mjs', timeout: 10 }] });
  json.statusLine = { type: 'command', command: 'node /old/place/hooks/statusline-track.mjs; ~/bin/line.sh', refreshInterval: 30 };
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  const { actions } = install(h);
  const after = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 8, 'the old block pointed here, and the bugs\' notice, the escalation hook\'s and the compact hook\'s added');
  assert.equal(after.hooks.SessionStart[1].hooks[0].command, `node ${join(h.kirunakRoot, 'hooks', 'kirunak-session.mjs')}`);
  assert.deepEqual(after.statusLine, json.statusLine, 'k install never writes the status line');
  assert.match(actions.at(-1), /already runs kirunak's tracker/);
});

test('the bugs\' notice is one SessionStart block on startup|clear, after the session hook, its older checkout\'s pointed here and never added twice; --print names it (gulnya/kirunak-bugs AC-7)', () => {
  const h = home();
  const command = `node ${join(h.kirunakRoot, 'hooks', 'kirunak-bugs.mjs')}`;
  const ours = (hooks) => hooks.SessionStart.filter((b) => b.hooks.some((x) => x.command.endsWith('hooks/kirunak-bugs.mjs')));
  const json = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  json.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: 'node /old/place/hooks/kirunak-bugs.mjs', timeout: 10 }] });
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  install(h);
  install(h);
  const after = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks;
  assert.equal(BUGS_MATCHER, 'startup|clear', 'a session the owner starts, or starts again with /clear; never a resume or a compaction');
  assert.deepEqual(ours(after), [{ matcher: 'startup|clear', hooks: [{ type: 'command', command, timeout: 10 }] }]);
  assert.ok(existsSync(join(KIRUNAK, 'hooks', 'kirunak-bugs.mjs')), 'the hook it wires is in this checkout');

  const fresh = home();
  const settingsPath = join(fresh.dir, 'printed', 'settings.json');
  const all = install({ ...fresh, settingsPath, print: true }).actions.join('\n');
  assert.ok(all.includes(`would add to ${settingsPath} hooks.SessionStart: {"matcher":"startup|clear","hooks":[{"type":"command","command":${JSON.stringify(`node ${join(fresh.kirunakRoot, 'hooks', 'kirunak-bugs.mjs')}`)}`), all);
  install({ ...fresh });
  assert.equal(ours(JSON.parse(readFileSync(fresh.settingsPath, 'utf8')).hooks).length, 1);
  const s = JSON.parse(readFileSync(fresh.settingsPath, 'utf8')).hooks.SessionStart;
  assert.ok(s.findIndex((b) => b.matcher === 'resume') < s.findIndex((b) => b.matcher === 'startup|clear'), 'after the session hook');
});

test('its own block from an older checkout is updated, never added twice', () => {
  const h = home();
  const json = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  json.hooks.PreToolUse.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill', hooks: [{ type: 'command', command: 'node /old/place/hooks/kirunak-freeze.mjs', timeout: 10 }] });
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  install(h);
  const pre = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.equal(pre[1].hooks[0].command, `node ${join(h.kirunakRoot, 'hooks', 'kirunak-freeze.mjs')}`);
});

test('a block of its own whose timeout differs is rewritten to kirunak\'s, the note naming both; --print says the same; one that matches is already there (gulnya/kirunak-install-hook-timeouts)', () => {
  const h = home();
  install(h);
  const json = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  const own = (event, end) => json.hooks[event].find((b) => b.hooks[0].command.endsWith(end)).hooks[0];
  own('SessionStart', '--part task').timeout = 30;
  own('SessionEnd', 'kirunak-compact.mjs').timeout = 1;
  delete own('Stop', 'kirunak-escalate.mjs').timeout;
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  const part = `node ${join(h.kirunakRoot, 'hooks', 'kirunak-compact.mjs')} --part task`;
  const printed = install({ ...h, print: true }).actions;
  assert.ok(printed.includes(`would set in ${h.settingsPath} hooks.SessionStart: ${JSON.stringify({ matcher: 'compact|clear', hooks: [{ type: 'command', command: part, timeout: 20 }] })}`), printed.join('\n'));
  const { actions } = install(h);
  assert.ok(actions.includes(`updated the kirunak SessionStart hook in ${h.settingsPath} to ${part} (matcher compact|clear), its timeout from 30 s to 20 s`), actions.join('\n'));
  assert.ok(actions.includes(`updated the kirunak SessionEnd hook in ${h.settingsPath} to node ${join(h.kirunakRoot, 'hooks', 'kirunak-compact.mjs')} (matcher clear), its timeout from 1 s to 5 s`));
  assert.ok(actions.includes(`updated the kirunak Stop hook in ${h.settingsPath} to node ${join(h.kirunakRoot, 'hooks', 'kirunak-escalate.mjs')}, its timeout from none to 10 s`));
  const after = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks;
  const task = after.SessionStart.filter((b) => b.hooks[0].command.endsWith('--part task'));
  assert.deepEqual([task.length, task[0].hooks[0].timeout, after.SessionEnd[0].hooks[0].timeout, after.Stop[0].hooks[0].timeout], [1, 20, 5, 10], 'rewritten, never added twice');
  assert.ok(!install(h).actions.some((a) => a.startsWith('updated the kirunak')), 'a second run finds every block as kirunak gives it');
});

test('a foreign skill of the same name is refused by name, and nothing is written', () => {
  const h = home();
  mkdirSync(join(h.skillsDir, 'k-done'), { recursive: true });
  writeFileSync(join(h.skillsDir, 'k-done', 'SKILL.md'), 'someone else\n');
  const before = readFileSync(h.settingsPath);
  assert.throws(() => install(h), (e) => e.code === 1 && e.message.includes(join(h.skillsDir, 'k-done')));
  assert.ok(readFileSync(h.settingsPath).equals(before), 'settings untouched');
  assert.ok(!existsSync(join(h.skillsDir, 'k-intake')), 'the other link not made');
  symlinkSync(join(h.dir, 'elsewhere'), join(h.skillsDir, 'k-intake'));
  assert.throws(() => install(h), /k-intake is a link to/);
});

test('an existing link to the same target is fine', () => {
  const h = home();
  mkdirSync(h.skillsDir, { recursive: true });
  symlinkSync(join(h.kirunakRoot, 'skills', 'k-intake'), join(h.skillsDir, 'k-intake'));
  const { actions } = install(h);
  assert.ok(actions.some((a) => a.includes('k-intake already links to')));
  assert.ok(actions.some((a) => a.startsWith('linked') && a.includes('k-done')));
});

test('--print writes nothing and prints everything with the paths filled in', () => {
  const h = home();
  const settingsPath = join(h.dir, 'none', 'settings.json');
  const bare = repo(h.dir, 'weather');
  const { actions } = install({ ...h, settingsPath, git: bare, print: true });
  assert.ok(!existsSync(settingsPath));
  assert.ok(!existsSync(h.skillsDir));
  assert.ok(!existsSync(join(bare, '.git', 'hooks', 'pre-commit')));
  const all = actions.join('\n');
  assert.ok(all.includes(`node ${join(h.kirunakRoot, 'hooks', 'kirunak-freeze.mjs')}`));
  assert.ok(all.includes(`would link ${join(h.skillsDir, 'k-intake')} -> ${join(h.kirunakRoot, 'skills', 'k-intake')}`));
  assert.ok(all.includes(`would link ${join(h.skillsDir, 'k-draft')} -> ${join(h.kirunakRoot, 'skills', 'k-draft')}`), 'the k-draft skill is linked like the others');
  assert.ok(all.includes(`would link ${join(h.skillsDir, 'k-bug')} -> ${join(h.kirunakRoot, 'skills', 'k-bug')}`), 'the k-bug skill is linked like the others (gulnya/kirunak-bugs AC-9)');
  assert.ok(all.includes(`node ${join(h.kirunakRoot, 'hooks', 'git-pre-commit.mjs')} || exit 1`));
  assert.ok(all.includes(`would add to ${settingsPath} hooks.SessionStart: {"matcher":"resume"`));
  assert.ok(all.includes(`node ${join(h.kirunakRoot, 'hooks', 'kirunak-session.mjs')}`));
  assert.ok(all.includes(`node ${join(h.kirunakRoot, 'hooks', 'statusline-track.mjs')}`));
  assert.ok(!all.includes('<kirunak>'));
  const real = install({ settingsPath, skillsDir: h.skillsDir, print: true }).actions.join('\n');
  assert.ok(real.includes(join(resolve(KIRUNAK), 'hooks', 'kirunak-freeze.mjs')), 'the default root is this checkout');
});

test('--git writes a hook in a repo with none, and only prints for a repo with its own', () => {
  const h = home();
  const bare = repo(h.dir, 'weather');
  const own = repo(h.dir, 'hub');
  const fallback = 'PATH="$PATH":/opt/node/bin';
  const line = `${fallback} node ${join(h.kirunakRoot, 'hooks', 'git-pre-commit.mjs')} || exit 1`;
  writeFileSync(join(own, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n', { mode: 0o755 });
  const { actions } = install({ ...h, git: [bare, own], nodePath: '/opt/node/bin/node' });
  const hook = join(bare, '.git', 'hooks', 'pre-commit');
  assert.equal(readFileSync(hook, 'utf8'), `#!/bin/sh\n${fallback}\nnode ${join(h.kirunakRoot, 'hooks', 'git-pre-commit.mjs')} || exit 1\n`);
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(own, '.git', 'hooks', 'pre-commit'), 'utf8'), '#!/bin/sh\nnpm test\n');
  assert.ok(actions.includes(`wrote ${hook}`));
  assert.ok(actions.some((a) => a.endsWith(`add this line to it: ${line}`)));
  writeFileSync(join(own, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nnpm test\n${line}\n`);
  const again = install({ ...h, git: [bare, own], nodePath: '/opt/node/bin/node' }).actions;
  assert.equal(again.filter((a) => a.includes("already runs kirunak's hook")).length, 6);
  for (const r of [bare, own]) {
    for (const [name, module] of [['prepare-commit-msg', 'git-prepare-commit-msg.mjs'], ['commit-msg', 'git-commit-msg.mjs']]) {
      const msg = join(r, '.git', 'hooks', name);
      assert.equal(readFileSync(msg, 'utf8'), `#!/bin/sh\n${fallback}\nexec node ${join(h.kirunakRoot, 'hooks', module)} "$@"\n`);
      assert.equal(statSync(msg).mode & 0o777, 0o755);
    }
  }
  assert.throws(() => install({ ...h, git: join(h.dir, 'not-a-repo') }), /not a git repository/);
});

test('--git follows core.hooksPath', () => {
  const h = home();
  const r = repo(h.dir, 'weather');
  mkdirSync(join(r, '.githooks'));
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: r });
  install({ ...h, git: r });
  assert.ok(existsSync(join(r, '.githooks', 'prepare-commit-msg')));
  assert.ok(!existsSync(join(r, '.git', 'hooks', 'prepare-commit-msg')));
});

test('a hook kirunak wrote before is rewritten; the new one finds node with a GUI\'s bare PATH', () => {
  const h = home();
  const r = repo(h.dir, 'weather');
  const slap = join(r, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(slap, `#!/bin/sh\nexec node ${join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs')} "$@"\n`, { mode: 0o755 });
  const { actions } = install({ ...h, kirunakRoot: KIRUNAK, git: r });
  assert.ok(actions.includes(`rewrote ${slap}`));
  assert.match(readFileSync(slap, 'utf8'), /^#!\/bin\/sh\nPATH="\$PATH":.+\nexec node /);
  writeFileSync(join(r, 'a.mjs'), 'export {};\n');
  execFileSync('git', ['add', 'a.mjs'], { cwd: r });
  const env = { HOME: h.dir, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KIRUNAK_HOME: h.home };
  execFileSync('git', ['commit', '-q', '-m', 'From a GUI'], { cwd: r, env });
  assert.match(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: r, encoding: 'utf8' }), /SLAP: 0 \(S\)/);
});

// design/plugins.md §3, design/approval.md §7: the rung agents, config.json and the escalation hook's blocks.
const LADDER = [
  { model: 'sonnet' },
  { model: 'opus', effort: 'high', mode: 'build' },
  { model: 'fable', id: 'claude-fable-5-1', effort: 'high', mode: 'design', agents: ['domain-deep'], cacheTtl: '1h' },
];
const ws = (extra = {}) => ({ ladder: LADDER, modulePath: '/ws/kirunak/workspace.mjs', hook: { ...DEFAULT_HOOK }, repos: [{ name: 'hub', root: '/ws/hub' }], ...extra });
const agent = (h, name) => readFileSync(join(h.agentsDir, `${name}.md`), 'utf8');

test('a <model>-step agent for every rung above the lowest, with the rung\'s model or id, effort and cacheTtl', () => {
  const h = home();
  const { actions } = install({ ...h, ws: ws() });
  assert.ok(!existsSync(join(h.agentsDir, 'sonnet-step.md')), 'none for the lowest');
  assert.ok(!existsSync(join(h.agentsDir, 'domain-deep.md')), 'the workspace\'s own agent is not written');
  const opus = agent(h, 'opus-step');
  assert.match(opus, /^---\nname: opus-step\ndescription: "One rung up from sonnet on this workspace's ladder: .*It takes the step itself\..*"\nmodel: opus\neffort: high\ntools: "\*"\n---\n/);
  assert.ok(opus.includes(`\n${MARKER}\n`));
  assert.ok(!opus.includes('experimental'), 'no cacheTtl, no experimental block');
  assert.match(opus, /Take the step: read every failure report/);
  const fable = agent(h, 'fable-step');
  assert.match(fable, /\nmodel: claude-fable-5-1\neffort: high\ntools: "\*"\nexperimental:\n {2}cacheTtl: 1h\n---\n/);
  assert.match(fable, /Design and review only: return a design .* Write no production code\./);
  assert.ok(!/\{\{|domain/.test(opus + fable), 'every slot filled, no word of the workspace\'s own agents (AC-30)');
  assert.ok(actions.includes(`wrote the opus-step agent: ${join(h.agentsDir, 'opus-step.md')}`));
});

test('a rung\'s autoCompactWindow goes into its agent\'s frontmatter after the effort; none without it', () => {
  const h = home();
  const ladder = [LADDER[0], LADDER[1], { ...LADDER[2], autoCompactWindow: 500_000 }];
  install({ ...h, ws: ws({ ladder }) });
  assert.match(agent(h, 'fable-step'), /\nmodel: claude-fable-5-1\neffort: high\nautoCompactWindow: 500000\ntools: "\*"\n/);
  assert.ok(!agent(h, 'opus-step').includes('autoCompactWindow'));
});

test('an agent path that is a link is written through, and the action names the real file', () => {
  const h = home();
  const repoAgents = join(h.dir, 'portfolio', 'claude', 'agents');
  mkdirSync(repoAgents, { recursive: true });
  mkdirSync(h.agentsDir, { recursive: true });
  writeFileSync(join(repoAgents, 'fable-step.md'), `---\nname: fable-step\nmodel: fable\n---\n${MARKER}\nold\n`);
  symlinkSync(join(repoAgents, 'fable-step.md'), join(h.agentsDir, 'fable-step.md'));
  const { actions } = install({ ...h, ws: ws() });
  assert.ok(lstatSync(join(h.agentsDir, 'fable-step.md')).isSymbolicLink(), 'the link kept');
  assert.match(readFileSync(join(repoAgents, 'fable-step.md'), 'utf8'), /model: claude-fable-5-1/);
  assert.ok(actions.includes(`rewrote the fable-step agent: ${join(h.agentsDir, 'fable-step.md')} → ${realpathSync(join(repoAgents, 'fable-step.md'))}`));
});

test('an agent kirunak did not write is refused, nothing written, unless --replace-agents', () => {
  const h = home();
  mkdirSync(h.agentsDir, { recursive: true });
  const own = '---\nname: opus-step\nmodel: claude-opus-5-5\neffort: xhigh\n---\nThe owner\'s own.\n';
  writeFileSync(join(h.agentsDir, 'opus-step.md'), own);
  const before = readFileSync(h.settingsPath);
  assert.throws(() => install({ ...h, ws: ws() }), (e) => e.code === 1 && e.message.includes(`${join(h.agentsDir, 'opus-step.md')} is an agent kirunak did not write`) &&
    e.message.includes('--replace-agents') && e.message.includes('Nothing was written'));
  assert.ok(readFileSync(h.settingsPath).equals(before), 'settings untouched');
  assert.equal(agent(h, 'opus-step'), own);
  assert.ok(!existsSync(join(h.agentsDir, 'fable-step.md')) && !existsSync(join(h.home, 'escalate')) && !existsSync(h.skillsDir));
  assert.match(install({ ...h, ws: ws(), print: true }).actions.join('\n'), /would refuse: .*opus-step\.md is an agent kirunak did not write/);
  const { actions } = install({ ...h, ws: ws(), replaceAgents: true });
  assert.ok(actions.includes(`replaced the opus-step agent: ${join(h.agentsDir, 'opus-step.md')}`));
  assert.match(agent(h, 'opus-step'), /model: opus\neffort: high/);
});

test('an agent kirunak wrote is rewritten when the ladder changes and left alone when it has not', () => {
  const h = home();
  install({ ...h, ws: ws() });
  const path = join(h.agentsDir, 'opus-step.md');
  const mtime = statSync(path).mtimeMs;
  const again = install({ ...h, ws: ws() }).actions;
  assert.equal(statSync(path).mtimeMs, mtime, 'not rewritten');
  assert.ok(again.includes(`${path} is already the opus-step agent the ladder makes`));
  const xhigh = LADDER.map((r) => (r.model === 'opus' ? { ...r, effort: 'xhigh' } : r));
  assert.ok(install({ ...h, ws: ws({ ladder: xhigh }) }).actions.includes(`rewrote the opus-step agent: ${path}`));
  assert.match(agent(h, 'opus-step'), /\neffort: xhigh\n/);
});

test('a link to nothing is refused by name', () => {
  const h = home();
  mkdirSync(h.agentsDir, { recursive: true });
  symlinkSync(join(h.dir, 'gone.md'), join(h.agentsDir, 'opus-step.md'));
  assert.throws(() => install({ ...h, ws: ws() }), /opus-step\.md is a link to .*gone\.md, which does not exist/);
});

test('config.json: the ladder with each rung\'s agents, the hook switches, the repos and the workspace, written every run', () => {
  const h = home();
  const now = new Date('2026-10-25T12:00:00Z');
  install({ ...h, ws: ws({ hook: { ...DEFAULT_HOOK, repeats: 3, commands: ['^bun test'] } }), now });
  const path = join(h.home, 'escalate', 'config.json');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    written: '2026-10-25T12:00:00.000Z',
    workspace: '/ws/kirunak/workspace.mjs',
    ladder: [
      { model: 'sonnet', id: null, effort: null, mode: null, agents: [] },
      { model: 'opus', id: null, effort: 'high', mode: 'build', agents: ['opus-step'] },
      { model: 'fable', id: 'claude-fable-5-1', effort: 'high', mode: 'design', agents: ['fable-step', 'domain-deep'] },
    ],
    hook: { enabled: true, block: true, repeats: 3, commands: ['^bun test'] },
    repos: { hub: '/ws/hub' },
    compact: { enabled: true, handoverSize: 150000, window: 183000, midStepLimit: 167000, roots: ['/ws/hub'] },
    usage: { stale: { minutes: 60, context: 150000 }, limitsLog: null },
  });
  install({ ...h, ws: ws(), now: new Date('2026-10-26T08:00:00Z') });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).written, '2026-10-26T08:00:00.000Z', 'its time newer than the module\'s');
  const bare = home();
  install(bare);
  const none = JSON.parse(readFileSync(join(bare.home, 'escalate', 'config.json'), 'utf8'));
  assert.equal(none.workspace, null, 'before k init: kirunak\'s default ladder');
  assert.deepEqual(none.ladder.map((r) => r.agents), [[], ['opus-step'], ['fable-step']]);
});

test('the escalation hook on its eight events, SubagentStop matching every named agent, Stop with no matcher', () => {
  const h = home();
  install({ ...h, ws: ws() });
  const hooks = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks;
  const command = `node ${join(h.kirunakRoot, 'hooks', 'kirunak-escalate.mjs')}`;
  const ours = (event) => hooks[event].filter((b) => b.hooks[0].command === command);
  const matchers = Object.fromEntries(['PostToolUseFailure', 'PostToolUse', 'SubagentStop', 'UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'PostModelSwitch', 'Stop']
    .map((event) => [event, ours(event)]).map(([event, blocks]) => {
      assert.equal(blocks.length, 1, `one block on ${event}`);
      assert.deepEqual(blocks[0].hooks, [{ type: 'command', command, timeout: 10 }]);
      return [event, blocks[0].matcher ?? null];
    }));
  assert.deepEqual(matchers, {
    PostToolUseFailure: 'Bash|Edit|Write|MultiEdit|NotebookEdit', PostToolUse: 'Agent', SubagentStop: '.+', UserPromptSubmit: null,
    UserPromptExpansion: null, SessionStart: 'startup|resume|clear', PostModelSwitch: null, Stop: null,
  });
  for (const event of ['UserPromptSubmit', 'Stop']) assert.ok(!('matcher' in ours(event)[0]), `${event}: no matcher key at all`);
  // R6.2: `.+` takes every named agent and never the empty agent_type of Claude Code's internal agents.
  const re = new RegExp(`^(?:${matchers.SubagentStop})$`);
  assert.deepEqual(['Explore', 'general-purpose', 'opus-step', 'kirunak:fable-step', ''].map((t) => re.test(t)), [true, true, true, true, false]);
  assert.ok(existsSync(join(KIRUNAK, 'hooks', 'kirunak-escalate.mjs')), 'the hook it wires is in this checkout');
});

test('an older freeze block gets the grown matcher; an older SubagentStop block, of the ladder\'s agents, is given .+ for any ladder, never a second block', () => {
  const h = home();
  const json = JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  json.hooks.PreToolUse.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill', hooks: [{ type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-freeze.mjs')}`, timeout: 10 }] });
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  const { actions } = install({ ...h, ws: ws() });
  assert.ok(actions[0].startsWith('updated the kirunak PreToolUse hook') && actions[0].endsWith(`(matcher ${FREEZE_MATCHER})`));
  let after = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks;
  assert.equal(after.PreToolUse.length, 2);
  assert.equal(after.PreToolUse[1].matcher, FREEZE_MATCHER);
  assert.equal(after.SubagentStop[0].matcher, '.+');
  after.SubagentStop[0].matcher = 'opus-step|fable-step';
  writeFileSync(h.settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(h.settingsPath, 'utf8')), hooks: after }, null, 2) + '\n');
  const two = [{ model: 'sonnet' }, { model: 'opus', effort: 'high' }];
  const again = install({ ...h, ws: ws({ ladder: two }) }).actions;
  after = JSON.parse(readFileSync(h.settingsPath, 'utf8')).hooks;
  assert.equal(after.SubagentStop.length, 1);
  assert.equal(after.SubagentStop[0].matcher, '.+');
  assert.ok(again.some((a) => /^updated the kirunak SubagentStop hook .*\(matcher \.\+\)$/.test(a)));
  assert.ok(again.some((a) => a.endsWith('already has the kirunak PostToolUseFailure hook')));
});

test('--print shows the blocks, the agents and config.json, and writes none of them', () => {
  const h = home();
  const before = readFileSync(h.settingsPath);
  const all = install({ ...h, ws: ws(), print: true }).actions.join('\n');
  assert.ok(readFileSync(h.settingsPath).equals(before));
  assert.ok(!existsSync(h.agentsDir) && !existsSync(join(h.home, 'escalate')));
  assert.ok(all.includes(`would set in ${h.settingsPath} hooks.SubagentStop: {"matcher":".+"`));
  assert.ok(all.includes(`would set in ${h.settingsPath} hooks.Stop: {"hooks":`));
  assert.ok(all.includes(`would write ${join(h.agentsDir, 'fable-step.md')}:\n---\nname: fable-step\n`));
  assert.ok(all.includes(`would write ${join(h.home, 'escalate', 'config.json')}:\n{\n  "written": `));
});

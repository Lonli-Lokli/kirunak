import { strict as assert } from 'node:assert';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { install, SKILLS } from '../lib/install.mjs';
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
  return { dir, kirunakRoot, settingsPath, skillsDir: join(dir, '.claude', 'skills'), settings, home: join(dir, 'state') };
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
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill',
    hooks: [{ type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-freeze.mjs')}`, timeout: 10 }],
  });
  assert.ok(json.hooks.PreToolUse[1].hooks[0].command.split(' ')[1].startsWith('/'), 'an absolute path');
  assert.deepEqual(json.hooks.PreToolUse[0], h.settings.hooks.PreToolUse[0]);
  assert.deepEqual(json.hooks.SessionStart, [...h.settings.hooks.SessionStart, {
    matcher: 'resume', hooks: [{ type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-session.mjs')}`, timeout: 10 }],
  }]);
  assert.equal(json.model, 'sonnet');
  assert.deepEqual(json.permissions, h.settings.permissions);
  assert.deepEqual(SKILLS, ['k-intake', 'k-done', 'k-board-page', 'k-draft']);
  for (const s of SKILLS) {
    const link = join(h.skillsDir, s);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(resolve(h.skillsDir, readlinkSync(link)), join(h.kirunakRoot, 'skills', s));
  }
  assert.equal(actions.length, 7);
  assert.match(actions[0], /added the kirunak PreToolUse hook/);
  assert.match(actions[1 + SKILLS.length], /added the kirunak SessionStart hook/);
  assert.ok(actions[2 + SKILLS.length].endsWith(`: node ${join(h.kirunakRoot, 'hooks', 'statusline-track.mjs')}`), 'the status line\'s line, printed');
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
  assert.equal(JSON.parse(first).hooks.SessionStart.length, 1);
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
  assert.equal(after.hooks.SessionStart.length, 2);
  assert.equal(after.hooks.SessionStart[1].hooks[0].command, `node ${join(h.kirunakRoot, 'hooks', 'kirunak-session.mjs')}`);
  assert.deepEqual(after.statusLine, json.statusLine, 'k install never writes the status line');
  assert.match(actions.at(-1), /already runs kirunak's tracker/);
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
  assert.equal(again.filter((a) => a.includes("already runs kirunak's hook")).length, 4);
  for (const r of [bare, own]) {
    const slap = join(r, '.git', 'hooks', 'prepare-commit-msg');
    assert.equal(readFileSync(slap, 'utf8'), `#!/bin/sh\n${fallback}\nexec node ${join(h.kirunakRoot, 'hooks', 'git-prepare-commit-msg.mjs')} "$@"\n`);
    assert.equal(statSync(slap).mode & 0o777, 0o755);
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

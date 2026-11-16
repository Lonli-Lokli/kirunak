import { strict as assert } from 'node:assert';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { BUGS_MATCHER, FREEZE_MATCHER, install, MARKER, SKILLS } from '../lib/install.mjs';
import { unlockHookLine } from '../lib/doctor.mjs';
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
  assert.deepEqual(SKILLS, ['k-intake', 'k-done', 'k-board-page', 'k-draft', 'k-bug', 'k-go-on', 'usage-review', 'k-heavy']);
  for (const s of SKILLS) {
    const link = join(h.skillsDir, s);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(resolve(h.skillsDir, readlinkSync(link)), join(h.kirunakRoot, 'skills', s));
  }
  assert.ok(lstatSync(join(h.skillsDir, 'k-go-on')).isSymbolicLink(), 'the owner\'s override, /k-go-on, is linked (R5.4)');
  // The PreToolUse block, the links, the escalation hook's 8 blocks, the stale-session hook's, the compact hook's 6, the
  // lock release's, 2 rung agents, config.json, the windows' line (no workspace yet), the bugs' notice, SessionStart,
  // the tracker.
  assert.equal(actions.length, 1 + SKILLS.length + 8 + 1 + 6 + 1 + 2 + 1 + 1 + 3);
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

test("AC-1: the worktree lock's release on every SessionEnd, no matcher, 5 s, beside the compact hook's; a block of ours with a matcher or another timeout is set back; k doctor reads it (approval.md §4)", () => {
  const h = home();
  const unlock = { type: 'command', command: `node ${join(h.kirunakRoot, 'hooks', 'kirunak-unlock.mjs')}`, timeout: 5 };
  const printed = install({ ...h, print: true }).actions;
  assert.ok(printed.includes(`would set in ${h.settingsPath} hooks.SessionEnd: ${JSON.stringify({ hooks: [unlock] })}`), printed.join('\n'));
  assert.ok(install(h).actions.includes(`added the kirunak SessionEnd hook to ${h.settingsPath}`));
  const read = () => JSON.parse(readFileSync(h.settingsPath, 'utf8'));
  assert.deepEqual(read().hooks.SessionEnd[1], { hooks: [unlock] });
  assert.match(read().hooks.SessionEnd[0].hooks[0].command, /kirunak-compact\.mjs$/);
  assert.deepEqual(unlockHookLine(h), [true, 'worktree lock release: wired on SessionEnd, every end']);
  const json = read();
  Object.assign(json.hooks.SessionEnd[1], { matcher: 'clear' });
  json.hooks.SessionEnd[1].hooks[0].timeout = 60;
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  assert.deepEqual(unlockHookLine(h), [false, "worktree lock release: wired on SessionEnd with matcher clear, kirunak's none (run k install)"]);
  delete json.hooks.SessionEnd[1].matcher;
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  assert.deepEqual(unlockHookLine(h), [false, "worktree lock release: wired on SessionEnd (timeout 60 s, kirunak's 5 s) (run k install)"]);
  json.hooks.SessionEnd[1].matcher = 'clear';
  writeFileSync(h.settingsPath, JSON.stringify(json, null, 2) + '\n');
  assert.ok(install(h).actions.includes(`updated the kirunak SessionEnd hook in ${h.settingsPath} to ${unlock.command}, its timeout from 60 s to 5 s`));
  assert.deepEqual(read().hooks.SessionEnd.slice(1), [{ hooks: [unlock] }], 'set back, never added twice');
  assert.deepEqual(unlockHookLine(h), [true, 'worktree lock release: wired on SessionEnd, every end']);
  const off = read();
  off.hooks.SessionEnd = off.hooks.SessionEnd.slice(0, 1);
  writeFileSync(h.settingsPath, JSON.stringify(off, null, 2) + '\n');
  assert.deepEqual(unlockHookLine(h), [false, `worktree lock release: not wired on SessionEnd in ${h.settingsPath} (run k install)`]);
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

// gulnya/kirunak-install-dry-run: a hook runs kirunak's hook however it spells the path, and a registered repo is
// reported as registered.

// katyafm's kirunak block in its pre-commit, verbatim (the task's evidence/S-0-before.txt, its lines 59-62).
const KATYAFM_BLOCK = [
  '# kirunak: a frozen task matches its approval, owner-only records, intake.md append-only (kirunak design/approval.md §3).',
  '# A git GUI such as Fork reads no shell profile, so nvm\'s node is added when none is on PATH.',
  'command -v node >/dev/null 2>&1 || PATH="$PATH:$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"',
  'node "$HOME"/sources/kirunak/hooks/git-pre-commit.mjs || exit 1',
];

// A temp home whose kirunak checkout is <userHome>/sources/kirunak, where katyafm's block finds it through $HOME.
function homeAt() {
  const h = home();
  const kirunakRoot = join(h.dir, 'sources', 'kirunak');
  for (const s of SKILLS) mkdirSync(join(kirunakRoot, 'skills', s), { recursive: true });
  return { ...h, kirunakRoot, userHome: h.dir };
}

// A repo whose pre-commit is #!/bin/sh, a line of the owner's, then `lines`.
function ownHook(h, name, lines) {
  const r = repo(h.dir, name);
  const hook = join(r, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, ['#!/bin/sh', 'npm test || exit 1', ...lines, ''].join('\n'), { mode: 0o755 });
  return { r, hook, text: readFileSync(hook, 'utf8') };
}

const dryAndReal = (h, git) => [install({ ...h, git, print: true }).actions, install({ ...h, git }).actions];

test('katyafm\'s block, its node line through "$HOME", $HOME, ${HOME}, ~ or single quotes, already runs kirunak\'s hook, dry run and real, and is kept (AC-1, AC-4)', () => {
  const h = homeAt();
  const variants = {
    katyafm: KATYAFM_BLOCK,
    bare: [...KATYAFM_BLOCK.slice(0, 3), 'node $HOME/sources/kirunak/hooks/git-pre-commit.mjs || exit 1'],
    braced: [...KATYAFM_BLOCK.slice(0, 3), 'node "${HOME}/sources/kirunak/hooks/git-pre-commit.mjs" || exit 1'],
    tilde: [...KATYAFM_BLOCK.slice(0, 3), 'node ~/sources/kirunak/hooks/git-pre-commit.mjs || exit 1'],
    single: [...KATYAFM_BLOCK.slice(0, 3), 'node "$HOME"\'/sources/kirunak/hooks/git-pre-commit.mjs\' || exit 1'],
  };
  const repos = Object.entries(variants).map(([name, lines]) => ownHook(h, name, lines));
  const [dry, real] = dryAndReal(h, repos.map((x) => x.r));
  for (const { hook, text } of repos) {
    assert.ok(dry.includes(`${hook} already runs kirunak's hook`), `the dry run: ${dry.find((a) => a.includes(hook))}`);
    assert.ok(real.includes(`${hook} already runs kirunak's hook`), `the real install: ${real.find((a) => a.includes(hook))}`);
    assert.equal(readFileSync(hook, 'utf8'), text, 'the hook is unchanged');
  }
});

test('a commented-out node line, another checkout\'s hook or a path inside a longer one still gets "add this line" (AC-5, E-1, E-2)', () => {
  const h = homeAt();
  const root = h.kirunakRoot;
  const variants = {
    commented: [...KATYAFM_BLOCK.slice(0, 3), '# node "$HOME"/sources/kirunak/hooks/git-pre-commit.mjs || exit 1'],
    commentedAbsolute: [`  #node ${root}/hooks/git-pre-commit.mjs || exit 1`],
    other: ['node "$HOME"/sources/kirunak-other/hooks/git-pre-commit.mjs || exit 1'],
    longer: [`node /x${root}/hooks/git-pre-commit.mjs || exit 1`],
    suffix: [`node ${root}/hooks/git-pre-commit.mjs.bak || exit 1`],
  };
  const repos = Object.entries(variants).map(([name, lines]) => ownHook(h, name, lines));
  const [dry, real] = dryAndReal(h, repos.map((x) => x.r));
  for (const { hook, text } of repos) {
    assert.ok(dry.some((a) => a.startsWith(`add this line to ${hook}: `)), `the dry run: ${dry.find((a) => a.includes(hook))}`);
    assert.ok(real.some((a) => a.startsWith(`${hook} is the repo's own hook; add this line to it: `)), `the real install: ${real.find((a) => a.includes(hook))}`);
    assert.equal(readFileSync(hook, 'utf8'), text, 'the hook is unchanged');
  }
});

test('a hook of only #!/bin/sh and kirunak\'s line through $HOME is reported already, never rewritten (E-4)', () => {
  const h = homeAt();
  const r = repo(h.dir, 'katyafm');
  const hook = join(r, '.git', 'hooks', 'pre-commit');
  const text = '#!/bin/sh\nnode "$HOME"/sources/kirunak/hooks/git-pre-commit.mjs || exit 1\n';
  writeFileSync(hook, text, { mode: 0o755 });
  const [dry, real] = dryAndReal(h, r);
  assert.ok(dry.includes(`${hook} already runs kirunak's hook`), `the dry run: ${dry.find((a) => a.includes(hook))}`);
  assert.ok(real.includes(`${hook} already runs kirunak's hook`), `the real install: ${real.find((a) => a.includes(hook))}`);
  assert.equal(readFileSync(hook, 'utf8'), text);
});

test('a registered repo, given with a trailing slash, is "already registered" in the dry run and the real install, and slapignore.json is kept (AC-2, AC-3, AC-6, E-3)', () => {
  const h = home();
  const r = repo(h.dir, 'katyafm');
  const key = realpathSync(r);
  const file = join(h.home, 'slapignore.json');
  const first = install({ ...h, git: r }).actions;
  assert.ok(first.includes(`registered ${key} in ${file}`), `the first install: ${first.filter((a) => a.includes('regist'))}`);
  const bytes = readFileSync(file);
  const [dry, real] = dryAndReal(h, `${r}/`);
  const line = `${key} is already registered in ${file}`;
  assert.ok(dry.includes(line), `the dry run: ${dry.filter((a) => a.includes('regist'))}`);
  assert.ok(!dry.some((a) => a.startsWith('would register')));
  assert.ok(real.includes(line), `the real install: ${real.filter((a) => a.includes('regist'))}`);
  assert.deepEqual(readFileSync(file), bytes, 'slapignore.json is unchanged');
});

test('a repo slapignore.json does not list gets "would register" in the dry run, which writes nothing (AC-2, AC-7)', () => {
  const h = home();
  const listed = repo(h.dir, 'katyafm');
  install({ ...h, git: listed });
  const r = repo(h.dir, 'weather');
  const file = join(h.home, 'slapignore.json');
  const bytes = readFileSync(file);
  const dry = install({ ...h, git: r, print: true }).actions;
  assert.ok(dry.includes(`would register ${realpathSync(r)} in ${file}`), `the dry run: ${dry.filter((a) => a.includes('regist'))}`);
  assert.ok(!dry.some((a) => a.includes('already registered')));
  assert.deepEqual(readFileSync(file), bytes, 'the dry run writes nothing');
});

// gulnya/close-leaves-untracked-step-files AC-3, E-1: kirunak/tasks/.gitignore keeps raw run output out of git.
const NIVA = ['*.xcresult/', '*/steps/**/xml/', '*/steps/**/*Test/', '*/steps/**/profile-*/', '*/steps/**/*profile*.html', '*/steps/**/*.log', '*/steps/**/*.out'];
const patterns = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('--git writes kirunak/tasks/.gitignore with niva\'s lines in a repo with none; the root .gitignore is untouched; a second run keeps it (AC-3)', () => {
  const h = home();
  const r = repo(h.dir, 'weather');
  writeFileSync(join(r, '.gitignore'), 'node_modules/\n');
  const file = join(r, 'kirunak', 'tasks', '.gitignore');
  const { actions } = install({ ...h, git: r });
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(patterns(text), NIVA);
  assert.match(text, /^# Raw run output/);
  assert.ok(actions.some((a) => a.startsWith(`wrote ${file}`) && a.endsWith('commit it')));
  assert.equal(readFileSync(join(r, '.gitignore'), 'utf8'), 'node_modules/\n');
  const again = install({ ...h, git: r }).actions;
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.ok(again.includes(`${file} has every raw-output line; kept`));
  mkdirSync(join(r, 'kirunak', 'tasks', 't', 'steps', 'S-1', 'app', 'testDebugUnitTest'), { recursive: true });
  for (const f of ['run.log', 'out.out', 'report.md', 'app/testDebugUnitTest/a.xml']) writeFileSync(join(r, 'kirunak', 'tasks', 't', 'steps', 'S-1', f), 'x\n');
  const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'kirunak/tasks/t'], { cwd: r, encoding: 'utf8' });
  assert.equal(untracked.trim(), '?? kirunak/tasks/t/steps/S-1/report.md', 'git ignores the raw output, never a record');
});

test('--git keeps a repo\'s own kirunak/tasks/.gitignore lines and adds only the ones it lacks; a second run changes nothing (E-1)', () => {
  const h = home();
  const r = repo(h.dir, 'weather');
  const file = join(r, 'kirunak', 'tasks', '.gitignore');
  mkdirSync(dirname(file), { recursive: true });
  const own = '# Our own: screen recordings\n*.mov\n*/steps/**/*.log  \n  *.xcresult/';
  writeFileSync(file, own);
  const { actions } = install({ ...h, git: r });
  const text = readFileSync(file, 'utf8');
  // git drops a line's trailing spaces but keeps its leading ones: '  *.xcresult/' ignores nothing, so it is lacking.
  const lacking = NIVA.filter((l) => l !== '*/steps/**/*.log');
  assert.equal(text, `${own}\n${lacking.join('\n')}\n`);
  assert.ok(actions.some((a) => a.startsWith(`added to ${file} the lines it lacked`) && a.endsWith('commit it')));
  install({ ...h, git: r });
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('--git keeps untouched a CRLF kirunak/tasks/.gitignore that has every line, as git reads it (E-1)', () => {
  const h = home();
  const r = repo(h.dir, 'weather');
  const file = join(r, 'kirunak', 'tasks', '.gitignore');
  mkdirSync(dirname(file), { recursive: true });
  // git drops a line's trailing '\r' before its trailing spaces, so each of these lines ignores as its pattern does.
  const own = `# Our own\r\n${NIVA.map((l, i) => (i === 5 ? `${l}  ` : l)).join('\r\n')}\r\n`;
  writeFileSync(file, own);
  const { actions } = install({ ...h, git: r });
  assert.equal(readFileSync(file, 'utf8'), own);
  assert.ok(actions.includes(`${file} has every raw-output line; kept`));
  mkdirSync(join(r, 'kirunak', 'tasks', 't', 'steps', 'S-1'), { recursive: true });
  writeFileSync(join(r, 'kirunak', 'tasks', 't', 'steps', 'S-1', 'run.log'), 'x\n');
  const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'kirunak/tasks/t'], { cwd: r, encoding: 'utf8' });
  assert.equal(untracked.trim(), '', 'git reads the CRLF line with trailing spaces as its pattern');
});

test('--git --print writes no kirunak/tasks/.gitignore and says what it would write or add (AC-3)', () => {
  const h = home();
  const bare = repo(h.dir, 'weather');
  const own = repo(h.dir, 'hub');
  const ownFile = join(own, 'kirunak', 'tasks', '.gitignore');
  mkdirSync(dirname(ownFile), { recursive: true });
  writeFileSync(ownFile, '*.mov\n*/steps/**/*.log\n');
  const all = install({ ...h, git: [bare, own], print: true }).actions.join('\n');
  const file = join(bare, 'kirunak', 'tasks', '.gitignore');
  assert.ok(!existsSync(join(bare, 'kirunak')));
  assert.equal(readFileSync(ownFile, 'utf8'), '*.mov\n*/steps/**/*.log\n');
  assert.ok(all.includes(`would write ${file}`));
  for (const l of NIVA) assert.ok(all.includes(`\n${l}\n`), l);
  const lines = all.split('\n');
  const add = lines.findIndex((l) => l.startsWith(`would add to ${ownFile} the lines it lacks`));
  assert.ok(add >= 0, 'names the lines it would add to the repo\'s own file');
  assert.deepEqual(lines.slice(add + 1, add + 7), NIVA.filter((l) => l !== '*/steps/**/*.log'));
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

// gulnya/builder-from-ladder AC-1, AC-2, AC-3: the builder from the rung its entry names, with the entry's tools.
const TOOLS = ['Read', 'Edit', 'Bash', 'mcp__docs__search'];

test('a ladder whose builder rung is on another model writes builder.md with that model, that effort and the workspace\'s tools', () => {
  const h = home();
  const ladder = [{ model: 'haiku' }, { model: 'sonnet', effort: 'medium', mode: 'build' }, { model: 'opus', effort: 'high', mode: 'design' }];
  const { actions } = install({ ...h, ws: ws({ ladder, builder: { rung: 'sonnet', tools: TOOLS } }) });
  const builder = agent(h, 'builder');
  assert.match(builder, /^---\nname: builder\ndescription: "Builds one step a session hands it: .*On the sonnet rung's model and effort.*"\nmodel: sonnet\neffort: medium\ntools: Read, Edit, Bash, mcp__docs__search\n---\n/);
  assert.ok(builder.includes(`\n${MARKER}\n`));
  assert.ok(builder.includes('You have Read, Edit, Bash and mcp__docs__search only.'));
  assert.match(builder, /return `NEEDS-TOOLS`/);
  assert.ok(!/\{\{|opus|Glob|Grep|TaskStop|gulnya|owner 20/.test(builder), 'every slot filled, nothing of another rung or a portfolio');
  assert.ok(actions.includes(`wrote the builder agent: ${join(h.agentsDir, 'builder.md')}`));
});

test('the builder takes its rung\'s id, autoCompactWindow and cacheTtl as the rung agents do', () => {
  const h = home();
  const ladder = [LADDER[0], { ...LADDER[1], id: 'claude-opus-5-5', autoCompactWindow: 300_000, cacheTtl: '5m' }, LADDER[2]];
  install({ ...h, ws: ws({ ladder, builder: { rung: 'opus', tools: ['Read'] } }) });
  assert.match(agent(h, 'builder'), /\nmodel: claude-opus-5-5\neffort: high\nautoCompactWindow: 300000\ntools: Read\nexperimental:\n {2}cacheTtl: 5m\n---\n/);
  assert.ok(agent(h, 'builder').includes('You have Read only.'));
});

test('no builder entry, no builder.md', () => {
  const h = home();
  const { actions } = install({ ...h, ws: ws() });
  assert.ok(!existsSync(join(h.agentsDir, 'builder.md')));
  assert.ok(!actions.some((a) => a.includes('builder')));
});

test('the builder follows the rung agents\' rules: kept, rewritten when its tools change, an unmarked one replaced only with --replace-agents, written through a link', () => {
  const h = home();
  const repoAgents = join(h.dir, 'portfolio', 'claude', 'agents');
  mkdirSync(repoAgents, { recursive: true });
  mkdirSync(h.agentsDir, { recursive: true });
  const own = '---\nname: builder\nmodel: opus\neffort: high\ntools: Read\n---\nWritten by hand.\n';
  writeFileSync(join(repoAgents, 'builder.md'), own);
  const path = join(h.agentsDir, 'builder.md');
  symlinkSync(join(repoAgents, 'builder.md'), path);
  const real = realpathSync(join(repoAgents, 'builder.md'));
  const entry = (tools) => ws({ builder: { rung: 'opus', tools } });
  assert.throws(() => install({ ...h, ws: entry(TOOLS) }), (e) => e.message.includes(`${real} is an agent kirunak did not write`) && e.message.includes('--replace-agents'));
  assert.equal(readFileSync(real, 'utf8'), own);
  assert.match(install({ ...h, ws: entry(TOOLS), print: true }).actions.join('\n'), /would refuse: .*builder\.md is an agent kirunak did not write/);
  assert.ok(install({ ...h, ws: entry(TOOLS), replaceAgents: true }).actions.includes(`replaced the builder agent: ${path} → ${real}`));
  assert.ok(lstatSync(path).isSymbolicLink(), 'the link kept');
  assert.match(readFileSync(real, 'utf8'), /\nmodel: opus\neffort: high\ntools: Read, Edit, Bash, mcp__docs__search\n/);
  assert.ok(install({ ...h, ws: entry(TOOLS) }).actions.includes(`${path} → ${real} is already the builder agent the ladder makes`));
  assert.ok(install({ ...h, ws: entry(['Read']) }).actions.includes(`rewrote the builder agent: ${path} → ${real}`));
  assert.match(readFileSync(real, 'utf8'), /\ntools: Read\n/);
  assert.ok(install({ ...h, ws: entry(['Read']), print: true }).actions.includes(`${path} → ${real} is already the builder agent the ladder makes`));
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

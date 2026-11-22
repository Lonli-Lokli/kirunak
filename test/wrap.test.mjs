import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { live, read } from '../lib/lease.mjs';
import { alive, killTree, programArgv, shell } from '../lib/os.mjs';
import { HELD, sessionLease, wrapped } from '../lib/wrap.mjs';
import { tempDir } from './helpers.mjs';

// asilak/kirunak-cross-platform AC-6: the wrapper each session and heavy job runs under, on every OS.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(ok, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}
const dir = () => tempDir('kirunak-wrap-');
const node = (script, ...args) => [process.execPath, '-e', script, ...args];
const run = (command, opts = {}, input = '') => {
  const [bin, ...args] = wrapped(command, opts);
  return spawnSync(bin, args, { input, encoding: 'utf8' });
};
// As k run and the guard start it: detached, so it leads a process group on macOS and Linux.
const start = (command, opts = {}) => {
  const [bin, ...args] = wrapped(command, opts);
  return spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
};
const ended = (child) => new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
const pidIn = (file) => (existsSync(file) ? Number(readFileSync(file, 'utf8')) || null : null);

// A node process that starts a child of its own attached, writes that child's pid to the file named and stays: a
// session and the tool it runs, a job and the test runner it starts.
const PARENT = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[1], String(c.pid));
setTimeout(() => {}, 30000);`;

test('the wrapper runs its command with its own stdin and stdout, holds its lease naming the command while it runs, lets it go and exits with its code', () => {
  const d = dir();
  const lease = join(d, 'leases', 'job');
  const r = run(node("let s = ''; process.stdin.on('data', (b) => (s += b)); process.stdin.on('end', () => { const h = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(s.trim(), h.pid === process.ppid, h.child === process.pid); process.exit(3); });", join(lease, 'holder.json')), { lease }, 'the brief\n');
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, 'the brief true true\n', 'stdin reached it, and the lease named the wrapper and its command');
  assert.equal(read(lease), null, 'the lease is let go');
});

test('a second wrapper on a lease another live wrapper holds does not start its command: exit HELD, saying who holds it', async () => {
  const d = dir();
  const lease = join(d, 'session.lease');
  const first = start(node('setTimeout(() => {}, 30000)'), { lease });
  try {
    await until(() => read(lease)?.holder?.child);
    const r = run(node("require('fs').writeFileSync(process.argv[1], 'ran')", join(d, 'ran')), { lease });
    assert.equal(r.status, HELD);
    assert.match(r.stderr, new RegExp(`is held by pid ${first.pid}, whose command runs: this one does not start`));
    assert.equal(existsSync(join(d, 'ran')), false);
  } finally {
    await killTree(first.pid, 1000);
  }
});

test('a lease whose wrapper is gone is taken at once, fresh as it still is (a wrapper ended on Windows lets nothing go)', async () => {
  const d = dir();
  const lease = join(d, 'session.lease');
  const first = start(node('setTimeout(() => {}, 30000)'), { lease });
  await until(() => read(lease)?.holder?.child);
  const child = read(lease).holder.child;
  process.kill(first.pid, 'SIGKILL');
  await ended(first);
  try {
    const r = run(node('process.exit(0)'), { lease });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(lease), null);
  } finally {
    // On macOS and Linux a KILL to the wrapper alone leaves its command running.
    if (alive(child)) process.kill(child);
  }
});

test('a command that cannot start ends the wrapper with 127, saying why, and its lease is let go', () => {
  const d = dir();
  const lease = join(d, 'job');
  const r = run([join(d, 'no-such-program')], { lease });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no-such-program cannot start/);
  assert.equal(read(lease), null);
});

test('killTree of a wrapper ends its command and the command\'s own child, on every OS, and its lease holds no live holder after', async () => {
  const d = dir();
  const lease = sessionLease(d, 'abc');
  const pidFile = join(d, 'grandchild.pid');
  const wrapper = start(node(PARENT, pidFile), { lease });
  const exit = ended(wrapper);
  await until(() => pidIn(pidFile) && read(lease)?.holder?.child);
  const child = read(lease).holder.child;
  const grandchild = pidIn(pidFile);
  assert.ok(live(lease), 'live while the wrapper runs');
  await killTree(wrapper.pid, 2000);
  await exit;
  await until(() => !alive(child) && !alive(grandchild), 3000).catch(() => {});
  assert.equal(alive(wrapper.pid), false, 'the wrapper is gone');
  assert.equal(alive(child), false, 'its command is gone');
  assert.equal(alive(grandchild), false, 'the command\'s child is gone');
  assert.equal(live(lease), null, 'no live holder: let go on macOS and Linux, its holder gone on Windows');
});

// npm's shim of a Node program as npm writes it on Windows (cmd-shim), naming node_modules\fake\cli.js beside it.
const CMD_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*',
].join('\r\n');

test('on Windows a program npm installed ends with its wrapper: programArgv starts node and the script its shim names, no Git Bash between (asilak/kirunak-cross-platform S-9)', { skip: process.platform !== 'win32' && 'npm writes a .cmd shim on Windows alone' }, async () => {
  const d = dir();
  mkdirSync(join(d, 'node_modules', 'fake'), { recursive: true });
  writeFileSync(join(d, 'fake.cmd'), CMD_SHIM);
  writeFileSync(join(d, 'fake'), '#!/bin/sh\nexec node "$(dirname "$0")/node_modules/fake/cli.js" "$@"\n');
  writeFileSync(join(d, 'node_modules', 'fake', 'cli.js'), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 30000);");
  const pidFile = join(d, 'cli.pid');
  const argv = programArgv(['fake', pidFile], { env: { ...process.env, PATH: `${d};${process.env.PATH}` } });
  assert.deepEqual(argv.slice(1), [join(d, 'node_modules', 'fake', 'cli.js'), pidFile], 'node and the script the shim names');
  const wrapper = start(argv);
  const exit = ended(wrapper);
  await until(() => pidIn(pidFile));
  const cli = pidIn(pidFile);
  await killTree(wrapper.pid, 2000);
  await exit;
  await until(() => !alive(cli), 3000).catch(() => {});
  assert.equal(alive(cli), false, 'the program is gone with its wrapper');
});

// asilak/kirunak-kill-tree-windows: Claude Code's Bash tool runs each command through Git Bash, whose children break
// away from Node's job object, so the wrapper's end alone left them running (cmd, PowerShell, wsl.exe on 2026-11-03).
test('on Windows killTree of a wrapper ends what its session started through Git Bash, and what that started in turn (AC-3, AC-6 as amendment A-1 words them)', { skip: process.platform !== 'win32' && 'only Windows lets a process break away from its tree; macOS and Linux end it by its group' }, async () => {
  const d = dir();
  writeFileSync(join(d, 'child.js'), "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 30000);");
  // The session runs one Bash-tool command: node straight from Git Bash, and node under cmd.exe from Git Bash.
  const command = 'node child.js bash.pid & cmd //c "node child.js cmd.pid" & wait';
  const session = `require('child_process').spawn(${JSON.stringify(shell())}, ['-c', ${JSON.stringify(command)}], { cwd: ${JSON.stringify(d)}, stdio: 'ignore' }); setTimeout(() => {}, 30000);`;
  const wrapper = start(node(session));
  const exit = ended(wrapper);
  await until(() => pidIn(join(d, 'bash.pid')) && pidIn(join(d, 'cmd.pid')), 15000);
  const started = [pidIn(join(d, 'bash.pid')), pidIn(join(d, 'cmd.pid'))];
  await killTree(wrapper.pid, 2000);
  await exit;
  await until(() => started.every((p) => !alive(p)), 5000).catch(() => {});
  assert.deepEqual(started.map((p) => alive(p)), [false, false], 'node from Git Bash and node from its cmd.exe are gone');
});

test('E-8: a wrapper whose lease was taken over while its machine slept gives way: its command is ended and it exits', async () => {
  const d = dir();
  const lease = join(d, 'job');
  const pidFile = join(d, 'grandchild.pid');
  const wrapper = start(node(PARENT, pidFile), { lease, everyMs: 50 });
  const exit = ended(wrapper);
  await until(() => pidIn(pidFile) && read(lease)?.holder?.child);
  const child = read(lease).holder.child;
  // Another taker found it stale and took it over.
  rmSync(lease, { recursive: true, force: true });
  const t0 = Date.now();
  await exit;
  assert.ok(Date.now() - t0 < 5000, `gave way in ${Date.now() - t0} ms`);
  await until(() => !alive(child) && !alive(pidIn(pidFile)), 3000).catch(() => {});
  assert.equal(alive(child), false, 'its command is ended');
  assert.equal(alive(pidIn(pidFile)), false, 'and the command\'s child');
});

test('a wrapper with no command, or a lease named with no path, refuses with 2', () => {
  const [bin, wrap] = wrapped([]);
  assert.equal(spawnSync(bin, [wrap, '--']).status, 2);
  assert.equal(spawnSync(bin, [wrap, '--lease']).status, 2);
});

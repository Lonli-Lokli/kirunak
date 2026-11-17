// What differs between operating systems (lib/os.mjs): each reader of processPaths() over a fake `run` or a fake
// /proc, the platform's fold of paths, and the shell a step's command runs through.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandArgv, fold, insidePath, inUse, NO_SHELL, processPaths, readerName, samePath, shell } from '../lib/os.mjs';
import { tempDir } from './helpers.mjs';

// A fake `run` that answers every call with `result` and records the calls.
function fake(result) {
  const calls = [];
  const run = (cmd, args, opts) => (calls.push({ cmd, args, opts }), result);
  return { run, calls };
}

test("darwin: lsof's -F output, each process's cwd and txt; null when lsof fails or prints nothing", () => {
  const out = ['p101', 'czsh', 'fcwd', 'n/Users/a/src/app', 'ftxt', 'n/bin/zsh', 'p202', 'cnode', 'ftxt', 'n/Users/a/src/app/node', ''].join('\n');
  const { run, calls } = fake({ status: 0, stdout: out });
  assert.deepEqual(processPaths({ platform: 'darwin', run }), [
    { pid: 101, command: 'zsh', kind: 'cwd', path: '/Users/a/src/app' },
    { pid: 101, command: 'zsh', kind: 'txt', path: '/bin/zsh' },
    { pid: 202, command: 'node', kind: 'txt', path: '/Users/a/src/app/node' },
  ]);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args, c.opts.timeout]), [['lsof', ['-w', '-d', 'cwd,txt', '-F', 'pcfn'], 60_000]]);
  assert.equal(processPaths({ platform: 'darwin', run: fake({ error: new Error('spawnSync lsof ENOENT') }).run }), null);
  assert.equal(processPaths({ platform: 'darwin', run: fake({ status: 0, stdout: '' }).run }), null);
  assert.equal(readerName('darwin'), 'lsof');
});

test('AC-6: linux reads /proc/<pid>/cwd and exe, its command from comm; an entry it cannot read is skipped; null with no /proc', () => {
  const proc = tempDir('kirunak-proc-');
  const entry = (pid, comm, links) => {
    mkdirSync(join(proc, pid));
    if (comm !== null) writeFileSync(join(proc, pid, 'comm'), `${comm}\n`);
    for (const [name, target] of Object.entries(links)) symlinkSync(target, join(proc, pid, name));
  };
  entry('7', 'bash', { cwd: '/home/a/src/app', exe: '/usr/bin/bash' });
  entry('8', 'sshd', {}); // another user's: its links cannot be read
  entry('9', null, { cwd: '/tmp' }); // gone since the listing
  entry('self', 'bash', { cwd: '/home/a' });
  writeFileSync(join(proc, 'uptime'), '1 1\n');
  const run = () => assert.fail('no program runs on linux');
  const list = processPaths({ platform: 'linux', run, procRoot: proc });
  assert.deepEqual(list, [
    { pid: 7, command: 'bash', kind: 'cwd', path: '/home/a/src/app' },
    { pid: 7, command: 'bash', kind: 'exe', path: '/usr/bin/bash' },
  ]);
  assert.equal(processPaths({ platform: 'linux', run, procRoot: join(proc, 'missing') }), null);
  assert.equal(readerName('linux'), '/proc');
});

const PS = (list) => ({ status: 0, stdout: JSON.stringify(list) });

test('AC-3: win32 makes one PowerShell call and reads each process as exe and cmdline; one process alone is a list of one', () => {
  const { run, calls } = fake(
    PS([
      { ProcessId: 4, Name: 'System', ExecutablePath: null, CommandLine: null },
      { ProcessId: 120, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" D:\\src\\app\\serve.js' },
      { ProcessId: 130, Name: 'cmd.exe', ExecutablePath: 'C:\\Windows\\System32\\cmd.exe', CommandLine: null },
    ]),
  );
  assert.deepEqual(processPaths({ platform: 'win32', run }), [
    { pid: 120, command: 'node.exe', kind: 'exe', path: 'C:\\Program Files\\nodejs\\node.exe' },
    { pid: 120, command: 'node.exe', kind: 'cmdline', text: '"C:\\Program Files\\nodejs\\node.exe" D:\\src\\app\\serve.js' },
    { pid: 130, command: 'cmd.exe', kind: 'exe', path: 'C:\\Windows\\System32\\cmd.exe' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell');
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
  ]);
  assert.equal(calls[0].opts.timeout, 60_000, 'a minute at most');
  const one = processPaths({ platform: 'win32', run: fake(PS({ ProcessId: 9, Name: 'app.exe', ExecutablePath: 'D:\\src\\app\\app.exe', CommandLine: null })).run });
  assert.deepEqual(one, [{ pid: 9, command: 'app.exe', kind: 'exe', path: 'D:\\src\\app\\app.exe' }]);
  assert.equal(readerName('win32'), 'PowerShell');
});

test('AC-9: win32 gives null when PowerShell fails to start, exits non-zero, times out or prints what is not JSON', () => {
  const nul = (result) => processPaths({ platform: 'win32', run: fake(result).run });
  assert.equal(nul({ error: Object.assign(new Error('spawnSync powershell ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' }), null, 'fails to start');
  assert.equal(nul({ status: 1, stdout: '', stderr: 'Get-CimInstance : Access denied' }), null, 'exits non-zero');
  assert.equal(nul({ error: Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '[{"Proc' }), null, 'times out');
  assert.equal(nul({ status: 0, stdout: 'WARNING: something\r\n' }), null, 'junk');
  assert.equal(nul({ status: 0, stdout: '' }), null, 'nothing');
  assert.equal(nul({ status: 0, stdout: '42' }), null, 'JSON, but no process');
});

test('E-2: on win32 paths compare in any case with either slash, and a longer name is another folder', () => {
  assert.equal(fold('D:\\Sources\\App', 'win32'), 'd:/sources/app');
  assert.ok(samePath('D:\\Sources\\App', 'd:/sources/app', 'win32'));
  assert.ok(insidePath('d:/sources/app/x', 'D:\\Sources\\App', 'win32'));
  assert.ok(insidePath('D:\\sources\\app', 'd:/sources/app/', 'win32'));
  assert.equal(insidePath('D:\\sources\\app-capture', 'D:\\sources\\app', 'win32'), false);
  assert.equal(insidePath('D:\\sources\\app-capture\\x', 'D:\\sources\\app', 'win32'), false);
  assert.ok(samePath('/Users/A/App', '/users/a/app', 'darwin'), 'macOS ignores case');
  assert.equal(samePath('/home/a/App', '/home/a/app', 'linux'), false, 'Linux does not');
  assert.equal(samePath('a\\b', 'a/b', 'darwin'), false, 'a backslash is a name on macOS');
  assert.equal(insidePath('/home/a/app-2', '/home/a/app', 'linux'), false);
});

test('A-1: inUse moves a folder aside and back only on win32, and names a refusal', () => {
  const moves = [];
  const rename = (from, to) => moves.push([from, to]);
  assert.equal(inUse('/src/app', { platform: 'darwin', rename }), null);
  assert.equal(inUse('/src/app', { platform: 'linux', rename }), null);
  assert.deepEqual(moves, [], 'off Windows processPaths() tells');
  assert.equal(inUse('D:\\src\\app', { platform: 'win32', rename }), null);
  assert.deepEqual(moves, [['D:\\src\\app', 'D:\\src\\app.kirunak-removing'], ['D:\\src\\app.kirunak-removing', 'D:\\src\\app']]);
  const busy = () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  };
  assert.equal(inUse('D:\\src\\app', { platform: 'win32', rename: busy }), 'Windows refuses to move it (EBUSY): a process works in it');
});

test('AC-9, E-6: shell() is /bin/sh off win32; on win32 Git Bash from CLAUDE_CODE_GIT_BASH_PATH, else from the install git --exec-path names; none says install Git for Windows', () => {
  const never = () => assert.fail('no program runs');
  for (const platform of ['darwin', 'linux']) assert.equal(shell({ platform, run: never }), '/bin/sh');
  const files = new Set();
  const exists = (p) => files.has(p);
  const git = (stdout, status = 0) => {
    const run = (cmd, args) => (run.calls.push([cmd, ...args]), { status, stdout });
    run.calls = [];
    return run;
  };
  // The variable, when it names a file; git is not asked.
  files.add('D:\\tools\\Git\\bin\\bash.exe');
  assert.equal(shell({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\Git\\bin\\bash.exe' }, run: never, exists }), 'D:\\tools\\Git\\bin\\bash.exe');
  // A variable naming no file, or none: the install three folders above git's exec path, its bin\bash.exe first.
  files.clear();
  files.add('C:\\Program Files\\Git\\bin\\bash.exe');
  files.add('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  const run = git('C:/Program Files/Git/ucrt64/libexec/git-core\n');
  assert.equal(shell({ platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\gone\\bash.exe' }, run, exists }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(run.calls, [['git', '--exec-path']]);
  files.clear();
  files.add('C:\\Users\\me\\Git\\usr\\bin\\bash.exe');
  assert.equal(shell({ platform: 'win32', env: {}, run: git('C:\\Users\\me\\Git\\mingw64\\libexec\\git-core'), exists }), 'C:\\Users\\me\\Git\\usr\\bin\\bash.exe');
  // None: git fails, git cannot start, or its install has no bash.exe (WSL's System32 one is never taken).
  files.clear();
  files.add('C:\\Windows\\System32\\bash.exe');
  for (const r of [git('', 1), () => ({ status: null, error: new Error('spawnSync git ENOENT') }), git('C:/Program Files/Git/ucrt64/libexec/git-core')]) {
    assert.throws(() => shell({ platform: 'win32', env: {}, run: r, exists }), (e) => e.code === 'ENOSHELL' && e.message.startsWith(`${NO_SHELL} (`));
  }
  assert.equal(NO_SHELL, 'no POSIX shell: install Git for Windows');
});

test('AC-9: on this machine the shell runs a command, `echo ok > out.txt` writing its file; on win32 a .cmd shim named with its extension runs through it', () => {
  const dir = tempDir('kirunak-shell-');
  const sh = shell();
  if (process.platform === 'win32') assert.match(sh, /\\(usr\\)?bin\\bash\.exe$/i);
  else assert.equal(sh, '/bin/sh');
  const r = spawnSync(sh, ['-c', 'echo ok > out.txt'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'ok\n');
  if (process.platform !== 'win32') return;
  writeFileSync(join(dir, 'hello.cmd'), '@echo shim ran %1\r\n');
  const s = spawnSync(sh, ['-c', './hello.cmd world'], { cwd: dir, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.stdout.trim(), 'shim ran world');
});

test('AC-7, E-1: commandArgv runs one word as a command line and more as a program with its arguments; on win32 an .exe or .com straight, found on PATH, else through the shell', () => {
  const sh = '/bin/sh';
  assert.deepEqual(commandArgv(['make && make test'], { platform: 'linux', sh }), [sh, '-c', 'make && make test']);
  assert.deepEqual(commandArgv(['npm', 'test', '/x'], { platform: 'darwin', sh }), [sh, '-c', 'exec "$0" "$@"', 'npm', 'test', '/x']);
  const w = String.raw;
  const bash = w`C:\Git\bin\bash.exe`;
  const node = w`C:\node\node.exe`;
  const files = new Set([node, w`C:\node\npm.cmd`, w`C:\tools\gradle.com`, w`D:\w\bin\run.exe`]);
  const win = { platform: 'win32', env: { PATH: w`C:\tools;C:\node` }, exists: (p) => files.has(p), cwd: w`D:\w`, sh: bash };
  assert.deepEqual(commandArgv(['node', '--test', '/x'], win), [node, '--test', '/x'], 'an .exe straight, its arguments as given');
  assert.deepEqual(commandArgv(['gradle', 'build'], win), [w`C:\tools\gradle.com`, 'build'], '.com before .exe, the PATH folders in turn');
  assert.deepEqual(commandArgv(['bin/run.exe', 'a'], win), [w`D:\w\bin\run.exe`, 'a'], 'a path from the folder it runs in');
  assert.deepEqual(commandArgv([node, '-v'], win), [node, '-v']);
  assert.deepEqual(commandArgv(['npm', 'test'], win), [bash, '-c', 'exec "$0" "$@"', 'npm', 'test'], 'a .cmd shim through the shell');
  assert.deepEqual(commandArgv(['./gradlew.bat', 'test'], win), [bash, '-c', 'exec "$0" "$@"', './gradlew.bat', 'test']);
  assert.deepEqual(commandArgv(['node -v'], win), [bash, '-c', 'node -v'], 'one word is a command line on win32 too');
  assert.deepEqual(commandArgv(['node', '-v'], { ...win, env: { Path: w`C:\node` } }), [node, '-v'], 'Path as Windows spells it');
});

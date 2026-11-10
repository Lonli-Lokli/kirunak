// What differs between operating systems (lib/os.mjs): each reader of processPaths() over a fake `run` or a fake
// /proc, and the platform's fold of paths.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, insidePath, inUse, processPaths, readerName, samePath } from '../lib/os.mjs';

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
  const proc = mkdtempSync(join(tmpdir(), 'kirunak-proc-'));
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

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// What differs between operating systems, in one place: this is the file that branches on `process.platform`. Every
// function takes the platform as its last word, default this machine's, so a test can be any of them.

const runSync = (cmd, args, { timeout }) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout, windowsHide: true });

// A path as the platform compares it: in any case on macOS and Windows, whose volumes ignore it, and on Windows with
// `\` read as `/`.
export function fold(path, platform = process.platform) {
  if (platform === 'win32') return path.replaceAll('\\', '/').toLowerCase();
  return platform === 'darwin' ? path.toLowerCase() : path;
}

export const samePath = (a, b, platform = process.platform) => fold(a, platform) === fold(b, platform);

// Whether `path` is `dir` or inside it, so /src/app is never inside /src/app-capture.
export function insidePath(path, dir, platform = process.platform) {
  const p = fold(path, platform);
  const d = fold(dir, platform).replace(/\/+$/, '');
  return p === d || p.startsWith(d + '/');
}

// What processPaths() reads on the platform, as a kept line names it.
export const readerName = (platform = process.platform) => (platform === 'win32' ? 'PowerShell' : platform === 'linux' ? '/proc' : 'lsof');

const LOOK_MS = 60_000;

// lsof's -F output: the folder each process works in (cwd) and what it runs from (txt).
function fromLsof(run) {
  const r = run('lsof', ['-w', '-d', 'cwd,txt', '-F', 'pcfn'], { timeout: LOOK_MS });
  if (r.error || !r.stdout) return null;
  const list = [];
  let p = {};
  let kind = null;
  for (const line of r.stdout.split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') p = { pid: Number(value) };
    else if (line[0] === 'c') p.command = value;
    else if (line[0] === 'f') kind = value === 'cwd' ? 'cwd' : 'txt';
    else if (line[0] === 'n' && kind) list.push({ ...p, kind, path: value });
  }
  return list;
}

// /proc/<pid>/cwd and /proc/<pid>/exe of every process; a link that cannot be read (another user's process, one gone
// since the listing) is skipped.
function fromProc(procRoot) {
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const list = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(procRoot, name);
    let command;
    try {
      command = readFileSync(join(dir, 'comm'), 'utf8').trim();
    } catch {
      continue;
    }
    for (const [link, kind] of [['cwd', 'cwd'], ['exe', 'exe']]) {
      try {
        list.push({ pid: Number(name), command, kind, path: readlinkSync(join(dir, link)) });
      } catch {
        // not ours to read, or gone
      }
    }
  }
  return list;
}

// One `Get-CimInstance Win32_Process` call: each process's ExecutablePath and CommandLine, when it has them. Windows
// gives no other process's current folder: a removal it refuses is what tells.
const CIM = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
function fromPowerShell(run) {
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', CIM], { timeout: LOOK_MS });
  if (r.error || r.status !== 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const list = [];
  for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!p || typeof p !== 'object') continue;
    const base = { pid: p.ProcessId, command: p.Name };
    if (p.ExecutablePath) list.push({ ...base, kind: 'exe', path: p.ExecutablePath });
    if (p.CommandLine) list.push({ ...base, kind: 'cmdline', text: p.CommandLine });
  }
  return list;
}

// What every process works in, runs from or names: [{ pid, command, kind, path }] with kind 'cwd', 'txt' (lsof) or
// 'exe' (/proc, PowerShell), and on Windows also [{ pid, command, kind: 'cmdline', text }]. Files merely open are left
// out: Spotlight and the like open them for moments, which would keep worktrees at random. Null when the reader
// (readerName) cannot tell within a minute. `run(cmd, args, { timeout })` and `procRoot` are for tests.
export function processPaths({ platform = process.platform, run = runSync, procRoot = '/proc' } = {}) {
  if (platform === 'win32') return fromPowerShell(run);
  if (platform === 'linux') return fromProc(procRoot);
  return fromLsof(run);
}

import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { freemem } from 'node:os';
import { join, posix, win32 } from 'node:path';

// What differs between operating systems, in one place: this is the file that branches on `process.platform`, and the
// only one that signals, lists or asks about a process or names a shell (asilak/kirunak-cross-platform AC-1, AC-2).
// Every function takes the platform as its last word, default this machine's, so a test can be any of them.

// node:child_process loads on the first call that runs a program, so a hook that imports this file for a path or a
// pattern pays nothing for it.
const cp = () => createRequire(import.meta.url)('node:child_process');

const runSync = (cmd, args, { timeout }) => cp().spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout, windowsHide: true });

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

// The platform's own path functions (join, resolve), which write `\` on Windows.
export const pathOf = (platform = process.platform) => (platform === 'win32' ? win32 : posix);

// A text file kirunak reads as a template, its CRLF line endings turned into LF: a Windows clone made before the
// .gitattributes, or a file copied in by hand, can hold CRLF, and every pattern over a template expects LF.
export const readText = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

// A hook file of kirunak's as a command line names it, written on any platform: a folder named `hooks` (the whole
// name: myhooks/ is another tool's), either separator after it, any number of them (k install's quotes double each
// backslash on Windows), then the file. Every check of kirunak's own hooks in a settings file is built here.
const HOOKS_DIR = String.raw`(?:^|[\s"'\\/])hooks[\\/]+`;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The command of the hook `file`, its closing quote, `tail` (the compact hook's ` --part plan`), and nothing after.
export const hookCommand = (file, tail = '') => new RegExp(`${HOOKS_DIR}${literal(file)}["']?${literal(tail)}$`);

// The hook `file` anywhere in a line (a status line command or the script it runs), its name whole.
export const hookIn = (file) => new RegExp(`${HOOKS_DIR}${literal(file)}(?![\\w.-])`);

// Any of kirunak's own hook commands: [, file, tail], so copies of one can be counted.
export const KIRUNAK_HOOK = new RegExp(String.raw`${HOOKS_DIR}(kirunak-[\w-]+\.mjs)["']?(.*)$`);

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

// Whether a process works in the folder, where only a refusal can tell (Windows, whose processes' current folders
// cannot be read): the folder is moved aside and straight back, which Windows refuses while any process works in it
// or holds a file in it. Null when it moved and came back, or off Windows, where processPaths() tells; else why it
// stays. `rename` is for tests.
export function inUse(path, { platform = process.platform, rename = renameSync } = {}) {
  if (platform !== 'win32') return null;
  const aside = `${path}.kirunak-removing`;
  if (existsSync(aside)) return `${aside} is in the way of moving it aside to see whether a process works in it`;
  try {
    rename(path, aside);
  } catch (e) {
    return `Windows refuses to move it (${e.code || e.message}): a process works in it`;
  }
  try {
    rename(aside, path);
  } catch (e) {
    return `moved to ${aside} to see whether a process works in it, and Windows refuses to move it back to ${path} (${e.code || e.message}): move it back by hand`;
  }
  return null;
}

// --- Processes: the one place kirunak signals, lists or asks about a process (asilak/kirunak-cross-platform AC-1, AC-2) ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pid this user cannot signal (EPERM) is not alive: nothing of kirunak's runs as another user, so it is never ours,
// and waiting for it would be waiting for ever.
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A pid of 0 or 1 would name this process's own group or every process: never a job's group.
export const isGroup = (pid) => Number.isInteger(pid) && pid > 1;

// A group this user cannot signal (EPERM) is no job's or claude's of kirunak's and could not be killed anyway: not
// alive, as alive() says of a single pid.
export const groupAlive = (pid) => {
  if (!isGroup(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ps's elapsed time, [[dd-]hh:]mm:ss (the same on macOS and Linux, whatever the locale), in seconds.
const elapsed = (s) => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
};

// A pid read from a file may name another process by now (pids are reused). True only while pid runs and started
// within slackMs of startIso: now less its elapsed time is its start. No start recorded, or no such process (ps exits
// 1), is false. Null when ps could not answer (it did not start, failed otherwise, or printed no elapsed time): the
// pid may be that process or another, so callers neither kill it nor read it as gone.
// A minute of slack: a start recorded late by a fork or a write on a loaded machine must still match, and a pid is
// not reused within a minute of the start of the process that held it.
export function isStill(pid, startIso, slackMs = 60000) {
  const recorded = Date.parse(startIso);
  if (!isGroup(pid) || Number.isNaN(recorded)) return false;
  const ps = cp().spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.status === 1) return false;
  const s = ps.status === 0 ? elapsed(ps.stdout) : null;
  if (s === null) return null;
  return Math.abs(Date.now() - s * 1000 - recorded) <= slackMs;
}

// Every process now, from one `ps`: pid, ppid, pgid and its start (now less its elapsed time, in ms). Null when ps
// cannot answer.
function processes() {
  const ps = cp().spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime='], { encoding: 'utf8' });
  if (ps.status !== 0) return null;
  const now = Date.now();
  const all = [];
  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid, pgid, etime] = line.trim().split(/\s+/);
    const s = etime ? elapsed(etime) : null;
    if (s !== null) all.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), start: now - s * 1000 });
  }
  return all;
}

// The processes of the group pid leads and every descendant of theirs, whatever its group: a child may start one
// in a group of its own (Claude Code does, for a background Bash job), which a kill of -pid misses and which, once
// its parent dies, is reparented and no descendant any more. So they are found before the first signal.
function treeOf(all, roots) {
  const kids = new Map();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
  const found = new Map(all.filter((p) => roots.has(p.pgid) || roots.has(p.pid)).map((p) => [p.pid, p]));
  for (const p of found.values()) for (const k of kids.get(p.pid) || []) if (!found.has(k.pid)) found.set(k.pid, k);
  return found;
}

// TERM to the process group and to every descendant found (each pid, and each group one of them leads), then KILL
// after graceMs to what is left, again looking for descendants started meanwhile. A pid whose start is not the one
// found is another process by now (pids are reused) and is not signalled; this process's own group never is.
export async function killTree(pid, graceMs = 10000) {
  if (!isGroup(pid)) return;
  const own = new Set([process.pid, process.ppid]);
  const ownGroup = processes()?.find((p) => p.pid === process.pid)?.pgid;
  let tree = treeOf(processes() || [], new Set([pid]));
  const send = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {}
    for (const p of tree.values()) {
      if (own.has(p.pid)) continue;
      if (p.pgid === p.pid && p.pid !== ownGroup && isGroup(p.pid)) {
        try {
          process.kill(-p.pid, signal);
        } catch {}
      }
      try {
        process.kill(p.pid, signal);
      } catch {}
    }
  };
  // The tree as it is now: what still runs with the start it was found with, and its descendants since.
  const still = () => {
    const all = processes();
    if (!all) return tree;
    const now = new Map(all.map((p) => [p.pid, p]));
    const kept = new Set([pid, ...[...tree.values()].filter((p) => now.has(p.pid) && Math.abs(now.get(p.pid).start - p.start) <= 2000).map((p) => p.pid)]);
    return treeOf(all, kept);
  };
  send('SIGTERM');
  const until = Date.now() + graceMs;
  const left = () => groupAlive(pid) || [...tree.values()].some((p) => !own.has(p.pid) && alive(p.pid));
  while (left() && Date.now() < until) await sleep(50);
  if (left()) {
    tree = still();
    send('SIGKILL');
  }
}

// A signal to the process group pid leads; a group gone already, or this user's to signal no longer, is no error.
export function signalGroup(pid, signal) {
  if (!isGroup(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

// The POSIX shell a step's command runs through: `[shell(), '-c', command]`.
export const shell = () => '/bin/sh';

// `caffeinate -i -w <pid>` on macOS, which ends with the pid; elsewhere nothing. → its process, or null.
export function keepAwake(pid, { platform = process.platform, bin = 'caffeinate' } = {}) {
  if (platform !== 'darwin') return null;
  const child = cp().spawn(bin, ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

// The memory free now, in bytes.
export const freeMemory = () => freemem();

// One `ps -o <field> -p <pid>` field list of a process, trimmed (`ppid=,comm=`, `args=`). Throws when the process is
// gone or ps cannot answer.
export function processField(pid, field) {
  return cp().execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
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

// A path a tool call names (an Edit's file, a word of a Bash command) as the freeze hook compares it: on Windows
// folded, and a drive Git Bash writes as /c/ read as c:/ (E-2); elsewhere as written, macOS's case kept.
export function toolPath(path, platform = process.platform) {
  if (platform !== 'win32') return path;
  return fold(path, platform).replace(/^\/([a-z])(?:\/|$)/, '$1:/');
}

// A command line with the paths in it as the platform compares them, a git hook's line k install reads: on Windows
// folded, a run of separators read as one (k install's quotes double each backslash); elsewhere as written.
export function pathsIn(line, platform = process.platform) {
  if (platform !== 'win32') return line;
  return fold(line, platform).replace(/\/{2,}/g, '/');
}

// A folder as a git hook's sh names it in PATH, whose folders `:` parts: on Windows Git Bash's /c/x for C:\x, since a
// drive's colon would split it; elsewhere as it is.
export function shFolder(path, platform = process.platform) {
  if (platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/');
}

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

// What processPaths() reads on the platform, as a kept line names it; null on Windows, which is asked nothing.
export const readerName = (platform = process.platform) => (platform === 'win32' ? null : platform === 'linux' ? '/proc' : 'lsof');

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

// What every process works in or runs from: [{ pid, command, kind, path }] with kind 'cwd', 'txt' (lsof) or 'exe'
// (/proc). Files merely open are left out: Spotlight and the like open them for moments, which would keep worktrees at
// random. Null when the reader (readerName) cannot tell within a minute. On Windows nothing is asked (no Windows tool,
// asilak/kirunak-cross-platform AC-3, AC-10): the look is empty, which reads as no process named, and
// the session locks and the move aside (inUse) tell a worktree in use. `run(cmd, args, { timeout })` and `procRoot`
// are for tests.
export function processPaths({ platform = process.platform, run = runSync, procRoot = '/proc' } = {}) {
  if (platform === 'win32') return [];
  if (platform === 'linux') return fromProc(procRoot);
  return fromLsof(run);
}

// Whether a process works in the folder or runs from it, where only a refusal can tell (Windows, whose processes'
// current folders cannot be read). A program running from it, wherever it works, lets the folder move but keeps its
// file from being written or deleted, so a removal would stop halfway: each program file in it (PROGRAM) is opened
// for writing, nothing written, and EBUSY keeps it. Then the folder is moved aside and straight back, which Windows
// refuses while any process works in it or holds a file in it. Null when nothing refused, or off Windows, where
// processPaths() tells; else why it stays. `rename` and `open` are for tests.
export function inUse(path, { platform = process.platform, rename = renameSync, open = openSync } = {}) {
  if (platform !== 'win32') return null;
  const program = runningFrom(path, open);
  if (program) return `Windows refuses to open ${program} for writing (EBUSY): a program runs from it`;
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

// The files Windows maps while a program runs from them: a program, a library, a Node addon, a Python extension.
const PROGRAM = /\.(exe|dll|node|com|pyd)$/i;

// The first program file under `path`, at any depth, that Windows refuses to open for writing (EBUSY), as the path
// from `path` with `/`; null when none. A link is not followed: what it names is outside the folder.
function runningFrom(path, open) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(path, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(name);
      else if (e.isFile() && PROGRAM.test(e.name)) {
        try {
          closeSync(open(join(path, name), 'r+'));
        } catch (err) {
          if (err.code === 'EBUSY') return name;
        }
      }
    }
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

// Every process now, from one `ps` (macOS and Linux): pid, ppid and pgid. Null when ps cannot answer. No start time
// is read (asilak/kirunak-cross-platform AC-5).
function processes() {
  const ps = cp().spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (ps.status !== 0) return null;
  const all = [];
  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(pgid)) all.push({ pid, ppid, pgid });
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

// Ends the process tree pid leads, a session's or a job's wrapper (lib/wrap.mjs, asilak/kirunak-cross-platform AC-6).
// On Windows the pid itself is ended, and its end takes the children Node spawned attached (a job object); there is
// no grace, Windows having no TERM. On macOS and Linux: TERM to the process group and to every descendant found (each
// pid, and each group one of them leads), then KILL after graceMs to what is left, from a fresh listing by parentage
// of what was found and still is in the group it was found in (a pid reused since is in another group: a group's id
// is not given to a new process while the group lives), and of what those started meanwhile. This process and its
// own group are never signalled.
export async function killTree(pid, graceMs = 10000, { platform = process.platform } = {}) {
  if (!isGroup(pid) || pid === process.pid) return;
  if (platform === 'win32') return endProcess(pid, graceMs);
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
  // The tree as it is now: what still runs in the group it was found in, and its descendants since.
  const still = () => {
    const all = processes();
    if (!all) return tree;
    const now = new Map(all.map((p) => [p.pid, p]));
    const kept = new Set([pid, ...[...tree.values()].filter((p) => now.get(p.pid)?.pgid === p.pgid).map((p) => p.pid)]);
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

// Windows: the process ends at once, and with it what Node spawned under it attached; waited for up to graceMs.
async function endProcess(pid, graceMs) {
  try {
    process.kill(pid);
  } catch {
    return;
  }
  const until = Date.now() + graceMs;
  while (alive(pid) && Date.now() < until) await sleep(50);
}

// A signal to the process group pid leads; a group gone already, or this user's to signal no longer, is no error. On
// Windows, which has no groups, to the pid itself, a wrapper whose end takes its command (killTree).
export function signalGroup(pid, signal, { platform = process.platform } = {}) {
  if (!isGroup(pid) || pid === process.pid) return;
  try {
    process.kill(platform === 'win32' ? pid : -pid, signal);
  } catch {}
}

// The POSIX shell a step's command runs through: `[shell(), '-c', command]` (asilak/kirunak-cross-platform AC-9).
// /bin/sh on macOS and Linux. On Windows Git for Windows' bash.exe: CLAUDE_CODE_GIT_BASH_PATH when it names a file,
// as Claude Code reads it, else bin\bash.exe (or usr\bin\bash.exe) of the install `git --exec-path` names
// (<install>\<mingw64|ucrt64|...>\libexec\git-core). Never `where` or another Windows tool, and never C:\Windows\System32\bash.exe,
// which is WSL's. None found throws "no POSIX shell: install Git for Windows" (E-6). A .cmd shim runs through it when
// named with its extension (`hello.cmd`); a bare name finds what bash finds, as npm's own sh shim beside npm.cmd.
// The Windows answer is looked up once per process.
export const NO_SHELL = 'no POSIX shell: install Git for Windows';
let found;
export function shell({ platform = process.platform, env = process.env, run = runSync, exists = existsSync } = {}) {
  if (platform !== 'win32') return '/bin/sh';
  const mine = run === runSync && exists === existsSync && env === process.env;
  if (mine && found) return found;
  const bash = gitBash({ env, run, exists });
  if (!bash) {
    throw Object.assign(new Error(`${NO_SHELL} (CLAUDE_CODE_GIT_BASH_PATH names no file, and \`git --exec-path\` names no install with bin\\bash.exe)`), { code: 'ENOSHELL' });
  }
  if (mine) found = bash;
  return bash;
}

function gitBash({ env, run, exists }) {
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && exists(set)) return set;
  const r = run('git', ['--exec-path'], { timeout: 10000 });
  const core = r?.status === 0 ? String(r.stdout || '').trim() : '';
  if (!core) return null;
  const install = win32.dirname(win32.dirname(win32.dirname(win32.normalize(core))));
  return [win32.join(install, 'bin', 'bash.exe'), win32.join(install, 'usr', 'bin', 'bash.exe')].find((p) => exists(p)) ?? null;
}

// The argv that runs `words` as a command (`k heavy -- <command>`, asilak/kirunak-cross-platform AC-7). One word is a
// command line: `[shell(), '-c', line]`. More are a program and its arguments, passed whole. On Windows they go straight
// to the program when it is an .exe or .com, or npm's shim of a Node program, as node and its script (windowsStart), so
// it is the wrapper's own child and ends with it (killTree), and no shell rewrites an argument (E-1). Otherwise they go
// through the shell, `[shell(), '-c', 'exec "$0" "$@"', ...words]`, which finds the program as it finds any. `sh` and
// `read` are for tests.
export function commandArgv(words, { platform = process.platform, env = process.env, exists = existsSync, cwd = process.cwd(), sh = null, read = undefined } = {}) {
  if (words.length > 1 && platform === 'win32') {
    const start = windowsStart(words[0], { env, exists, cwd, read });
    if (start) return [...start, ...words.slice(1)];
  }
  const s = sh ?? shell({ platform, env, exists });
  return words.length === 1 ? [s, '-c', words[0]] : [s, '-c', 'exec "$0" "$@"', ...words];
}

// The argv that starts the program `words[0]` with the rest as its arguments, a session's `claude`
// (plugins/runner-claude.mjs): as given on macOS and Linux. On Windows, which starts only an .exe or .com by itself, by
// commandArgv's rule: claude.exe straight, npm's claude.cmd as node and its script, anything else (a script) through
// the shell, which finds it as Git Bash does. `sh` and `read` are for tests.
export function programArgv(words, { platform = process.platform, env = process.env, exists = existsSync, cwd = process.cwd(), sh = null, read = undefined } = {}) {
  if (platform !== 'win32') return words;
  const start = windowsStart(words[0], { env, exists, cwd, read });
  return start ? [...start, ...words.slice(1)] : [sh ?? shell({ platform, env, exists }), '-c', 'exec "$0" "$@"', ...words];
}

// What Windows starts for `name`, as the argv's first words, a path as named or a bare name in each folder of PATH in
// turn, each folder's .com, .exe and .cmd in that order: an .exe or .com itself; npm's shim of a Node program as node
// and its script (npmShim). Null for anything else: another .cmd, a .bat, a script, nothing found.
function windowsStart(name, { env, exists, cwd, read = (p) => readFileSync(p, 'utf8') }) {
  const ext = win32.extname(name).toLowerCase();
  const names = ['.exe', '.com', '.cmd'].includes(ext) ? [name] : ext ? [] : [`${name}.com`, `${name}.exe`, `${name}.cmd`];
  for (const dir of searchDirs(name, { env, cwd })) {
    for (const n of names) {
      const p = win32.resolve(dir, n);
      if (!exists(p)) continue;
      return p.toLowerCase().endsWith('.cmd') ? npmShim(p, { env, exists, cwd, read }) : [p];
    }
  }
  return null;
}

// npm's shim of a Node program (its cmd-shim): `<name>.cmd` that runs `"%_prog%"  "%dp0%\<script>" %*`, _prog the
// node.exe beside it, else node on PATH. Started as [node, script], the shim's own way with no cmd.exe between. Null for
// any other .cmd, or one that cannot be read.
function npmShim(cmd, { env, exists, cwd, read }) {
  let text;
  try {
    text = read(cmd);
  } catch {
    return null;
  }
  const m = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/.exec(text);
  if (!m) return null;
  const dir = win32.dirname(cmd);
  const beside = win32.join(dir, 'node.exe');
  return [exists(beside) ? beside : windowsProgram('node', { env, exists, cwd }) ?? process.execPath, win32.join(dir, m[1])];
}

// The folders a program name is looked for in on Windows: the folder it runs in for a path, else PATH's in turn.
const searchDirs = (name, { env, cwd }) => (/[\\/]/.test(name) ? [cwd] : String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean));

// The .exe or .com Windows starts for `name`: a path as named, or with .com or .exe added when it has no extension; a
// bare name in each folder of PATH in turn. Null for anything else: a .cmd or .bat, a script, nothing found.
function windowsProgram(name, { env, exists, cwd }) {
  const ext = win32.extname(name).toLowerCase();
  const names = ext === '.exe' || ext === '.com' ? [name] : ext ? [] : [`${name}.com`, `${name}.exe`];
  for (const dir of searchDirs(name, { env, cwd })) {
    for (const n of names) {
      const p = win32.resolve(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

// Keeps the machine from sleeping while pid runs (asilak/kirunak-cross-platform AC-12): on macOS
// `caffeinate -i -w <pid>`, which ends with the pid; on Linux, when systemd-inhibit is there, a sleep and idle
// inhibitor held by `tail --pid=<pid> -f /dev/null`, which ends with the pid too (where it is not, its spawn fails
// quietly and nothing holds the machine awake); on Windows nothing (O-6). → its process, or null. `spawn` is for tests.
export function keepAwake(pid, { platform = process.platform, spawn = (cmd, args, opts) => cp().spawn(cmd, args, opts) } = {}) {
  const argv =
    platform === 'darwin' ? ['caffeinate', '-i', '-w', String(pid)]
    : platform === 'linux' ? ['systemd-inhibit', '--what=sleep:idle', '--who=kirunak', '--why=Quad Damage runs', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null']
    : null;
  if (!argv) return null;
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

// The memory free now, in bytes (AC-11). On macOS and Linux os.freemem(). On Windows the commit left, Commit Limit less
// Committed Bytes: builds failed there for want of it while physical memory looked free (asilak/kirunak-memory-headroom,
// O-6 amended by the owner 2026-11-18). typeperf reads it, about two seconds; it names counters in Windows' display
// language, so where the English names are unknown, or it gives no answer, os.freemem(). `run` is for tests.
export function freeMemory({ platform = process.platform, run = runSync } = {}) {
  return (platform === 'win32' && commitLeft(run)) || freemem();
}

// typeperf's one sample, `"<time>","<committed>","<limit>"` after its header line: the limit less the committed, or
// null.
function commitLeft(run) {
  const r = run('typeperf', ['\\Memory\\Committed Bytes', '\\Memory\\Commit Limit', '-sc', '1'], { timeout: 15000 });
  if (r?.status !== 0) return null;
  const row = String(r.stdout || '').split(/\r?\n/).find((l) => /^"\d/.test(l));
  const [, used, limit] = (row?.match(/"[^"]*"/g) ?? []).map((s) => Number(s.slice(1, -1)));
  return Number.isFinite(used) && Number.isFinite(limit) && limit > used ? Math.round(limit - used) : null;
}

// One `ps -o <field> -p <pid>` field list of a process, trimmed (`ppid=,comm=`, `args=`). Throws when the process is
// gone or ps cannot answer. On Windows nothing is asked and it throws: Git's ps on PATH has no -o (E-1).
export function processField(pid, field, { platform = process.platform } = {}) {
  if (platform === 'win32') throw new Error('Windows is asked about no process');
  return cp().execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

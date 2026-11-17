import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { read as readLease, RENEW_MS, takeLive } from './lease.mjs';
import { killTree } from './os.mjs';

// The wrapper each session and heavy job runs under (asilak/kirunak-cross-platform AC-6), run with process.execPath:
// `wrap.mjs [--lease <dir>] [--every <ms>] -- <command> [<arg>...]`. It takes the lease it is given (lib/lease.mjs),
// runs the command attached with its own stdio, keeps the lease fresh while the command runs and lets it go at the
// end, exiting as the command did (128 and the signal's number when a signal ended it). The lease names the command's
// pid as `child`.
//
// Ending the wrapper ends the command's tree (killTree in lib/os.mjs). On macOS and Linux its caller starts it detached,
// so it leads a process group its command shares: the group's signals reach both, and it waits for the command, then
// lets go. On Windows its own end takes the command with it: Node puts each child it spawns attached in a job object
// that ends them when the parent ends, and a Node child's children likewise. A child something started detached, or
// one started by a program that is not Node (the commands Git Bash runs), outlives it there.
//
// A fresh lease says the command still runs and its pid is this wrapper's, with no start time read (AC-5). The wrapper
// refuses to run (exit HELD) while another live holder has the lease, and gives way, ending its command, once its
// lease was taken over while its machine slept (E-8).

export const WRAP = fileURLToPath(import.meta.url);
export const HELD = 75;
const CANNOT_START = 127;
const USAGE = 2;

// The lease a Claude session's wrapper holds while the session runs, by its id: what tells k run that a step's session
// still runs, and that its pid is still its wrapper.
export const sessionLease = (home, sessionId) => join(home, 'sessions', `${sessionId}.lease`);

// Removes the lease a wrapper left once its exit is seen, while the lease still names it: a wrapper ended on Windows
// lets nothing go.
export function leftBy(lease, pid) {
  if (lease && Number.isInteger(pid) && readLease(lease)?.holder?.pid === pid) rmSync(lease, { recursive: true, force: true });
}

// The argv that runs `command` (an argv) under the wrapper.
export const wrapped = (command, { lease = null, everyMs = null } = {}) => [
  process.execPath, WRAP, ...(lease ? ['--lease', lease] : []), ...(everyMs ? ['--every', String(everyMs)] : []), '--', ...command,
];

// Straight to fd 2, which the command shares: a stream on it would make the pipe non-blocking under the command.
const say = (text) => {
  try {
    writeSync(2, `wrap: ${text}\n`);
  } catch {}
};

// → the exit code.
export async function main(argv) {
  let lease = null;
  let everyMs = RENEW_MS;
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    if (argv[i] === '--lease') lease = argv[++i] ?? '';
    else if (argv[i] === '--every') everyMs = Number(argv[++i]);
    else lease = '';
  }
  const command = argv.slice(i + 1);
  if (!command.length || lease === '' || !(everyMs > 0)) {
    say('usage: wrap.mjs [--lease <dir>] [--every <ms>] -- <command> [<arg>...]');
    return USAGE;
  }
  let held = null;
  if (lease) {
    mkdirSync(dirname(lease), { recursive: true });
    held = takeLive(lease, {});
    if (!held) {
      say(`${lease} is held by pid ${readLease(lease)?.holder?.pid ?? '?'}, whose command runs: this one does not start`);
      return HELD;
    }
  }
  return new Promise((resolve) => {
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      held?.release();
      resolve(code);
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true });
    } catch (e) {
      say(`${command[0]} cannot start: ${e.message}`);
      return end(CANNOT_START);
    }
    child.on('error', (e) => {
      say(`${command[0]} cannot start: ${e.message}`);
      end(CANNOT_START);
    });
    child.on('exit', (code, signal) => end(code ?? 128 + (constants.signals[signal] || 0)));
    if (!child.pid) return;
    if (held) {
      held.update({ child: child.pid });
      held.keep({
        everyMs,
        onLost: () => {
          say(`${lease} was taken over while this machine slept: its command is ended`);
          killTree(child.pid);
        },
      });
    }
    // A signal to the wrapper alone reaches its command too; one to the group reaches it twice, which ends it the same.
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === WRAP) main(process.argv.slice(2)).then((code) => process.exit(code));

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoLocal, logEvent } from './approval.mjs';
import { KError, refuse } from './errors.mjs';
import { list, pidRuns, quadDamagePath, quadDamageRun } from './bugs.mjs';
import { lock, unlock } from './bug-review.mjs';
import { oneLine } from './drafts.mjs';
import { logLimits } from './limits.mjs';
import { cut } from './notice.mjs';
import { parseId } from './workspace.mjs';

// Quad Damage (gulnya/quad-damage AC-1, AC-9, AC-10, AC-12, AC-13, E-2, E-3, E-4): `k bugs quad-damage`, the owner's
// verb, starts one detached run that takes the bugs marked `quad-damage: yes` one at a time, in the list's own order,
// each fixed and then reviewed while the plan's windows allow. The run file (bugs.mjs's quadDamagePath) says the run
// lives and which bug it is on; its folder $KIRUNAK_HOME/bugs/quad-damage/<started>/ keeps run.log, state.json and
// summary.md. Nothing of a run goes into a repo but what a bug's own work commits.

// The pid that hands the run file to the detached process doing the run.
export const RUN_ENV = 'KIRUNAK_QUAD_DAMAGE';
// The session label of the run's readings in the limits log.
export const LABEL = 'quad-damage';
// The 5-hour window at PAUSE_AT% or more pauses the run until its reset and a minute (AC-9); the week's at STOP_AT% or
// more stops it (AC-10).
export const PAUSE_AT = 90;
export const STOP_AT = 98;
const AFTER_RESET_MS = 60 * 1000;
// The kirunak-push line (AC-13): the summary's first line and each bug in a few words, cut where the hook that hands a
// push to the session cuts it (hooks/escalate-state.mjs's PUSH_MAX).
export const PUSH_MAX = 200;
const WHY_WORDS = 40;
const K = fileURLToPath(new URL('../bin/k.mjs', import.meta.url));

export const runsDir = (home) => join(home, 'bugs', 'quad-damage');
// The live run's state, { pid, started, by, via, folder, bug, phase, try, since, waitUntil }, or null (AC-12).
export const state = quadDamageRun;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// Written whole and renamed into place, so a reader never sees half a file.
function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n');
  renameSync(tmp, path);
}

// 14:05 of a time in a record (isoLocal's), or of a Date.
const hhmm = (t) => (t == null ? '?' : (typeof t === 'string' ? t : isoLocal(t)).slice(11, 16));

// A refusal of a run thrown out of the bug's work, or of the reading before a session: the run stops with `why`.
export class Stop extends Error {
  constructor(why) {
    super(why);
    this.why = why;
  }
}

// --- The run file (E-3) ---

const running = (r) => refuse(`Quad Damage runs already: pid ${r.pid}, started ${r.started ?? 'at a time not recorded'}, ` +
  `${r.bug ? `on ${r.bug} (${r.phase ?? 'starting'}${r.try ? `, try ${r.try}` : ''})` : 'between bugs'}; a second one waits ` +
  'until it ends, and k bugs quad-damage --status shows it');

// Takes the run file for `pid`, made with O_EXCL: refused while another live pid holds it, naming that run. A dead
// pid's file, or one that cannot be read, is taken over, and so is the file of `from`, the process that hands it on,
// keeping its start and folder. → the run's state.
export function claim(home, { pid = process.pid, from = null, via = 'shell', now = new Date() } = {}) {
  const path = quadDamagePath(home);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    if (!existsSync(path)) {
      const mine = { pid, started: isoLocal(now), by: 'owner', via, folder: null, bug: null, phase: null, try: null, since: null, waitUntil: null };
      try {
        writeFileSync(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
        return mine;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        continue;
      }
    }
    const held = readJson(path);
    if (held && (held.pid === pid || (from && held.pid === from))) {
      const mine = { ...held, pid };
      writeJson(path, mine);
      return mine;
    }
    if (held && pidRuns(held.pid)) throw running(held);
    rmSync(path, { force: true });
  }
  throw running(readJson(path) ?? { pid: '?' });
}

// Lets the run file go, only while it is `pid`'s.
export function release(home, pid = process.pid) {
  const path = quadDamagePath(home);
  if (readJson(path)?.pid === pid) rmSync(path, { force: true });
}

// A new run's folder, named by its start (filesystem-safe, local time): 2026-10-27T23-40-05, -2 after it when taken.
function folderFor(home, now) {
  const base = join(runsDir(home), isoLocal(now).slice(0, 19).replace(/:/g, '-'));
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

// The bugs a run takes, in the list's own order (AC-2): those marked `quad-damage: yes`.
export const marked = (ws, home = ws.home) => list(ws, { home }).filter((r) => r.quadDamage);

// --- Keeping the Mac awake (E-2) ---

// `caffeinate -i -w <pid>` on macOS, which ends with the pid; elsewhere nothing. → its process, or null.
export function keepAwake(pid, { platform = process.platform, bin = 'caffeinate' } = {}) {
  if (platform !== 'darwin') return null;
  const child = spawn(bin, ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// A lease (asilak/kirunak-cross-platform AC-4): who holds a lock or runs a registered process, told the same way on
// every OS. It is a directory made with mkdir, which is atomic everywhere, holding one JSON file that names its holder
// (an `id`, the `pid`, and whatever the caller adds). The holder touches that file every RENEW_MS on an unref'd timer.
// A lease untouched for STALE_MS is stale: its holder is gone or asleep, and the next taker takes it over (E-9). No
// process's start time is read (AC-5): a fresh lease is proof enough that its holder runs.
//
// A takeover and a late renewal each run inside a short mutex, the directory `<lease>.take`, so a holder whose machine
// slept past STALE_MS finds its lease either still its own, and touches it, or another's, and gives way (E-8): never
// two holders at once.

export const STALE_MS = 60_000;
export const RENEW_MS = 5_000;
const MUTEX_STALE_MS = 10_000;
const FILE = 'holder.json';

const parse = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

// The holder file is replaced whole, so a reader never sees half of it.
function writeHolder(path, holder) {
  writeFileSync(`${path}.tmp`, JSON.stringify(holder) + '\n');
  renameSync(`${path}.tmp`, path);
}

// { holder, touched, stale } of the lease at `dir`, or null when there is none. A directory whose holder file is not
// written yet counts from the directory's own time, so a taker that died between the two is stale in a minute too.
export function read(dir, { file = FILE, now = Date.now(), staleMs = STALE_MS } = {}) {
  const made = mtime(dir);
  if (made === null) return null;
  const path = join(dir, file);
  const holder = parse(path);
  const touched = mtime(path) ?? made;
  return { holder, touched, stale: now - touched > staleMs };
}

// Runs fn inside the mutex beside `dir`, or returns undefined when another holds it. A mutex left by a process that
// died goes after MUTEX_STALE_MS.
function inMutex(dir, fn) {
  const m = `${dir}.take`;
  try {
    mkdirSync(m);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = mtime(m);
    if (age !== null && Date.now() - age > MUTEX_STALE_MS) rmSync(m, { recursive: true, force: true });
    return undefined;
  }
  try {
    return fn();
  } finally {
    rmSync(m, { recursive: true, force: true });
  }
}

// Takes the lease at `dir` for `holder` (an `id` is made when it has none; `pid` defaults to this process): → the
// lease, or null while another holds it fresh. A stale lease is taken over. The lease is not kept fresh until
// lease.keep() starts its timer.
export function take(dir, holder = {}, { file = FILE, staleMs = STALE_MS } = {}) {
  const me = { id: randomUUID(), pid: process.pid, since: new Date().toISOString(), ...holder };
  const path = join(dir, file);
  const make = () => {
    try {
      mkdirSync(dir);
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    writeHolder(path, me);
    return true;
  };
  if (make()) return lease(dir, path, me, staleMs);
  const seen = read(dir, { file, staleMs });
  if (seen && !seen.stale) return null;
  const took = inMutex(dir, () => {
    const now = read(dir, { file, staleMs });
    if (now && (!now.stale || now.holder?.id !== seen?.holder?.id)) return false;
    rmSync(dir, { recursive: true, force: true });
    return make();
  });
  return took ? lease(dir, path, me, staleMs) : null;
}

function lease(dir, path, holder, staleMs) {
  let timer = null;
  let last = Date.now();
  const self = {
    dir,
    holder,
    lost: false,
    // Touches the lease while it is still this holder's: → true, false once another took it (lost), or null while a
    // takeover holds the mutex. A renewal that comes late, the lease stale by now, is decided inside that mutex (E-8).
    renew() {
      if (self.lost) return false;
      const touch = () => {
        if (parse(path)?.id !== holder.id) return false;
        const t = new Date();
        utimesSync(path, t, t);
        last = t.getTime();
        return true;
      };
      const late = Date.now() - last > staleMs / 2;
      const ok = late ? inMutex(dir, touch) : touch();
      if (ok === undefined) return null; // a takeover is deciding right now: not known yet, asked again next time
      if (!ok) {
        self.lost = true;
        self.stop();
      }
      return ok;
    },
    // Renews every `everyMs` on an unref'd timer, so the lease never keeps the process alive; onLost() is called once
    // another holder took it.
    keep({ everyMs = RENEW_MS, onLost } = {}) {
      self.stop();
      timer = setInterval(() => {
        if (self.renew() === false) onLost?.();
      }, everyMs);
      timer.unref();
      return self;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // Changes what the holder file says beside the id (a job's pid, say), while the lease is still this holder's.
    update(fields) {
      if (self.lost || parse(path)?.id !== holder.id) return false;
      Object.assign(holder, fields, { id: holder.id });
      writeHolder(path, holder);
      last = Date.now();
      return true;
    },
    // Lets the lease go: its directory goes while it is still this holder's.
    release() {
      self.stop();
      if (!self.lost && parse(path)?.id === holder.id) rmSync(dir, { recursive: true, force: true });
      self.lost = true;
    },
  };
  return self;
}

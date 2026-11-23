import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { alive } from './os.mjs';

// A lease (asilak/kirunak-cross-platform AC-4): who holds a lock or runs a registered process, told the same way on
// every OS. It is a directory made with mkdir, which is atomic everywhere, holding one JSON file that names its holder
// (an `id`, the `pid`, and whatever the caller adds). The holder touches that file every RENEW_MS from the keeper, a
// worker thread (below), so a long synchronous call on its main thread does not age it. A lease untouched for
// STALE_MS is stale: its holder is gone, asleep or hung, and the next taker takes it over (E-9). No process's start
// time is read (AC-5): a fresh lease is proof enough that its holder runs.
//
// A takeover and a late renewal each run inside a short mutex, the directory `<lease>.take`, so a holder whose machine
// slept past STALE_MS finds its lease either still its own, and touches it, or another's, and gives way (E-8): never
// two holders at once.

export const STALE_MS = 60_000;
export const RENEW_MS = 5_000;
// The keeper renews a lease only while the main thread has beaten within HUNG_MS: a merge's git calls block it for a
// minute or so, a hang for longer (asilak/kirunak-lease-stale-while-blocked).
export const HUNG_MS = 10 * 60_000;
const BEAT_MS = 1000;
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

// Windows refuses a rename over a file another process has open at that moment (EPERM, EACCES or EBUSY); a reader
// holds it open only for its read, so the rename is tried again, for up to a second.
const IN_USE = new Set(['EPERM', 'EACCES', 'EBUSY']);
function replace(tmp, path) {
  for (let tries = 0; ; tries++) {
    try {
      return renameSync(tmp, path);
    } catch (e) {
      if (process.platform !== 'win32' || !IN_USE.has(e.code) || tries >= 200) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

// A state file another process reads is written whole and renamed into place, so a reader never finds it empty or
// half written (asilak/kirunak-review-lock-read-empty).
export function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n');
  replace(tmp, path);
}

// A new state file, written whole and then linked to its name, which fails while the name exists: of two creators one
// wins, as with O_EXCL, and no reader finds it empty in between. → true, or false when the file exists.
export function createJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n');
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// The holder file is replaced whole, so a reader never sees half of it.
function writeHolder(path, holder) {
  writeFileSync(`${path}.tmp`, JSON.stringify(holder) + '\n');
  replace(`${path}.tmp`, path);
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

// --- A file held by a lease beside it (asilak/kirunak-cross-platform S-4) ---
// A lock or a registered process whose state is a file (k run's run file, the machine guard's running/ files, a
// bug's review lock, Quad Damage's run file) keeps that file where it was and is held by the lease `<file>.lease`, kept
// fresh by this process until it lets go. Its holder is alive while its pid answers and that lease is fresh; a file
// with no lease beside it, written before leases, is alive while its pid is (E-4).

const kept = new Map();
export const besideOf = (path) => `${path}.lease`;

// Takes the lease at `dir` as take() does, and also at once when its holder's pid is gone, is `from` (a lock handed
// on), or is the taker's own (a lock taken again), fresh or not: → the lease, or null while another live holder has it.
export function takeLive(dir, holder = {}, { from = null, isAlive = alive } = {}) {
  const l = take(dir, holder);
  if (l) return l;
  const pid = read(dir)?.holder?.pid;
  if (pid !== undefined && pid !== (holder.pid ?? process.pid) && (from === null || pid !== from) && isAlive(pid)) return null;
  rmSync(dir, { recursive: true, force: true });
  return take(dir, holder);
}

// The lease at `dir` while its holder lives: its pid answers (isAlive) and the lease is fresh. → read()'s answer, or
// null.
export function live(dir, { isAlive = alive } = {}) {
  const l = read(dir);
  return l && !l.stale && Number.isInteger(l.holder?.pid) && isAlive(l.holder.pid) ? l : null;
}

// Holds the lease beside `path` for `holder` (its `pid`, this process's by default) and keeps it fresh: → the lease,
// or null while another live holder has it. A lease whose holder's pid is gone, is `from` (a lock handed on), or is
// the holder's own (a lock taken again), is taken over at once, fresh or not.
export function hold(path, holder = {}, { from = null, everyMs = RENEW_MS, isAlive = alive } = {}) {
  const dir = besideOf(path);
  const l = takeLive(dir, holder, { from, isAlive });
  if (!l) return null;
  kept.get(dir)?.stop();
  kept.set(dir, l.keep({ everyMs }));
  return l;
}

// Lets go of the lease beside `path`, when this process holds it.
export function letGo(path) {
  const dir = besideOf(path);
  kept.get(dir)?.release();
  kept.delete(dir);
}

// Whether the holder `pid` of the file at `path` is alive: its pid answers (isAlive) and the lease beside the file is
// fresh, or, with no lease beside it, its pid alone (E-4).
export function holderLive(path, pid, { isAlive = alive } = {}) {
  if (!isAlive(pid)) return false;
  const l = read(besideOf(path));
  return !l || !l.stale;
}

// Touches the lease at `dir` while its holder file still names `id`: → true, false once another took it, or null while
// a takeover holds the mutex. A renewal that comes late (`last` more than half of staleMs ago), the lease maybe stale
// by now, is decided inside that mutex (E-8). The lease's renew() and the keeper both renew through it.
export function renewAt(dir, path, id, last, staleMs = STALE_MS) {
  const touch = () => {
    if (parse(path)?.id !== id) return false;
    const t = new Date();
    utimesSync(path, t, t);
    return true;
  };
  const ok = Date.now() - last > staleMs / 2 ? inMutex(dir, touch) : touch();
  return ok === undefined ? null : ok; // undefined: a takeover is deciding right now, asked again next time
}

// --- The keeper (asilak/kirunak-lease-stale-while-blocked) ---
// One worker thread a process (lib/lease-keeper.mjs) renews every lease it keeps, so a lease stays fresh while the
// main thread blocks: Quad Damage's merge runs git through execFileSync for up to a minute on Windows, which aged its
// run's lease past STALE_MS while the run lived. The main thread beats into shared memory every BEAT_MS, and the
// keeper renews a lease only while that beat is within the lease's hungMs. The worker is unref'd, so it never keeps
// the process alive; when no worker can start, or it dies, each lease falls back to a timer on the main thread.
let keeper = null;

function keeperOf() {
  if (keeper) return keeper;
  try {
    const beat = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(beat, 0, BigInt(Date.now()));
    const worker = new Worker(new URL('./lease-keeper.mjs', import.meta.url), { workerData: { beat: beat.buffer } });
    const timer = setInterval(() => Atomics.store(beat, 0, BigInt(Date.now())), BEAT_MS);
    timer.unref();
    const k = { worker, leases: new Map() };
    worker.on('message', (m) => k.leases.get(m.key)?.onMessage(m));
    const gone = () => {
      if (keeper !== k) return;
      keeper = null;
      clearInterval(timer);
      for (const l of k.leases.values()) l.fallback();
    };
    worker.on('error', gone);
    worker.on('exit', gone);
    // Last: a 'message' listener added after unref() refs the worker again, and it would keep the process alive.
    worker.unref();
    keeper = k;
    return k;
  } catch {
    return null;
  }
}

function lease(dir, path, holder, staleMs) {
  let timer = null;
  let key = null;
  let last = Date.now();
  const self = {
    dir,
    holder,
    lost: false,
    // Touches the lease while it is still this holder's: → true, false once another took it (lost), or null while a
    // takeover holds the mutex (renewAt).
    renew() {
      if (self.lost) return false;
      const ok = renewAt(dir, path, holder.id, last, staleMs);
      if (ok === true) last = Date.now();
      if (ok === false) {
        self.lost = true;
        self.stop();
      }
      return ok;
    },
    // Renews every `everyMs` from the keeper while the main thread has beaten within `hungMs`, or, with no keeper, on
    // an unref'd timer of this thread; never keeps the process alive. onLost() is called once another holder took it.
    keep({ everyMs = RENEW_MS, hungMs = HUNG_MS, onLost } = {}) {
      self.stop();
      const here = () => {
        key = null;
        if (self.lost) return;
        timer = setInterval(() => {
          if (self.renew() === false) onLost?.();
        }, everyMs);
        timer.unref();
      };
      const k = keeperOf();
      if (!k) {
        here();
        return self;
      }
      const mine = randomUUID();
      key = mine;
      k.leases.set(mine, {
        onMessage: (m) => {
          if (key !== mine) return;
          if (m.ok === true) last = m.last;
          else if (m.ok === false && !self.lost) {
            self.lost = true;
            self.stop();
            onLost?.();
          }
        },
        fallback: () => key === mine && here(),
      });
      k.worker.postMessage({ op: 'add', key: mine, dir, path, id: holder.id, everyMs, staleMs, hungMs, last });
      return self;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (key && keeper?.leases.delete(key)) keeper.worker.postMessage({ op: 'remove', key });
      key = null;
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

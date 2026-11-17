import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { refuse } from '../lib/errors.mjs';
import { kirunakHome } from '../lib/home.mjs';
import { read as readLease, RENEW_MS, take as takeLease } from '../lib/lease.mjs';
import { alive, groupAlive, isStill, killTree, signalGroup } from '../lib/os.mjs';
import { onStop } from '../lib/stop.mjs';

// The process calls live in lib/os.mjs (asilak/kirunak-cross-platform AC-1); these stay importable from here.
export { alive, groupAlive, isStill, killTree };

// The core's default `resourceGuard` (plugins.md §2): one heavy job at a time on this machine. The lock is
// guard/lock, a lease (lib/lease.mjs) whose holder file is owner.json; waiting jobs queue first in, first out in
// guard/queue, one JSON line each, each waiter holding its own lease in guard/waiting/<id>; every job appends a line to
// guard/log.jsonl; claims are in guard/claims.json. An owner or a waiter is alive while its pid answers kill 0 and its
// lease is fresh, so a pid another process took since is dead within a minute; no process's start time is read
// (asilak/kirunak-cross-platform AC-4, AC-5).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_TAIL = 5 * 1024 * 1024;
const NO_HISTORY_MINUTES = 15;

const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

// This process's start, written beside its pid wherever kirunak writes that pid to a file, for isStill to read. The
// guard no longer reads it; k run's run file, its step lines and the machine guard still do until their leases (S-4).
export const OWN_START = new Date(Date.now() - process.uptime() * 1000).toISOString();

// A pid of kirunak's read from a file: alive, and still the process that started at startIso. No start is dead. A
// pid whose start ps cannot tell now is believed to run, so nothing is taken over or failed on a guess.
export const stillRuns = (pid, startIso) => alive(pid) && isStill(pid, startIso) !== false;

// A gone owner's job that may still run: kirunak cannot tell that its pid is still the job, so it is believed to run,
// waited for and never killed (E-5). Its process group on macOS and Linux, the pid itself on Windows.
const jobRuns = (pid) => groupAlive(pid) || alive(pid);

// Runs argv in its own process group with maxMinutes as a deadline: past it, the group is killed, exit code 124.
// onSpawn(pid) is called as soon as the group exists.
export function runCommand({ command, cwd, maxMinutes, env }, { killAfterMs = 10000, onSpawn } = {}) {
  return new Promise((resolve) => {
    let log = '';
    const keep = (b) => {
      log += b;
      if (log.length > LOG_TAIL) log = log.slice(-LOG_TAIL);
    };
    let settled = false;
    const end = (r) => {
      if (!settled) resolve(r);
      settled = true;
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return end({ exitCode: 127, log: e.message });
    }
    if (child.pid) onSpawn?.(child.pid);
    const closed = new Promise((r) => child.on('close', r));
    let killing = null;
    const timer = maxMinutes > 0 ? setTimeout(() => (killing = killTree(child.pid, killAfterMs)), maxMinutes * 60000) : null;
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => {
      clearTimeout(timer);
      end({ exitCode: 127, log: log + e.message });
    });
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      if (killing) await killing;
      // A child left in the group may hold the pipes open; read what is there, then let go.
      await Promise.race([closed, sleep(1000)]);
      child.stdout.destroy();
      child.stderr.destroy();
      end({ exitCode: killing ? 124 : code ?? 128 + (constants.signals[signal] || 0), log });
    });
  });
}

// renewMs: how often a waiter and the owner touch their leases (lib/lease.mjs RENEW_MS); a test shortens it.
export default function resourceGuardLocal(ws, { pollMs = 1000, killAfterMs = 10000, renewMs = RENEW_MS } = {}) {
  const at = () => {
    const d = join(ws?.home || kirunakHome(), 'guard');
    mkdirSync(d, { recursive: true });
    return { d, lock: join(d, 'lock'), owner: join(d, 'lock', 'owner.json'), queue: join(d, 'queue'), waiting: join(d, 'waiting'), edit: join(d, 'queue.edit'), claims: join(d, 'claims.json'), log: join(d, 'log.jsonl') };
  };
  const fresh = (dir, file) => {
    const l = readLease(dir, { file });
    return !!l && !l.stale;
  };
  // The owner lives while its pid does and its lease is fresh; owner.json written before leases (no `lease`) is read
  // by its pid alone until it goes (E-4). A lock whose owner.json is not written yet counts from the lock's own time.
  const ownerLive = (P, owner) => (owner && !owner.lease ? alive(owner.pid) : (!owner || alive(owner.pid)) && fresh(P.lock, 'owner.json'));
  // A waiter the same way, by its lease in guard/waiting/<id>.
  const waiterLive = (P, e) => (e.lease ? alive(e.pid) && fresh(join(P.waiting, e.id)) : alive(e.pid));
  const readQueue = (P) => (existsSync(P.queue) ? readFileSync(P.queue, 'utf8').split('\n').filter((l) => l.trim()).map(parse) : []);
  const writeQueue = (P, entries) => writeFileSync(P.queue, entries.map((e) => JSON.stringify(e) + '\n').join(''));

  // Every edit of the queue and every take of the lock happens inside this short mutex.
  async function edit(P, fn) {
    for (;;) {
      try {
        mkdirSync(P.edit);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(P.edit).mtimeMs > 5000) rmSync(P.edit, { recursive: true, force: true });
        } catch {}
        await sleep(10);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(P.edit, { recursive: true, force: true });
    }
  }

  // The head of the queue takes the lock, or takes it over once its owner is gone: → the lock's lease, false, or
  // { orphan: pid } while a gone owner's job may still run, which is waited for and never killed (E-5): nobody will
  // collect its result, and kirunak cannot tell that pid is still the job.
  const tryTake = (P, me) =>
    edit(P, () => {
      const all = readQueue(P);
      // A dead waiter's line goes, with its lease; a line someone removed (a handoff's release) comes back at the end.
      const live = all.filter((e) => e && waiterLive(P, e));
      for (const e of all) if (e?.lease && !live.includes(e)) rmSync(join(P.waiting, e.id), { recursive: true, force: true });
      if (!live.some((e) => e.id === me.id)) live.push(me);
      if (live.length !== all.length) writeQueue(P, live);
      if (live[0].id !== me.id) return false;
      if (existsSync(P.lock)) {
        const owner = readJson(P.owner);
        if (ownerLive(P, owner)) return false;
        if (owner?.job && jobRuns(owner.job)) return { orphan: owner.job };
        rmSync(P.lock, { recursive: true, force: true });
      }
      const held = takeLease(P.lock, { id: me.id, lease: 1, session: me.session, what: me.what, since: new Date().toISOString(), expectMinutes: me.expectMinutes, maxMinutes: me.maxMinutes }, { file: 'owner.json' });
      if (!held) return false;
      writeQueue(P, live.slice(1));
      return held;
    });

  const history = (P) => (existsSync(P.log) ? readFileSync(P.log, 'utf8').split('\n').map(parse).filter((x) => x && typeof x.minutes === 'number') : []);

  // The median length of the last ten jobs with the same `what`, or null with no history.
  const usual = (P, what) => {
    const last = history(P).filter((x) => x.what === what).slice(-10).map((x) => x.minutes).sort((a, b) => a - b);
    if (!last.length) return null;
    const mid = last.length >> 1;
    return last.length % 2 ? last[mid] : (last[mid - 1] + last[mid]) / 2;
  };
  // The same, or 15 minutes with no history.
  const estimate = (P, what) => usual(P, what) ?? NO_HISTORY_MINUTES;
  const minutesOr = (x) => (x > 0 ? x : null);

  const held = (c, now = Date.now()) => !c.released && (!c.until || Date.parse(c.until) > now);
  const claimsOf = (P) => readJson(P.claims, []) || [];

  return {
    name: 'resource-guard-local',
    version: '1',
    provides: {
      resourceGuard: {
        // job.expectMinutes (the length the caller expects, or null) does not order anything: this guard serves its
        // queue in the order the jobs came, and a guard that orders by length reads it (plugins.md). It is kept with
        // job.maxMinutes in the job's queue line and the owner file, for queue(). job.pieceMinutes (a job that can resume) is
        // taken and not used: this guard runs every job whole and gives it no deadline, so such a job runs to its end.
        async run(job) {
          const P = at();
          const me = { id: randomUUID(), session: job.session, what: job.what, pid: process.pid, lease: 1, since: new Date().toISOString(), expectMinutes: minutesOr(job.expectMinutes), maxMinutes: minutesOr(job.maxMinutes) };
          mkdirSync(P.waiting, { recursive: true });
          const waiter = takeLease(join(P.waiting, me.id), { id: me.id }).keep({ everyMs: renewMs });
          let held;
          try {
            await edit(P, () => appendFileSync(P.queue, JSON.stringify(me) + '\n'));
            let told = false;
            for (;;) {
              const t = await tryTake(P, me);
              if (t?.dir) {
                held = t;
                break;
              }
              // A wait on a gone owner's job lasts as long as that job: said once, in the log and to the caller.
              if (t?.orphan && !told) {
                told = true;
                appendFileSync(P.log, JSON.stringify({ ts: new Date().toISOString(), what: 'wait', session: job.session, pid: t.orphan, reason: 'the owner is gone, its job may run' }) + '\n');
                job.say?.(`waits: the lock's holder is gone, but its job (pid ${t.orphan}) may still run, so it is waited for, never killed`);
              }
              await sleep(pollMs);
            }
          } finally {
            waiter.release();
          }
          // The caller's `started` (plugins.md): the lock is held and the command starts now.
          job.started?.();
          const started = Date.now();
          let r = { exitCode: 1, log: '' };
          let pid = null;
          let lost = false;
          let finished;
          const done = new Promise((res) => (finished = res));
          // A machine that slept past a minute may find the lock taken over: this job gives way, so two never run (E-8).
          held.keep({
            everyMs: renewMs,
            onLost: () => {
              lost = true;
              appendFileSync(P.log, JSON.stringify({ ts: new Date().toISOString(), what: 'lost', session: job.session, pid }) + '\n');
              job.say?.('gave way: the lock was taken over while this machine slept, so its job is ended');
              if (pid) killTree(pid, killAfterMs);
            },
          });
          const release = () => held.release();
          // k run stopped (Ctrl-C, TERM, a closed terminal): end the job's group, then wait for the release below.
          const unstop = onStop(async () => {
            await killTree(pid, killAfterMs);
            await done;
          });
          // A crash or a second Ctrl-C leaves no time to wait: TERM the job and keep the lock while it runs, so the
          // next take ends what is left of it; with nothing running, release now (outside the mutex: takes allow it).
          const onExit = () => {
            if (!pid || !jobRuns(pid)) return release();
            signalGroup(pid, 'SIGTERM');
          };
          process.on('exit', onExit);
          try {
            r = await runCommand(job, {
              killAfterMs,
              onSpawn: (p) => {
                pid = p;
                held.update({ job: p });
              },
            });
            if (lost) r = { ...r, lost: true };
          } finally {
            process.off('exit', onExit);
            try {
              await edit(P, release);
              const minutes = Math.round(((Date.now() - started) / 60000) * 100) / 100;
              appendFileSync(P.log, JSON.stringify({ ts: new Date().toISOString(), what: job.what, session: job.session, minutes, exitCode: r.exitCode }) + '\n');
            } finally {
              unstop();
              finished();
            }
          }
          return r;
        },

        // { held, queued, estimateMinutes }: each job's estimate, and at the top the wait of a job that queued now. A
        // gone owner's job that may still run holds the lock for every waiter: it is held, marked orphan.
        status() {
          const P = at();
          const owner = readJson(P.owner);
          const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;
          const job = ({ session, what, since }) => ({ session, what, since, estimateMinutes: estimate(P, what) });
          const h = !owner ? null : ownerLive(P, owner) ? job(owner) : owner.job && jobRuns(owner.job) ? { ...job(owner), orphan: true } : null;
          const queued = readQueue(P).filter((e) => e && waiterLive(P, e)).map(job);
          const left = h ? Math.max(0, h.estimateMinutes - minutesSince(h.since)) : 0;
          return { held: h, queued, estimateMinutes: Math.round((left + queued.reduce((s, q) => s + q.estimateMinutes, 0)) * 100) / 100 };
        },

        // { now, first, held, waiting } (plugins.md §2): the holder as status() sees it, and the live waiters in the
        // order this guard serves them, the order they came. Lengths are those the job stated, its usual the median of
        // the same `what` in the log (null with none); this guard knows no kinds and no first session.
        queue() {
          const P = at();
          const owner = readJson(P.owner);
          const job = (e, at) => ({
            session: e.session, what: e.what, [at]: e.since ?? null, pid: Number.isInteger(e.pid) ? e.pid : null,
            expectMinutes: minutesOr(e.expectMinutes), maxMinutes: minutesOr(e.maxMinutes), kind: null, usualMinutes: usual(P, e.what),
          });
          const live = owner && (ownerLive(P, owner) || (owner.job && jobRuns(owner.job)));
          return {
            now: new Date().toISOString(),
            first: null,
            held: live ? job(owner, 'since') : null,
            waiting: readQueue(P).filter((e) => e && waiterLive(P, e)).map((e) => job(e, 'queuedAt')),
          };
        },

        claim(resource, by, why, hours) {
          const P = at();
          const claims = claimsOf(P);
          const cur = claims.find((c) => c.resource === resource);
          if (cur && held(cur) && cur.by !== by) throw refuse(`${resource} is claimed by ${cur.by}${cur.until ? ` until ${cur.until}` : ''}: ${cur.why}`);
          const now = Date.now();
          const entry = { resource, by, why, since: new Date(now).toISOString(), until: hours ? new Date(now + hours * 3600000).toISOString() : null };
          writeFileSync(P.claims, JSON.stringify([...claims.filter((c) => c !== cur), entry], null, 2) + '\n');
          return entry;
        },

        release(resource, by) {
          const P = at();
          const claims = claimsOf(P);
          const cur = claims.find((c) => c.resource === resource && c.by === by && held(c));
          if (!cur) return false;
          cur.released = new Date().toISOString();
          writeFileSync(P.claims, JSON.stringify(claims, null, 2) + '\n');
          return true;
        },

        // What was ever claimed, free or held; a held one with who claimed it and why.
        resources() {
          return claimsOf(at()).map((c) => (held(c) ? { id: c.resource, name: c.resource, state: `claimed by ${c.by}`, by: c.by, ...(c.why ? { why: c.why } : {}) } : { id: c.resource, name: c.resource, state: 'free' }));
        },
      },
    },
  };
}

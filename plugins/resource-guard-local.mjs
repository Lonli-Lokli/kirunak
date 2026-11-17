import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { refuse } from '../lib/errors.mjs';
import { kirunakHome } from '../lib/home.mjs';
import { alive, groupAlive, isStill, killTree, signalGroup } from '../lib/os.mjs';
import { onStop } from '../lib/stop.mjs';

// The process calls live in lib/os.mjs (asilak/kirunak-cross-platform AC-1); these stay importable from here.
export { alive, groupAlive, isStill, killTree };

// The core's default `resourceGuard` (plugins.md §2): one heavy job at a time on this machine. The lock is
// guard/lock, a directory made with mkdir (atomic) holding owner.json; waiting jobs queue first in, first out in
// guard/queue, one JSON line each; every job appends a line to guard/log.jsonl; claims are in guard/claims.json.

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

// This process's start, written beside its pid wherever kirunak writes that pid to a file, for isStill to read.
export const OWN_START = new Date(Date.now() - process.uptime() * 1000).toISOString();

// A pid of kirunak's read from a file: alive, and still the process that started at startIso. No start is dead. A
// pid whose start ps cannot tell now is believed to run, so nothing is taken over or failed on a guess.
export const stillRuns = (pid, startIso) => alive(pid) && isStill(pid, startIso) !== false;

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

export default function resourceGuardLocal(ws, { pollMs = 1000, killAfterMs = 10000 } = {}) {
  const at = () => {
    const d = join(ws?.home || kirunakHome(), 'guard');
    mkdirSync(d, { recursive: true });
    return { d, lock: join(d, 'lock'), owner: join(d, 'lock', 'owner.json'), queue: join(d, 'queue'), edit: join(d, 'queue.edit'), claims: join(d, 'claims.json'), log: join(d, 'log.jsonl') };
  };
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

  // owner.json is replaced whole, so a reader never sees half of it.
  const writeOwner = (P, owner) => {
    writeFileSync(`${P.owner}.tmp`, JSON.stringify(owner) + '\n');
    renameSync(`${P.owner}.tmp`, P.owner);
  };

  // A lock without owner.json is dead after 10 s; one removed since it was seen is no lock at all.
  const stale = (P) => {
    try {
      return Date.now() - statSync(P.lock).mtimeMs > 10000;
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      throw e;
    }
  };

  // The head of the queue takes the lock, or takes it over when its owner's process is dead. A dead owner's job that
  // still runs is returned as { orphan: pid } first: nobody will collect its result, and it must end before the take.
  // It is that job only while it started at jobStart; a pid that names another process by now is left alone, and one
  // ps cannot tell about now is waited for, neither killed nor run beside ({ unknown: pid }). A waiter or an owner is
  // alive only while its pid is still the process that started at its pidStart (or ps cannot tell).
  const tryTake = (P, me) =>
    edit(P, () => {
      const all = readQueue(P);
      // A dead waiter's line goes; a line someone removed (a handoff's release) comes back at the end.
      const live = all.filter((e) => e && stillRuns(e.pid, e.pidStart));
      if (!live.some((e) => e.id === me.id)) live.push(me);
      if (live.length !== all.length) writeQueue(P, live);
      if (live[0].id !== me.id) return false;
      if (existsSync(P.lock)) {
        const owner = readJson(P.owner);
        const dead = owner ? !stillRuns(owner.pid, owner.pidStart) : stale(P);
        if (!dead) return false;
        const job = groupAlive(owner?.job) ? isStill(owner.job, owner.jobStart) : false;
        if (job === null) return { unknown: owner.job };
        if (job === true) return { orphan: owner.job };
        rmSync(P.lock, { recursive: true, force: true });
      }
      try {
        mkdirSync(P.lock);
      } catch {
        return false;
      }
      writeOwner(P, { session: me.session, what: me.what, pid: me.pid, pidStart: me.pidStart, since: new Date().toISOString(), id: me.id, expectMinutes: me.expectMinutes, maxMinutes: me.maxMinutes });
      writeQueue(P, live.slice(1));
      return true;
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
          const me = { id: randomUUID(), session: job.session, what: job.what, pid: process.pid, pidStart: OWN_START, since: new Date().toISOString(), expectMinutes: minutesOr(job.expectMinutes), maxMinutes: minutesOr(job.maxMinutes) };
          await edit(P, () => appendFileSync(P.queue, JSON.stringify(me) + '\n'));
          let told = false;
          for (;;) {
            const t = await tryTake(P, me);
            if (t === true) break;
            if (t?.orphan) await killTree(t.orphan, killAfterMs);
            else {
              // A wait on a job ps cannot tell about lasts as long as that job: said once, in the log and to the caller.
              if (t?.unknown && !told) {
                told = true;
                appendFileSync(P.log, JSON.stringify({ ts: new Date().toISOString(), what: 'wait', session: job.session, pid: t.unknown, reason: 'ps gave no answer' }) + '\n');
                job.say?.(`waits: the lock's holder is gone, but ps gave no answer for its job (pid ${t.unknown}), so that job is believed to run`);
              }
              await sleep(pollMs);
            }
          }
          // The caller's `started` (plugins.md): the lock is held and the command starts now.
          job.started?.();
          const started = Date.now();
          let r = { exitCode: 1, log: '' };
          let pid = null;
          let finished;
          const done = new Promise((res) => (finished = res));
          const release = () => {
            if (readJson(P.owner)?.id === me.id) rmSync(P.lock, { recursive: true, force: true });
          };
          // k run stopped (Ctrl-C, TERM, a closed terminal): end the job's group, then wait for the release below.
          const unstop = onStop(async () => {
            await killTree(pid, killAfterMs);
            await done;
          });
          // A crash or a second Ctrl-C leaves no time to wait: TERM the job and keep the lock while it runs, so the
          // next take ends what is left of it; with nothing running, release now (outside the mutex: takes allow it).
          const onExit = () => {
            if (!groupAlive(pid)) return release();
            signalGroup(pid, 'SIGTERM');
          };
          process.on('exit', onExit);
          try {
            r = await runCommand(job, {
              killAfterMs,
              onSpawn: (p) => {
                pid = p;
                const owner = readJson(P.owner);
                if (owner?.id === me.id) writeOwner(P, { ...owner, job: p, jobStart: new Date().toISOString() });
              },
            });
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
        // dead owner's job that still runs, or that ps cannot tell about, holds the lock for every waiter: it is held,
        // marked orphan. One ps says is another process by now is not; the next take takes the lock over.
        status() {
          const P = at();
          const owner = readJson(P.owner);
          const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;
          const job = ({ session, what, since }) => ({ session, what, since, estimateMinutes: estimate(P, what) });
          const orphan = () => groupAlive(owner.job) && isStill(owner.job, owner.jobStart) !== false;
          const h = !owner ? null : stillRuns(owner.pid, owner.pidStart) ? job(owner) : orphan() ? { ...job(owner), orphan: true } : null;
          const queued = readQueue(P).filter((e) => e && stillRuns(e.pid, e.pidStart)).map(job);
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
          const live = owner && (stillRuns(owner.pid, owner.pidStart) || (groupAlive(owner.job) && isStill(owner.job, owner.jobStart) !== false));
          return {
            now: new Date().toISOString(),
            first: null,
            held: live ? job(owner, 'since') : null,
            waiting: readQueue(P).filter((e) => e && stillRuns(e.pid, e.pidStart)).map((e) => job(e, 'queuedAt')),
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

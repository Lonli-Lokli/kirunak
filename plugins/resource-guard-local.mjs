import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { refuse } from '../lib/errors.mjs';
import { kirunakHome } from '../lib/home.mjs';
import { onStop } from '../lib/stop.mjs';

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

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A pid of 0 or 1 would name this process's own group or every process: never a job's group.
const isGroup = (pid) => Number.isInteger(pid) && pid > 1;

// A group this user cannot signal (EPERM) is no job's or claude's of kirunak's and could not be killed anyway: not
// alive. alive() keeps EPERM as alive, since a pid it answers for is only waited for, never killed.
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
// within slackMs of startIso: now less its elapsed time is its start. No start recorded, or no such process, is false.
export function isStill(pid, startIso, slackMs = 5000) {
  const recorded = Date.parse(startIso);
  if (!isGroup(pid) || Number.isNaN(recorded)) return false;
  const ps = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const s = ps.status === 0 ? elapsed(ps.stdout) : null;
  return s !== null && Math.abs(Date.now() - s * 1000 - recorded) <= slackMs;
}

// TERM to the process group, then KILL after graceMs if anything of it is left.
export async function killTree(pid, graceMs = 10000) {
  if (!isGroup(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  const until = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < until) await sleep(50);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
}

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
  // It is that job only while it started at jobStart; a pid that names another process by now is left alone.
  const tryTake = (P, me) =>
    edit(P, () => {
      const all = readQueue(P);
      // A dead waiter's line goes; a line someone removed (a handoff's release) comes back at the end.
      const live = all.filter((e) => e && alive(e.pid));
      if (!live.some((e) => e.id === me.id)) live.push(me);
      if (live.length !== all.length) writeQueue(P, live);
      if (live[0].id !== me.id) return false;
      if (existsSync(P.lock)) {
        const owner = readJson(P.owner);
        const dead = owner ? !alive(owner.pid) : stale(P);
        if (!dead) return false;
        if (groupAlive(owner?.job) && isStill(owner.job, owner.jobStart)) return { orphan: owner.job };
        rmSync(P.lock, { recursive: true, force: true });
      }
      try {
        mkdirSync(P.lock);
      } catch {
        return false;
      }
      writeOwner(P, { session: me.session, what: me.what, pid: me.pid, since: new Date().toISOString(), id: me.id });
      writeQueue(P, live.slice(1));
      return true;
    });

  const history = (P) => (existsSync(P.log) ? readFileSync(P.log, 'utf8').split('\n').map(parse).filter((x) => x && typeof x.minutes === 'number') : []);

  // The median length of the last ten jobs with the same `what`, or 15 minutes with no history.
  const estimate = (P, what) => {
    const last = history(P).filter((x) => x.what === what).slice(-10).map((x) => x.minutes).sort((a, b) => a - b);
    if (!last.length) return NO_HISTORY_MINUTES;
    const mid = last.length >> 1;
    return last.length % 2 ? last[mid] : (last[mid - 1] + last[mid]) / 2;
  };

  const held = (c, now = Date.now()) => !c.released && (!c.until || Date.parse(c.until) > now);
  const claimsOf = (P) => readJson(P.claims, []) || [];

  return {
    name: 'resource-guard-local',
    version: '1',
    provides: {
      resourceGuard: {
        async run(job) {
          const P = at();
          const me = { id: randomUUID(), session: job.session, what: job.what, pid: process.pid, since: new Date().toISOString() };
          await edit(P, () => appendFileSync(P.queue, JSON.stringify(me) + '\n'));
          for (;;) {
            const t = await tryTake(P, me);
            if (t === true) break;
            if (t?.orphan) await killTree(t.orphan, killAfterMs);
            else await sleep(pollMs);
          }
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
            try {
              process.kill(-pid, 'SIGTERM');
            } catch {}
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

        // { held, queued, estimateMinutes }: each job's estimate, and at the top the wait of a job that queued now.
        status() {
          const P = at();
          const owner = readJson(P.owner);
          const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;
          const job = ({ session, what, since }) => ({ session, what, since, estimateMinutes: estimate(P, what) });
          const h = owner && alive(owner.pid) ? job(owner) : null;
          const queued = readQueue(P).filter((e) => e && alive(e.pid)).map(job);
          const left = h ? Math.max(0, h.estimateMinutes - minutesSince(h.since)) : 0;
          return { held: h, queued, estimateMinutes: Math.round((left + queued.reduce((s, q) => s + q.estimateMinutes, 0)) * 100) / 100 };
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

        // What was ever claimed, free or held.
        resources() {
          return claimsOf(at()).map((c) => ({ id: c.resource, name: c.resource, state: held(c) ? `claimed by ${c.by}` : 'free' }));
        },
      },
    },
  };
}

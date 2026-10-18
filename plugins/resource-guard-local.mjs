import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { kirunakHome } from '../lib/home.mjs';

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

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// TERM to the process group, then KILL after graceMs if anything of it is left.
export async function killTree(pid, graceMs = 10000) {
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
export function runCommand({ command, cwd, maxMinutes, env }, { killAfterMs = 10000 } = {}) {
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

  // The head of the queue takes the lock, or takes it over when its owner's process is dead.
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
        const dead = owner ? !alive(owner.pid) : Date.now() - statSync(P.lock).mtimeMs > 10000;
        if (!dead) return false;
        rmSync(P.lock, { recursive: true, force: true });
      }
      try {
        mkdirSync(P.lock);
      } catch {
        return false;
      }
      writeFileSync(P.owner, JSON.stringify({ session: me.session, what: me.what, pid: me.pid, since: new Date().toISOString(), id: me.id }) + '\n');
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

  return {
    name: 'resource-guard-local',
    version: '1',
    provides: {
      resourceGuard: {
        async run(job) {
          const P = at();
          const me = { id: randomUUID(), session: job.session, what: job.what, pid: process.pid, since: new Date().toISOString() };
          await edit(P, () => appendFileSync(P.queue, JSON.stringify(me) + '\n'));
          while (!(await tryTake(P, me))) await sleep(pollMs);
          const started = Date.now();
          let r = { exitCode: 1, log: '' };
          try {
            r = await runCommand(job, { killAfterMs });
          } finally {
            if (readJson(P.owner)?.id === me.id) rmSync(P.lock, { recursive: true, force: true });
            const minutes = Math.round(((Date.now() - started) / 60000) * 100) / 100;
            appendFileSync(P.log, JSON.stringify({ ts: new Date().toISOString(), what: job.what, session: job.session, minutes, exitCode: r.exitCode }) + '\n');
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
      },
    },
  };
}

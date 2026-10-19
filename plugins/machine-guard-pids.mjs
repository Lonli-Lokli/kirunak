import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kirunakHome } from '../lib/home.mjs';
import { alive } from './resource-guard-local.mjs';

// The core's default `machineGuard` (plugins.md §2, orchestrator.md §4): one file per live step process,
// running/<pid>.json (task, step, session, since), and one per step admitted and not started yet,
// running/<k-run-pid>-<n>.json; the limits from the config, or from machine.json when the owner overrides them there.
// A file whose process is dead is removed on the next look.

export const DEFAULT_LIMITS = { maxAgents: 2, maxHeavy: 1 };

const homeOf = (ws) => ws?.home || kirunakHome();
const runningDir = (ws) => join(homeOf(ws), 'running');

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

// An admitted step's slot becomes its process's file by a rename, so the step is counted all along.
export function register(ws, pid, { task, step, session, since = new Date().toISOString() }, slot = null) {
  mkdirSync(runningDir(ws), { recursive: true });
  const path = join(runningDir(ws), `${pid}.json`);
  if (slot) {
    try {
      renameSync(join(runningDir(ws), `${slot.name}.json`), path);
    } catch {}
  }
  writeFileSync(path, JSON.stringify({ pid, task, step, session, since }, null, 2) + '\n');
}

// A slot whose step never started: its reservation goes.
export function release(ws, slot) {
  try {
    unlinkSync(join(runningDir(ws), `${slot.name}.json`));
  } catch {}
}

export function unregister(ws, pid) {
  try {
    unlinkSync(join(runningDir(ws), `${pid}.json`));
  } catch {}
}

// The steps admitted and not started yet, by the reservations of k runs that still run; a dead one's is removed.
function reservations(ws) {
  const dir = runningDir(ws);
  const out = [];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^(\d+)-\d+\.json$/.exec(f);
    if (!m) continue;
    if (!alive(Number(m[1]))) {
      rmSync(join(dir, f), { force: true });
      continue;
    }
    const r = readJson(join(dir, f)) || {};
    out.push({ pid: Number(m[1]), task: r.task ?? null, step: r.step ?? null, since: r.since ?? null });
  }
  return out;
}

// The short mutex of every admission, so two k runs never count the same free slot.
async function locked(ws, fn) {
  mkdirSync(runningDir(ws), { recursive: true });
  const m = join(runningDir(ws), '.admit');
  for (;;) {
    try {
      mkdirSync(m);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(m).mtimeMs > 5000) rmSync(m, { recursive: true, force: true });
      } catch {}
      await sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(m, { recursive: true, force: true });
  }
}

// admit(ws, machineGuard, { task, step }) → { ok, limits, running, slot, why }: a step starts only while fewer than
// maxAgents steps run or are starting. The count and the slot's reservation are one step across processes; the
// slot is then given to register() or to release(). Reservations are read before the processes, so a register()
// in between is counted twice, never missed.
export async function admit(ws, mg, { task = null, step = null } = {}) {
  return locked(ws, async () => {
    const starting = reservations(ws);
    const limits = await mg.limits();
    const running = await mg.running();
    if (running.length + starting.length < limits.maxAgents) {
      const slot = { name: `${process.pid}-${++seq}`, held: true };
      writeFileSync(join(runningDir(ws), `${slot.name}.json`), JSON.stringify({ pid: process.pid, task, step, since: new Date().toISOString() }) + '\n');
      return { ok: true, limits, running, slot };
    }
    const who = [
      ...running.map((r) => `${r.task} ${r.step} (pid ${r.pid} since ${r.since})`),
      ...starting.map((r) => `${r.task} ${r.step} (starting under k run ${r.pid} since ${r.since})`),
    ];
    return { ok: false, limits, running, why: `${running.length + starting.length} of ${limits.maxAgents} steps run: ${who.join('; ')}` };
  });
}

export default function machineGuardPids(ws) {
  return {
    name: 'machine-guard-pids',
    version: '1',
    provides: {
      machineGuard: {
        limits() {
          const own = readJson(join(homeOf(ws), 'machine.json')) || {};
          const pick = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => k in DEFAULT_LIMITS && Number.isInteger(v)));
          return { ...DEFAULT_LIMITS, ...pick(ws?.machine), ...pick(own) };
        },
        running() {
          const dir = runningDir(ws);
          if (!existsSync(dir)) return [];
          const out = [];
          for (const f of readdirSync(dir)) {
            const m = /^(\d+)\.json$/.exec(f);
            if (!m) continue;
            const pid = Number(m[1]);
            if (!alive(pid)) {
              unregister(ws, pid);
              continue;
            }
            const r = readJson(join(dir, f)) || {};
            out.push({ pid, task: r.task ?? null, step: r.step ?? null, session: r.session ?? null, since: r.since ?? null });
          }
          return out.sort((a, b) => String(a.since).localeCompare(String(b.since)));
        },
      },
    },
  };
}

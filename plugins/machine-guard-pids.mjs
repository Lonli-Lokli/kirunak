import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kirunakHome } from '../lib/home.mjs';
import { alive } from './resource-guard-local.mjs';

// The core's default `machineGuard` (plugins.md §2, orchestrator.md §4): one file per live step process,
// running/<pid>.json (task, step, session, since); the limits from the config, or from machine.json when the owner
// overrides them there. A file whose process is dead is removed on the next look.

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

export function register(ws, pid, { task, step, session, since = new Date().toISOString() }) {
  mkdirSync(runningDir(ws), { recursive: true });
  writeFileSync(join(runningDir(ws), `${pid}.json`), JSON.stringify({ pid, task, step, session, since }, null, 2) + '\n');
}

export function unregister(ws, pid) {
  try {
    unlinkSync(join(runningDir(ws), `${pid}.json`));
  } catch {}
}

// admit(machineGuard, reserved) → { ok, limits, running, why }: a step starts only while fewer than maxAgents step
// processes run; `reserved` counts the ones this process is starting and has not registered yet.
export async function admit(mg, reserved = 0) {
  const limits = await mg.limits();
  const running = await mg.running();
  if (running.length + reserved < limits.maxAgents) return { ok: true, limits, running };
  const who = running.map((r) => `${r.task} ${r.step} (pid ${r.pid} since ${r.since})`);
  if (reserved) who.push(`${reserved} starting`);
  return { ok: false, limits, running, why: `${running.length + reserved} of ${limits.maxAgents} steps run: ${who.join('; ')}` };
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

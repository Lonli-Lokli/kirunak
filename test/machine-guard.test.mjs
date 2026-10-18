import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import machineGuardPids, { admit, register } from '../plugins/machine-guard-pids.mjs';
import pricesDefault from '../plugins/prices-default.mjs';
import { makeWorkspace } from './helpers.mjs';

const fresh = (machine) => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-machine-'));
  const ws = { home, machine };
  return { home, ws, mg: machineGuardPids(ws).provides.machineGuard };
};

async function deadPid() {
  const c = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => c.on('exit', r));
  return c.pid;
}

test('the machine guard refuses past maxAgents and says who runs', async () => {
  const { ws, mg } = fresh();
  const a = spawn('sleep', ['5']);
  const b = spawn('sleep', ['5']);
  try {
    register(ws, a.pid, { task: 'weather/a', step: 'S-1', session: 's-a', since: '2026-11-03T10:00:00.000Z' });
    assert.equal((await admit(mg)).ok, true);
    assert.equal((await admit(mg, 1)).ok, false, 'a step this process is starting counts');
    register(ws, b.pid, { task: 'weather/b', step: 'S-2', session: 's-b', since: '2026-11-03T10:05:00.000Z' });
    const r = await admit(mg);
    assert.equal(r.ok, false);
    assert.equal(r.why, `2 of 2 steps run: weather/a S-1 (pid ${a.pid} since 2026-11-03T10:00:00.000Z); weather/b S-2 (pid ${b.pid} since 2026-11-03T10:05:00.000Z)`);
    assert.deepEqual((await mg.running()).map((x) => [x.pid, x.task, x.step, x.session]), [[a.pid, 'weather/a', 'S-1', 's-a'], [b.pid, 'weather/b', 'S-2', 's-b']]);
  } finally {
    a.kill();
    b.kill();
  }
});

test('a dead pid is cleared on the next look', async () => {
  const { home, ws, mg } = fresh();
  const pid = await deadPid();
  register(ws, pid, { task: 'weather/a', step: 'S-1', session: 's' });
  assert.equal(existsSync(join(home, 'running', `${pid}.json`)), true);
  assert.deepEqual(await mg.running(), []);
  assert.equal(existsSync(join(home, 'running', `${pid}.json`)), false);
  assert.equal((await admit(mg)).ok, true);
});

test('the limits: the default, the config, then machine.json', () => {
  assert.deepEqual(fresh().mg.limits(), { maxAgents: 2, maxHeavy: 1 });
  const { home, mg } = fresh({ maxAgents: 3 });
  assert.deepEqual(mg.limits(), { maxAgents: 3, maxHeavy: 1 });
  writeFileSync(join(home, 'machine.json'), JSON.stringify({ maxAgents: 1 }));
  assert.deepEqual(mg.limits(), { maxAgents: 1, maxHeavy: 1 });
});

test('the default prices: the cache ratios and the model multipliers', () => {
  const p = pricesDefault().provides.prices;
  assert.deepEqual(p.weights('claude-opus-5-5'), { input: 1, cacheRead: 0.1, write5m: 1.25, write1h: 2, output: 5 });
  assert.deepEqual(p.weights('sonnet'), { input: 0.6, cacheRead: 0.1 * 0.6, write5m: 0.75, write1h: 1.2, output: 3 });
  assert.equal(p.weights('claude-haiku-5-5').input, 0.2);
  assert.equal(p.weights('claude-fable-5-1').write1h, 5);
});

test('a workspace loads the core defaults for the guards and the prices', async () => {
  const { ws } = await makeWorkspace();
  const modules = Object.fromEntries(ws.seams.loaded.map((l) => [l.seam, l.module]));
  assert.match(modules.resourceGuard, /resource-guard-local\.mjs$/);
  assert.match(modules.machineGuard, /machine-guard-pids\.mjs$/);
  assert.match(modules.prices, /prices-default\.mjs$/);
  assert.deepEqual(await ws.seams.machineGuard.limits(), { maxAgents: 2, maxHeavy: 1 });
});

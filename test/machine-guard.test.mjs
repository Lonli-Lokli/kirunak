import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import machineGuardPids, { admit, register, release, unregister } from '../plugins/machine-guard-pids.mjs';
import pricesDefault from '../plugins/prices-default.mjs';
import { makeWorkspace, tempDir } from './helpers.mjs';

const fresh = (machine) => {
  const home = tempDir('kirunak-machine-');
  const ws = { home, machine };
  return { home, ws, mg: machineGuardPids(ws).provides.machineGuard };
};

async function deadPid() {
  const c = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => c.on('exit', r));
  return c.pid;
}

// A process that runs until killed, on every OS.
const idle = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
const ended = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : (c.on('exit', r), c.kill())));
// The running/ files, without the leases beside them.
const files = (home) => readdirSync(join(home, 'running')).filter((f) => f.endsWith('.json')).sort();
const age = (path, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};

test('the machine guard refuses past maxAgents and says who runs', async () => {
  const { ws, mg } = fresh();
  const a = idle();
  const b = idle();
  try {
    const [aSince, bSince] = [new Date().toISOString(), new Date(Date.now() + 1).toISOString()];
    register(ws, a.pid, { task: 'weather/a', step: 'S-1', session: 's-a', since: aSince });
    const first = await admit(ws, mg, { task: 'weather/c', step: 'S-3' });
    assert.equal(first.ok, true);
    const full = await admit(ws, mg);
    assert.equal(full.ok, false, 'a step admitted and not started yet counts');
    assert.match(full.why, new RegExp(`; weather/c S-3 \\(starting under k run ${process.pid} since `));
    release(ws, first.slot);
    register(ws, b.pid, { task: 'weather/b', step: 'S-2', session: 's-b', since: bSince });
    const r = await admit(ws, mg);
    assert.equal(r.ok, false);
    assert.equal(r.why, `2 of 2 steps run: weather/a S-1 (pid ${a.pid} since ${aSince}); weather/b S-2 (pid ${b.pid} since ${bSince})`);
    assert.deepEqual((await mg.running()).map((x) => [x.pid, x.task, x.step, x.session]), [[a.pid, 'weather/a', 'S-1', 's-a'], [b.pid, 'weather/b', 'S-2', 's-b']]);
  } finally {
    unregister(ws, a.pid);
    unregister(ws, b.pid);
    await Promise.all([ended(a), ended(b)]);
  }
});

test('AC-4: a registered session survives running() on every OS while its lease is fresh, and goes with its lease on unregister()', async () => {
  const { home, ws, mg } = fresh();
  const p = idle();
  try {
    register(ws, p.pid, { task: 'weather/a', step: 'S-1', session: 's' });
    assert.equal(existsSync(join(home, 'running', `${p.pid}.json.lease`)), true, 'held by the lease beside it');
    for (let i = 0; i < 3; i++) assert.deepEqual((await mg.running()).map((r) => r.pid), [p.pid]);
    unregister(ws, p.pid);
    assert.deepEqual(readdirSync(join(home, 'running')), [], 'the file and its lease are gone');
  } finally {
    await ended(p);
  }
});

test('a dead pid is cleared on the next look', async () => {
  const { home, ws, mg } = fresh();
  const pid = await deadPid();
  register(ws, pid, { task: 'weather/a', step: 'S-1', session: 's' });
  assert.equal(existsSync(join(home, 'running', `${pid}.json`)), true);
  assert.deepEqual(await mg.running(), []);
  assert.equal(existsSync(join(home, 'running', `${pid}.json`)), false);
  assert.equal(existsSync(join(home, 'running', `${pid}.json.lease`)), false);
  const a = await admit(ws, mg);
  assert.equal(a.ok, true);
  release(ws, a.slot);
});

test('AC-4, E-9: a pid file or a reservation whose lease went stale, its pid another process\'s by now, is cleared on the next look with its lease', async () => {
  const { home, ws, mg } = fresh({ maxAgents: 1 });
  const other = idle();
  const dir = join(home, 'running');
  mkdirSync(dir);
  try {
    for (const name of [`${other.pid}.json`, `${other.pid}-1.json`]) {
      writeFileSync(join(dir, name), JSON.stringify({ pid: other.pid, task: 'weather/a', step: 'S-1', session: 's', since: new Date().toISOString() }));
      mkdirSync(join(dir, `${name}.lease`));
      writeFileSync(join(dir, `${name}.lease`, 'holder.json'), JSON.stringify({ id: 'x', pid: other.pid }));
      age(join(dir, `${name}.lease`, 'holder.json'), 61000);
    }
    assert.deepEqual(await mg.running(), []);
    const a = await admit(ws, mg);
    assert.equal(a.ok, true, 'the reservation does not count');
    assert.deepEqual(files(home), [`${a.slot.name}.json`], 'and both are removed');
    assert.equal(existsSync(join(dir, `${other.pid}-1.json.lease`)), false);
    release(ws, a.slot);
  } finally {
    await ended(other);
  }
});

test('E-4: a pid file and a reservation written before leases (no lease beside them) are read by their pid: kept and counted while it runs, cleared once it ends', async () => {
  const { home, ws, mg } = fresh({ maxAgents: 1 });
  const other = idle();
  const start = new Date().toISOString();
  const dir = join(home, 'running');
  mkdirSync(dir);
  try {
    writeFileSync(join(dir, `${other.pid}.json`), JSON.stringify({ pid: other.pid, task: 'weather/a', step: 'S-1', session: 's', since: start }));
    assert.deepEqual((await mg.running()).map((r) => r.pid), [other.pid]);
    unregister(ws, other.pid);
    writeFileSync(join(dir, `${other.pid}-1.json`), JSON.stringify({ pid: other.pid, pidStart: start, task: 'weather/b', step: 'S-2', since: start }));
    assert.equal((await admit(ws, mg)).ok, false, 'the reservation counts');
    await ended(other);
    const a = await admit(ws, mg);
    assert.equal(a.ok, true, 'its pid ended: cleared');
    assert.deepEqual(files(home), [`${a.slot.name}.json`]);
    release(ws, a.slot);
  } finally {
    await ended(other);
  }
});

test('admitting and reserving are one step: two processes at once under a cap of 1 get one yes; a dead holder\'s reservation is not counted', async () => {
  const { home, ws, mg } = fresh({ maxAgents: 1 });
  const plugin = new URL('../plugins/machine-guard-pids.mjs', import.meta.url).href;
  const child = `import guard, { admit } from ${JSON.stringify(plugin)};
const ws = { home: process.argv[1], machine: { maxAgents: 1 } };
while (Date.now() < Number(process.argv[2]));
const a = await admit(ws, guard(ws).provides.machineGuard, { task: 'weather/a', step: 'S-1' });
process.stdout.write(a.ok ? 'yes' : 'no');
setTimeout(() => {}, 30000);`;
  const at = Date.now() + 700;
  const kids = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', child, home, String(at)]));
  const said = await Promise.all(kids.map((c) => new Promise((r) => c.stdout.on('data', (d) => r(String(d))))));
  assert.deepEqual(said.sort(), ['no', 'yes']);
  assert.equal(files(home).filter((f) => /^\d+-\d+\.json$/.test(f)).length, 1);
  await Promise.all(kids.map((c) => ended(c)));
  const mine = await admit(ws, mg);
  assert.equal(mine.ok, true, 'the dead holder\'s reservation does not count');
  assert.deepEqual(files(home), [`${mine.slot.name}.json`], 'and is removed');
  // A slot given to a run becomes its pid file; one never started goes.
  const run = idle();
  try {
    register(ws, run.pid, { task: 'weather/a', step: 'S-1', session: 's' }, mine.slot);
    assert.deepEqual(files(home), [`${run.pid}.json`]);
    assert.equal(existsSync(join(home, 'running', `${mine.slot.name}.json.lease`)), false, 'the slot\'s lease went with it');
    assert.equal((await admit(ws, mg)).ok, false);
  } finally {
    await ended(run);
  }
  const next = await admit(ws, mg);
  assert.equal(next.ok, true);
  release(ws, next.slot);
  assert.deepEqual(readdirSync(join(home, 'running')), []);
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

test('a workspace loads the core defaults for the guards, the runner and the prices', async () => {
  const { ws } = await makeWorkspace();
  const modules = Object.fromEntries(ws.seams.loaded.map((l) => [l.seam, l.module]));
  assert.match(modules.resourceGuard, /resource-guard-local\.mjs$/);
  assert.match(modules.machineGuard, /machine-guard-pids\.mjs$/);
  assert.match(modules.prices, /prices-default\.mjs$/);
  assert.match(modules.runner, /runner-claude\.mjs$/);
  assert.deepEqual(await ws.seams.machineGuard.limits(), { maxAgents: 2, maxHeavy: 1 });
});

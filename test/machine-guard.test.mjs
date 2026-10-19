import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import machineGuardPids, { admit, register, release, unregister } from '../plugins/machine-guard-pids.mjs';
import pricesDefault from '../plugins/prices-default.mjs';
import { fakePs, makeWorkspace } from './helpers.mjs';

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
  assert.equal((await admit(ws, mg)).ok, true);
});

test('a pid file or a reservation whose pid is now another process, or that recorded no start, is cleared on the next look', async () => {
  const { home, ws, mg } = fresh({ maxAgents: 1 });
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  mkdirSync(join(home, 'running'));
  try {
    for (const start of [new Date(Date.now() - 3600000).toISOString(), undefined]) {
      writeFileSync(join(home, 'running', `${other.pid}.json`), JSON.stringify({ pid: other.pid, task: 'weather/a', step: 'S-1', session: 's', since: start }));
      assert.deepEqual(await mg.running(), [], `since ${start}`);
      assert.equal(existsSync(join(home, 'running', `${other.pid}.json`)), false);
      writeFileSync(join(home, 'running', `${other.pid}-1.json`), JSON.stringify({ pid: other.pid, pidStart: start, task: 'weather/b', step: 'S-2', since: start }));
      const a = await admit(ws, mg);
      assert.equal(a.ok, true, `the reservation does not count (pidStart ${start})`);
      assert.deepEqual(readdirSync(join(home, 'running')), [`${a.slot.name}.json`], 'and is removed');
      release(ws, a.slot);
    }
  } finally {
    other.kill();
  }
});

test('while ps cannot answer, a live pid\'s file and reservation are kept and counted', async () => {
  const { home, ws, mg } = fresh({ maxAgents: 1 });
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  register(ws, other.pid, { task: 'weather/a', step: 'S-1', session: 's', since: start });
  const restore = fakePs('fails');
  try {
    assert.deepEqual((await mg.running()).map((r) => r.pid), [other.pid]);
    assert.equal(existsSync(join(home, 'running', `${other.pid}.json`)), true);
    unregister(ws, other.pid);
    writeFileSync(join(home, 'running', `${other.pid}-1.json`), JSON.stringify({ pid: other.pid, pidStart: start, task: 'weather/b', step: 'S-2', since: start }));
    assert.equal((await admit(ws, mg)).ok, false, 'the reservation counts');
    assert.equal(existsSync(join(home, 'running', `${other.pid}-1.json`)), true);
  } finally {
    restore();
    other.kill();
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
  assert.equal(readdirSync(join(home, 'running')).filter((f) => /^\d+-\d+\.json$/.test(f)).length, 1);
  await Promise.all(kids.map((c) => new Promise((r) => (c.on('exit', r), c.kill()))));
  const mine = await admit(ws, mg);
  assert.equal(mine.ok, true, 'the dead holder\'s reservation does not count');
  assert.deepEqual(readdirSync(join(home, 'running')), [`${mine.slot.name}.json`], 'and is removed');
  // A slot given to a run becomes its pid file; one never started goes.
  const run = spawn('sleep', ['5']);
  try {
    register(ws, run.pid, { task: 'weather/a', step: 'S-1', session: 's' }, mine.slot);
    assert.deepEqual(readdirSync(join(home, 'running')), [`${run.pid}.json`]);
    assert.equal((await admit(ws, mg)).ok, false);
  } finally {
    await new Promise((r) => (run.on('exit', r), run.kill()));
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

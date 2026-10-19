import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import resourceGuardLocal, { alive, isStill, OWN_START, stillRuns } from '../plugins/resource-guard-local.mjs';
import { fakePs } from './helpers.mjs';

function guard(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-guard-'));
  return { home, g: resourceGuardLocal({ home }, { pollMs: 20, ...opts }).provides.resourceGuard };
}

const sh = (script) => ['/bin/sh', '-c', script];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logOf = (home) => readFileSync(join(home, 'guard', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const GUARD = new URL('../plugins/resource-guard-local.mjs', import.meta.url).href;
const ownerOf = (home) => {
  try {
    return JSON.parse(readFileSync(join(home, 'guard', 'lock', 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
};
const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(ok, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

// The pid of a child that has exited.
async function deadPid() {
  const c = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => c.on('exit', r));
  return c.pid;
}

test('one job at a time: a second waits its turn, and the status shows who holds and who waits', async () => {
  const { home, g } = guard();
  const f = join(home, 'order.txt');
  const job = (name) =>
    g.run({ session: `kirunak:${name}`, what: 'tests', maxMinutes: 1, cwd: home, command: sh(`echo start-${name} >> ${f}; sleep 0.3; echo end-${name} >> ${f}`) });
  const a = job('a');
  await sleep(60);
  const b = job('b');
  await sleep(100);
  const st = g.status();
  assert.equal(st.held.session, 'kirunak:a');
  assert.deepEqual(st.queued.map((q) => q.session), ['kirunak:b']);
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.exitCode, rb.exitCode], [0, 0]);
  assert.deepEqual(readFileSync(f, 'utf8').trim().split('\n'), ['start-a', 'end-a', 'start-b', 'end-b']);
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
  assert.equal(g.status().held, null);
  assert.deepEqual(logOf(home).map((x) => [x.session, x.what, x.exitCode]), [['kirunak:a', 'tests', 0], ['kirunak:b', 'tests', 0]]);
});

test('past maxMinutes the job and its children are killed, exit code 124', async () => {
  const { home, g } = guard({ killAfterMs: 500 });
  const pidFile = join(home, 'child.pid');
  const t0 = Date.now();
  const r = await g.run({ session: 's', what: 'hang', maxMinutes: 0.01, cwd: home, command: sh(`sleep 30 & echo $! > ${pidFile}; sleep 30`) });
  assert.equal(r.exitCode, 124);
  assert.ok(Date.now() - t0 < 5000, 'killed at the deadline, not after the sleep');
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false, 'the background child is gone too');
  assert.equal(logOf(home)[0].exitCode, 124);
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
});

test('a dead owner\'s lock is taken over; a live owner\'s is waited for', async () => {
  const { home, g } = guard();
  const lock = join(home, 'guard', 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ session: 'gone', what: 'build', pid: await deadPid(), since: new Date().toISOString() }));
  assert.equal(g.status().held, null);
  const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ok') });
  assert.equal(r.exitCode, 0);
  assert.match(r.log, /ok/);

  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ session: 'other', what: 'build', pid: process.pid, pidStart: OWN_START, since: new Date().toISOString() }));
  let done = false;
  const waiting = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ok') }).then((x) => ((done = true), x));
  await sleep(200);
  assert.equal(done, false);
  assert.equal(g.status().held.session, 'other');
  rmSync(lock, { recursive: true });
  assert.equal((await waiting).exitCode, 0);
});

test('a command that cannot start ends with 127 and releases the lock', async () => {
  const { home, g } = guard();
  const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: ['/no/such/program'] });
  assert.equal(r.exitCode, 127);
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
});

test('the estimate: the median of the last ten jobs with the same what, 15 minutes with no history', () => {
  const { home, g } = guard();
  assert.deepEqual(g.status(), { held: null, queued: [], estimateMinutes: 0 });
  const lines = [...Array(12)].map((_, i) => ({ what: 'tests', minutes: i + 1, exitCode: 0 }));
  writeFileSync(join(home, 'guard', 'log.jsonl'), [...lines, { what: 'build', minutes: 100, exitCode: 0 }].map((x) => JSON.stringify(x) + '\n').join(''));
  mkdirSync(join(home, 'guard', 'lock'));
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 'a', what: 'tests', pid: process.pid, pidStart: OWN_START, since: new Date().toISOString() }));
  writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', session: 'b', what: 'lint', pid: process.pid, pidStart: OWN_START, since: new Date().toISOString() }) + '\n');
  const st = g.status();
  assert.equal(st.held.estimateMinutes, 7.5, 'the last ten are 3..12');
  assert.equal(st.queued[0].estimateMinutes, 15);
  assert.equal(st.estimateMinutes, 22.5);
});

test('claims: one holder at a time, released by its holder, every resource ever claimed listed', () => {
  const { g } = guard();
  g.claim('phone', 'kirunak:a', 'smoke test', 1);
  assert.throws(() => g.claim('phone', 'kirunak:b', 'other test'), /phone is claimed by kirunak:a until .*: smoke test/);
  assert.deepEqual(g.resources(), [{ id: 'phone', name: 'phone', state: 'claimed by kirunak:a' }]);
  assert.equal(g.release('phone', 'kirunak:b'), false);
  assert.equal(g.release('phone', 'kirunak:a'), true);
  assert.deepEqual(g.resources(), [{ id: 'phone', name: 'phone', state: 'free' }]);
  assert.equal(g.claim('phone', 'kirunak:b', 'other test').by, 'kirunak:b');
});

test('a k run stopped by SIGINT ends its job\'s process group and frees the lock within a second', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-guard-'));
  const src = `import g from ${JSON.stringify(GUARD)};
g({ home: ${JSON.stringify(home)} }, { pollMs: 20 }).provides.resourceGuard.run({ session: 's', what: 'build', maxMinutes: 1, cwd: ${JSON.stringify(home)}, command: ['/bin/sh', '-c', 'sleep 30 & sleep 30'] });`;
  const run = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'ignore' });
  const exited = new Promise((r) => run.on('exit', (code, signal) => r({ code, signal })));
  await until(() => ownerOf(home)?.job);
  const { pid, job } = ownerOf(home);
  assert.equal(pid, run.pid, 'pid stays the k run\'s; job is the command\'s');
  assert.equal(groupAlive(job), true);
  assert.equal(isStill(job, ownerOf(home).jobStart), true, 'jobStart is the job\'s start');
  const t0 = Date.now();
  run.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.ok(Date.now() - t0 < 1000, `stopped in ${Date.now() - t0} ms`);
  assert.equal(groupAlive(job), false, 'the job and its background child are gone');
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
  assert.equal(logOf(home)[0].what, 'build');
});

test('a dead owner\'s job that still runs is ended before the lock is taken over', async () => {
  const { home, g } = guard({ killAfterMs: 500 });
  const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  mkdirSync(join(home, 'guard', 'lock'), { recursive: true });
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 'gone', what: 'build', pid: await deadPid(), job: orphan.pid, jobStart: new Date().toISOString(), since: new Date().toISOString() }));
  const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh(`kill -0 ${orphan.pid} 2>/dev/null && echo orphan-alive || echo orphan-gone`) });
  assert.equal(r.exitCode, 0);
  assert.match(r.log, /orphan-gone/);
  assert.equal(groupAlive(orphan.pid), false);
});

test('a dead owner\'s job pid that started at another time, or at no recorded time, is not killed; the lock is taken over', async () => {
  for (const jobStart of [new Date(Date.now() - 3600000).toISOString(), undefined]) {
    const { home, g } = guard({ killAfterMs: 500 });
    const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    mkdirSync(join(home, 'guard', 'lock'), { recursive: true });
    writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 'gone', what: 'build', pid: await deadPid(), job: other.pid, jobStart, since: new Date().toISOString() }));
    const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh(`kill -0 ${other.pid} 2>/dev/null && echo other-alive || echo other-gone`) });
    assert.match(r.log, /other-alive/, `jobStart ${jobStart}`);
    assert.equal(groupAlive(other.pid), true);
    assert.equal(existsSync(join(home, 'guard', 'lock')), false);
    other.kill();
  }
});

test('isStill answers for the process that started at the recorded time only', async () => {
  const p = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  assert.equal(isStill(p.pid, start), true);
  assert.equal(isStill(p.pid, new Date(Date.now() + 30000).toISOString()), true, 'a start recorded 30 s late still matches');
  assert.equal(isStill(p.pid, new Date(Date.now() - 3600000).toISOString()), false);
  assert.equal(isStill(p.pid, undefined), false);
  const gone = new Promise((r) => p.on('exit', r));
  p.kill();
  await gone;
  assert.equal(isStill(p.pid, start), false, 'no such process');
  assert.equal(stillRuns(p.pid, start), false);
});

test('while ps cannot answer (it fails, prints no time, or is missing) isStill is null and a live pid still runs', () => {
  const p = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  try {
    for (const kind of ['fails', 'garbled', 'missing']) {
      const restore = fakePs(kind);
      try {
        assert.equal(isStill(p.pid, start), null, kind);
        assert.equal(stillRuns(p.pid, start), true, kind);
        assert.equal(stillRuns(p.pid, undefined), false, `${kind}: no start recorded is still dead`);
      } finally {
        restore();
      }
    }
  } finally {
    p.kill();
  }
});

test('a ps that answers no such process (exit 1) is believed: the pid is gone', () => {
  const p = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  const restore = fakePs('gone');
  try {
    assert.equal(isStill(p.pid, start), false);
    assert.equal(stillRuns(p.pid, start), false);
  } finally {
    restore();
    p.kill();
  }
});

test('while ps cannot answer, a live owner\'s lock is waited for, and a dead owner\'s job is neither killed nor run beside', async () => {
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const job = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const start = new Date().toISOString();
  try {
    for (const owner of [{ pid: other.pid, pidStart: start }, { pid: await deadPid(), pidStart: start, job: job.pid, jobStart: start }]) {
      const { home, g } = guard({ killAfterMs: 300 });
      const lock = join(home, 'guard', 'lock');
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'o', session: 'owner', what: 'build', since: start, ...owner }));
      const restore = fakePs('fails');
      let running;
      try {
        if (!owner.job) assert.equal(g.status().held?.session, 'owner');
        running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') });
        assert.equal(await Promise.race([running, sleep(1000).then(() => null)]), null, `the job waited (owner ${JSON.stringify(owner)})`);
        assert.equal(ownerOf(home).session, 'owner', 'the lock is the owner\'s still');
        assert.equal(groupAlive(job.pid), true, 'the job is not killed');
      } finally {
        restore();
      }
      // Once ps answers again, the wait ends: the dead owner's job is that job, so it is ended and the lock taken.
      if (!owner.job) rmSync(lock, { recursive: true, force: true });
      assert.equal((await running).exitCode, 0);
    }
    assert.equal(groupAlive(job.pid), false, 'ended once ps could tell it was the dead owner\'s');
  } finally {
    other.kill();
    job.kill();
  }
});

test('a dead owner\'s job pid that names a group this user cannot signal is not waited on', async (t) => {
  // A root-owned group leader stands in for a job pid reused since the owner died.
  const rows = spawnSync('ps', ['-axo', 'pid=,pgid=,uid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
  const other = rows.find(([pid, pgid, uid]) => pid === pgid && uid === '0' && Number(pid) > 1);
  if (!other || process.getuid() === 0) return t.skip('no group leader of another user');
  const { home, g } = guard({ killAfterMs: 300 });
  const lock = join(home, 'guard', 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ session: 'gone', what: 'build', pid: await deadPid(), job: Number(other[0]), jobStart: new Date().toISOString(), since: new Date().toISOString() }));
  const running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') });
  const r = await Promise.race([running, sleep(1000).then(() => null)]);
  if (!r) rmSync(lock, { recursive: true, force: true });
  await running;
  assert.equal(r?.exitCode, 0, `the job waited behind group ${other[0]}`);
});

test('a pid of another user is not alive: it is never kirunak\'s, so nothing waits for it', (t) => {
  const rows = spawnSync('ps', ['-axo', 'pid=,uid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
  const root = rows.find(([pid, uid]) => uid === '0' && Number(pid) > 1);
  if (!root || process.getuid() === 0) return t.skip('no process of another user');
  assert.equal(alive(Number(root[0])), false);
});

test('an owner or a waiter whose pid is now another process, or that recorded no start, is dead: the lock is taken over at once', async () => {
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    for (const pidStart of [new Date(Date.now() - 3600000).toISOString(), undefined]) {
      const { home, g } = guard();
      mkdirSync(join(home, 'guard', 'lock'), { recursive: true });
      writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ id: 'o', session: 'gone', what: 'build', pid: other.pid, pidStart, since: new Date().toISOString() }));
      writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', session: 'gone too', what: 'lint', pid: other.pid, pidStart, since: new Date().toISOString() }) + '\n');
      assert.deepEqual(g.status(), { held: null, queued: [], estimateMinutes: 0 }, `pidStart ${pidStart}`);
      const running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') });
      const r = await Promise.race([running, sleep(1000).then(() => null)]);
      if (!r) rmSync(join(home, 'guard'), { recursive: true, force: true });
      await running;
      assert.equal(r?.exitCode, 0, `the job waited behind pid ${other.pid} (pidStart ${pidStart})`);
      assert.equal(alive(other.pid), true, 'the process is left alone');
    }
  } finally {
    other.kill();
  }
});

test('a lock removed between the waiter\'s checks counts as no lock', async () => {
  const { home, g } = guard();
  const lock = join(home, 'guard', 'lock');
  mkdirSync(lock, { recursive: true });
  const real = fs.existsSync;
  // The holder releases just after the waiter saw the lock, before it reads owner.json and the lock's age.
  fs.existsSync = (p) => {
    const there = real(p);
    if (p === lock && there) {
      fs.existsSync = real;
      syncBuiltinESMExports();
      rmSync(lock, { recursive: true });
    }
    return there;
  };
  syncBuiltinESMExports();
  try {
    const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ok') });
    assert.equal(r.exitCode, 0);
  } finally {
    fs.existsSync = real;
    syncBuiltinESMExports();
  }
});

test('the lock is released inside the queue mutex', async () => {
  const { home, g } = guard();
  let done = false;
  const running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('sleep 0.2') }).then((x) => ((done = true), x));
  await until(() => ownerOf(home)?.job);
  mkdirSync(join(home, 'guard', 'queue.edit'));
  await sleep(600);
  assert.equal(done, false);
  assert.equal(existsSync(join(home, 'guard', 'lock')), true, 'not released while another holds the mutex');
  rmSync(join(home, 'guard', 'queue.edit'), { recursive: true });
  assert.equal((await running).exitCode, 0);
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import resourceGuardLocal, { alive, killTree } from '../plugins/resource-guard-local.mjs';
import { read as readLease } from '../lib/lease.mjs';
import { shell } from '../lib/os.mjs';
import { wrapped } from '../lib/wrap.mjs';
import { tempDir } from './helpers.mjs';

function guard(opts = {}) {
  const home = tempDir('kirunak-guard-');
  return { home, g: resourceGuardLocal({ home }, { pollMs: 20, ...opts }).provides.resourceGuard };
}

const sh = (script) => [shell(), '-c', script];
// The start a file written before leases recorded beside its pid (E-4): read by nothing now.
const OLD_START = new Date(Date.now() - process.uptime() * 1000).toISOString();
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
    g.run({ session: `kirunak:${name}`, what: 'tests', maxMinutes: 1, cwd: home, command: sh(`echo start-${name} >> order.txt; sleep 0.3; echo end-${name} >> order.txt`) });
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

test('a job\'s started is called once the guard holds the lock for it, just before its command starts, not while it waits (gulnya/heavy-retry-unchanged review-2)', async () => {
  const { home, g } = guard();
  const f = join(home, 'order.txt');
  const job = (name) =>
    g.run({ session: `kirunak:${name}`, what: 'tests', maxMinutes: 1, cwd: home, command: sh(`echo start-${name} >> order.txt; sleep 0.3; echo end-${name} >> order.txt`), started: () => fs.appendFileSync(f, `started-${name}\n`) });
  const a = job('a');
  await sleep(60);
  const b = job('b');
  await Promise.all([a, b]);
  assert.deepEqual(readFileSync(f, 'utf8').trim().split('\n'), ['started-a', 'start-a', 'end-a', 'started-b', 'start-b', 'end-b']);
});

// A node job that starts a child of its own attached, writes its pid to the file named and stays, on every OS.
const PARENT = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[1], String(c.pid));
setTimeout(() => {}, 30000);`;

// Windows has no process groups, no TERM a process can ignore and no signal one process can send another: those
// tests run on macOS and Linux, and test/wrap.test.mjs ends a wrapper's tree on every OS (asilak/kirunak-cross-platform
// E-3).
const POSIX_ONLY = process.platform === 'win32' && 'Windows has no process groups and no signal but an end at once';

test('past maxMinutes the job and its children are killed, exit code 124', async () => {
  const { home, g } = guard({ killAfterMs: 500 });
  const pidFile = join(home, 'child.pid');
  const t0 = Date.now();
  // Two seconds, so a slow start (a busy Windows, a node behind the wrapper's node) still writes the child's pid.
  const r = await g.run({ session: 's', what: 'hang', maxMinutes: 2 / 60, cwd: home, command: [process.execPath, '-e', PARENT, pidFile] });
  assert.equal(r.exitCode, 124);
  assert.ok(Date.now() - t0 < 5000, 'killed at the deadline, not after the sleep');
  const child = Number(readFileSync(pidFile, 'utf8'));
  await until(() => !alive(child), 3000).catch(() => {});
  assert.equal(alive(child), false, 'the job\'s child is gone too');
  assert.equal(logOf(home)[0].exitCode, 124);
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
});

// A node process that starts a grandchild in a process group of its own (as Claude Code starts a background Bash
// job), writes its pid to pidFile and stays alive, as the step's claude does while its job runs. The grandchild
// ignores TERM when stubborn, so only a KILL ends it.
const DETACHES = `const [f, stubborn] = process.argv.slice(1);
const c = require('child_process').spawn('/bin/sh', ['-c', (stubborn ? 'trap "" TERM; ' : '') + 'sleep 30'], { detached: true, stdio: 'ignore' });
require('fs').writeFileSync(f, String(c.pid));
setTimeout(() => {}, 30000);`;

test('past maxMinutes a grandchild in a process group of its own is killed too', { skip: POSIX_ONLY && `${POSIX_ONLY}: a grandchild started detached outlives its job there, the known gap` }, async () => {
  const { home, g } = guard({ killAfterMs: 500 });
  const pidFile = join(home, 'grandchild.pid');
  const r = await g.run({ session: 's', what: 'hang', maxMinutes: 0.01, cwd: home, command: [process.execPath, '-e', DETACHES, pidFile] });
  assert.equal(r.exitCode, 124);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await until(() => !groupAlive(grandchild), 3000).catch(() => {});
  assert.equal(groupAlive(grandchild), false, 'the grandchild\'s group is gone');
});

test('killTree ends every descendant whatever its group, KILLing what ignores TERM, and leaves the rest alone', { skip: POSIX_ONLY }, async () => {
  const dir = tempDir('kirunak-kill-');
  const pidFile = join(dir, 'grandchild.pid');
  const step = spawn(process.execPath, ['-e', DETACHES, pidFile, 'stubborn'], { detached: true, stdio: 'ignore' });
  const bystander = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'));
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await sleep(100);
  const t0 = Date.now();
  await killTree(step.pid, 300);
  assert.ok(Date.now() - t0 < 3000, 'KILL after the grace, not after the sleep');
  await until(() => !groupAlive(step.pid) && !groupAlive(grandchild), 2000).catch(() => {});
  assert.equal(groupAlive(step.pid), false, 'the step\'s group is gone');
  assert.equal(groupAlive(grandchild), false, 'the grandchild, in a group of its own and ignoring TERM, is gone');
  assert.equal(alive(bystander.pid), true, 'a process that is no descendant runs on');
  process.kill(-bystander.pid, 'SIGKILL');
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
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ session: 'other', what: 'build', pid: process.pid, pidStart: OLD_START, since: new Date().toISOString() }));
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
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 'a', what: 'tests', pid: process.pid, pidStart: OLD_START, since: new Date().toISOString() }));
  writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', session: 'b', what: 'lint', pid: process.pid, pidStart: OLD_START, since: new Date().toISOString() }) + '\n');
  const st = g.status();
  assert.equal(st.held.estimateMinutes, 7.5, 'the last ten are 3..12');
  assert.equal(st.queued[0].estimateMinutes, 15);
  assert.equal(st.estimateMinutes, 22.5);
});

test('claims: one holder at a time, released by its holder, every resource ever claimed listed', () => {
  const { g } = guard();
  g.claim('phone', 'kirunak:a', 'smoke test', 1);
  assert.throws(() => g.claim('phone', 'kirunak:b', 'other test'), /phone is claimed by kirunak:a until .*: smoke test/);
  assert.deepEqual(g.resources(), [{ id: 'phone', name: 'phone', state: 'claimed by kirunak:a', by: 'kirunak:a', why: 'smoke test' }]);
  assert.equal(g.release('phone', 'kirunak:b'), false);
  assert.equal(g.release('phone', 'kirunak:a'), true);
  assert.deepEqual(g.resources(), [{ id: 'phone', name: 'phone', state: 'free' }]);
  assert.equal(g.claim('phone', 'kirunak:b', 'other test').by, 'kirunak:b');
});

test('a k run stopped by SIGINT ends its job\'s process group and frees the lock within a second', { skip: POSIX_ONLY && `${POSIX_ONLY}: a SIGINT sent there ends k run at once` }, async () => {
  const home = tempDir('kirunak-guard-');
  const src = `import g from ${JSON.stringify(GUARD)};
g({ home: ${JSON.stringify(home)} }, { pollMs: 20 }).provides.resourceGuard.run({ session: 's', what: 'build', maxMinutes: 1, cwd: ${JSON.stringify(home)}, command: ['/bin/sh', '-c', 'sleep 30 & sleep 30'] });`;
  const run = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'ignore' });
  const exited = new Promise((r) => run.on('exit', (code, signal) => r({ code, signal })));
  await until(() => ownerOf(home)?.job);
  const { pid, job } = ownerOf(home);
  assert.equal(pid, run.pid, 'pid stays the k run\'s; job is the command\'s');
  assert.equal(groupAlive(job), true);
  assert.equal(ownerOf(home).jobStart, undefined, 'no start time is written (AC-5)');
  const t0 = Date.now();
  run.kill('SIGINT');
  assert.deepEqual(await exited, { code: 130, signal: null });
  assert.ok(Date.now() - t0 < 1000, `stopped in ${Date.now() - t0} ms`);
  assert.equal(groupAlive(job), false, 'the job and its background child are gone');
  assert.equal(existsSync(join(home, 'guard', 'lock')), false);
  assert.equal(logOf(home)[0].what, 'build');
});

// A process that runs until killed, on every OS.
const idle = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });

test('E-5: a gone owner\'s job that may still run holds the lock, is waited for and never killed, the wait said once; once it ends the lock is taken', async () => {
  const job = idle();
  const { home, g } = guard({ killAfterMs: 300 });
  const lock = join(home, 'guard', 'lock');
  mkdirSync(lock, { recursive: true });
  const since = new Date().toISOString();
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'o', lease: 1, session: 'owner', what: 'build', since, pid: await deadPid(), job: job.pid }));
  const said = [];
  try {
    assert.deepEqual(g.status().held, { session: 'owner', what: 'build', since, estimateMinutes: 15, orphan: true });
    const running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran'), say: (l) => said.push(l) });
    assert.equal(await Promise.race([running, sleep(1000).then(() => null)]), null, 'the job waited');
    assert.equal(alive(job.pid), true, 'the owner\'s job is not killed');
    const [line, ...more] = logOf(home);
    assert.deepEqual({ ...line, ts: typeof line.ts }, { ts: 'string', what: 'wait', session: 's', pid: job.pid, reason: 'the owner is gone, its job may run' });
    assert.deepEqual(more, [], 'one line however many polls');
    assert.deepEqual(said, [`waits: the lock's holder is gone, but its job (pid ${job.pid}) may still run, so it is waited for, never killed`]);
    job.kill();
    const r = await running;
    assert.equal(r.exitCode, 0);
    assert.match(r.log, /ran/);
    assert.equal(g.status().held, null);
    assert.deepEqual(logOf(home).map((x) => [x.what, typeof x.minutes]), [['wait', 'undefined'], ['x', 'number']], 'the wait line is no job');
  } finally {
    job.kill();
  }
});

test('AC-6: a gone owner\'s job whose wrapper still holds the job\'s lease is that job: it is ended with its child, said once, and the lock taken', async () => {
  const { home, g } = guard({ killAfterMs: 300 });
  const lock = join(home, 'guard', 'lock');
  mkdirSync(lock, { recursive: true });
  const lease = join(home, 'guard', 'jobs', 'o');
  const pidFile = join(home, 'child.pid');
  const [bin, ...args] = wrapped([process.execPath, '-e', PARENT, pidFile], { lease });
  const job = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  try {
    await until(() => existsSync(pidFile) && readLease(lease)?.holder?.child);
    const child = Number(readFileSync(pidFile, 'utf8'));
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'o', lease: 1, session: 'owner', what: 'build', since: new Date().toISOString(), pid: await deadPid(), job: job.pid }));
    assert.equal(g.status().held.orphan, true, 'held while its wrapper runs');
    const said = [];
    const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: [process.execPath, '-e', "console.log('ran')"], say: (l) => said.push(l) });
    assert.equal(r.exitCode, 0, r.log);
    assert.match(r.log, /ran/);
    assert.equal(alive(job.pid), false, 'the gone owner\'s job is ended');
    await until(() => !alive(child), 3000).catch(() => {});
    assert.equal(alive(child), false, 'and its child');
    assert.deepEqual(said, [`ends the job (pid ${job.pid}) of the lock's holder, which is gone: its wrapper's lease tells it is that job`]);
    assert.deepEqual(logOf(home).map((x) => [x.what, x.pid ?? null]), [['ended', job.pid], ['x', null]]);
    assert.equal(existsSync(lease), false, 'its lease goes, by its wrapper or with the lock');
  } finally {
    if (alive(job.pid)) await killTree(job.pid, 300);
  }
});

test('AC-6: a job runs under the wrapper, which holds guard/jobs/<the owner\'s id> naming the job while it runs; its output goes to job.output as it comes', async () => {
  const { home, g } = guard();
  const chunks = [];
  const script = "const fs = require('fs'); const [jobs, owner] = process.argv.slice(1); const [id] = fs.readdirSync(jobs); " +
    "const h = JSON.parse(fs.readFileSync(jobs + '/' + id + '/holder.json', 'utf8')); const o = JSON.parse(fs.readFileSync(owner, 'utf8')); " +
    "console.log(id === o.id, h.child === process.pid, o.job === h.pid); console.error('to stderr');";
  const command = [process.execPath, '-e', script, join(home, 'guard', 'jobs'), join(home, 'guard', 'lock', 'owner.json')];
  const r = await g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command, output: (b, stream) => chunks.push([stream, String(b)]) });
  assert.equal(r.exitCode, 0, r.log);
  const of = (stream) => chunks.filter(([s]) => s === stream).map(([, b]) => b).join('');
  assert.equal(of('stdout'), 'true true true\n', 'the owner\'s id names the lease, which names the wrapper and its command');
  assert.match(of('stderr'), /to stderr/);
  assert.deepEqual(readdirSync(join(home, 'guard', 'jobs')), [], 'the lease is let go');
});

test('AC-5: alive(pid) is kill 0 on every OS: this process and a running child are alive, an ended one is not, and no pid at all is not', async () => {
  const p = idle();
  assert.equal(alive(process.pid), true);
  assert.equal(alive(p.pid), true);
  const gone = new Promise((r) => p.on('exit', r));
  p.kill();
  await gone;
  assert.equal(alive(p.pid), false);
  for (const no of [0, -1, null, undefined, 1.5, 'x']) assert.equal(alive(no), false, String(no));
});

test('E-4: owner.json and a queue line written before leases (a pid and pidStart, no lease) are read by their pid alone, held while it runs and dropped once it goes', async () => {
  const other = idle();
  const start = new Date().toISOString();
  try {
    const { home, g } = guard();
    const lock = join(home, 'guard', 'lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'o', session: 'owner', what: 'build', since: start, pid: other.pid, pidStart: start }));
    writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', session: 'old waiter', what: 'lint', since: start, pid: other.pid, pidStart: start }) + '\n');
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(join(lock, 'owner.json'), old, old);
    assert.equal(g.status().held?.session, 'owner', 'no lease to go stale: the pid decides');
    assert.deepEqual(g.status().queued.map((q) => q.session), ['old waiter']);
    const running = g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') });
    assert.equal(await Promise.race([running, sleep(1000).then(() => null)]), null, 'the job waited behind the old owner');
    other.kill();
    const r = await running;
    assert.equal(r.exitCode, 0, 'the old owner and waiter are gone with their pid');
    assert.deepEqual(g.status(), { held: null, queued: [], estimateMinutes: 0 });
  } finally {
    other.kill();
  }
});

test('a gone owner whose job has ended holds nothing, and the next job takes the lock at once', async () => {
  const { home, g } = guard();
  mkdirSync(join(home, 'guard', 'lock'), { recursive: true });
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ id: 'o', lease: 1, session: 'owner', what: 'build', since: new Date().toISOString(), pid: await deadPid(), job: await deadPid() }));
  assert.equal(g.status().held, null);
  const r = await Promise.race([g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') }), sleep(3000).then(() => null)]);
  assert.equal(r?.exitCode, 0);
});

test('a dead owner\'s job pid that names a group this user cannot signal is not waited on', { skip: POSIX_ONLY }, async (t) => {
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

test('a pid of another user is not alive: it is never kirunak\'s, so nothing waits for it', { skip: process.platform === 'win32' && 'Windows has no ps to name a process of another user' }, (t) => {
  const rows = spawnSync('ps', ['-axo', 'pid=,uid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/));
  const root = rows.find(([pid, uid]) => uid === '0' && Number(pid) > 1);
  if (!root || process.getuid() === 0) return t.skip('no process of another user');
  assert.equal(alive(Number(root[0])), false);
});

test('AC-4, E-9: an owner and a waiter whose pid another process has by now, their leases untouched for a minute, are dead: the lock is taken over at once, that process left alone', async () => {
  const other = idle();
  try {
    const { home, g } = guard();
    const lock = join(home, 'guard', 'lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'o', lease: 1, session: 'gone', what: 'build', pid: other.pid, since: new Date().toISOString() }));
    mkdirSync(join(home, 'guard', 'waiting', 'q'), { recursive: true });
    writeFileSync(join(home, 'guard', 'waiting', 'q', 'holder.json'), JSON.stringify({ id: 'q', pid: other.pid }));
    writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', lease: 1, session: 'gone too', what: 'lint', pid: other.pid, since: new Date().toISOString() }) + '\n');
    assert.equal(g.status().held?.session, 'gone', 'fresh: held');
    const old = new Date(Date.now() - 61000);
    for (const f of [join(lock, 'owner.json'), join(home, 'guard', 'waiting', 'q', 'holder.json')]) fs.utimesSync(f, old, old);
    assert.deepEqual(g.status(), { held: null, queued: [], estimateMinutes: 0 });
    const r = await Promise.race([g.run({ session: 's', what: 'x', maxMinutes: 1, cwd: home, command: sh('echo ran') }), sleep(3000).then(() => null)]);
    assert.equal(r?.exitCode, 0, `the job waited behind pid ${other.pid}`);
    assert.equal(existsSync(join(home, 'guard', 'waiting', 'q')), false, 'the dead waiter\'s lease goes with its line');
    assert.equal(alive(other.pid), true, 'the process is left alone');
  } finally {
    other.kill();
  }
});

test('E-8: a job whose lock was taken over while its machine slept gives way: it is ended, the log says so, and the new holder keeps the lock', async () => {
  const { home, g } = guard({ killAfterMs: 300, renewMs: 50 });
  const lock = join(home, 'guard', 'lock');
  const said = [];
  const running = g.run({ session: 's', what: 'build', maxMinutes: 1, cwd: home, command: [process.execPath, '-e', 'setTimeout(() => {}, 8000)'], say: (l) => said.push(l) });
  await until(() => ownerOf(home)?.job);
  const job = ownerOf(home).job;
  // Another taker found the lease stale and took the lock over.
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ id: 'new', lease: 1, session: 'other', what: 'tests', pid: process.pid, since: new Date().toISOString() }));
  const t0 = Date.now();
  const r = await running;
  assert.ok(Date.now() - t0 < 4000, `ended in ${Date.now() - t0} ms, not run out`);
  assert.equal(r.lost, true);
  assert.deepEqual(said, ['gave way: the lock was taken over while this machine slept, so its job is ended']);
  assert.ok(logOf(home).some((x) => x.what === 'lost' && x.pid === job));
  assert.equal(alive(job), false, 'its job is ended');
  assert.equal(ownerOf(home)?.id, 'new', 'the new holder keeps the lock');
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

test('queue(): the holder and the live waiters in the order they came, with their stated lengths and usual; a dead waiter is left out (E-6)', async () => {
  const { home, g } = guard();
  assert.deepEqual({ ...g.queue(), now: null }, { now: null, first: null, held: null, waiting: [] });
  writeFileSync(join(home, 'guard', 'log.jsonl'), [3, 5, 4].map((m) => JSON.stringify({ what: 'tests', minutes: m, exitCode: 0 }) + '\n').join(''));
  const f = join(home, 'go');
  const a = g.run({ session: 'kirunak:a', what: 'tests', maxMinutes: 30, expectMinutes: 5, cwd: home, command: sh('while [ ! -e go ]; do sleep 0.05; done') });
  await until(() => ownerOf(home)?.job);
  const b = g.run({ session: 'kirunak:b', what: 'lint', maxMinutes: 10, expectMinutes: null, cwd: home, command: sh('true') });
  await until(() => existsSync(join(home, 'guard', 'queue')) && readFileSync(join(home, 'guard', 'queue'), 'utf8').includes('kirunak:b'));
  // A waiter whose process is gone, queued between them: heavy-lock and this guard drop it, and so does queue().
  const dead = await deadPid();
  const lines = readFileSync(join(home, 'guard', 'queue'), 'utf8');
  writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'x', session: 'gone', what: 'old', pid: Number(dead), pidStart: OLD_START, since: new Date().toISOString(), maxMinutes: 5 }) + '\n' + lines);
  const q = g.queue();
  assert.ok(Date.parse(q.now) > 0);
  assert.equal(q.first, null);
  const { since, ...held } = q.held;
  assert.ok(Date.parse(since) > 0);
  assert.deepEqual(held, { session: 'kirunak:a', what: 'tests', pid: process.pid, expectMinutes: 5, maxMinutes: 30, kind: null, usualMinutes: 4 });
  assert.deepEqual(q.waiting.map(({ queuedAt, ...w }) => (assert.ok(Date.parse(queuedAt) > 0), w)), [
    { session: 'kirunak:b', what: 'lint', pid: process.pid, expectMinutes: null, maxMinutes: 10, kind: null, usualMinutes: null },
  ]);
  writeFileSync(f, '');
  await Promise.all([a, b]);
  assert.equal(g.queue().held, null);
});

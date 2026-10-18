import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import resourceGuardLocal, { alive } from '../plugins/resource-guard-local.mjs';

function guard(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-guard-'));
  return { home, g: resourceGuardLocal({ home }, { pollMs: 20, ...opts }).provides.resourceGuard };
}

const sh = (script) => ['/bin/sh', '-c', script];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logOf = (home) => readFileSync(join(home, 'guard', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

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
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ session: 'other', what: 'build', pid: process.pid, since: new Date().toISOString() }));
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
  writeFileSync(join(home, 'guard', 'lock', 'owner.json'), JSON.stringify({ session: 'a', what: 'tests', pid: process.pid, since: new Date().toISOString() }));
  writeFileSync(join(home, 'guard', 'queue'), JSON.stringify({ id: 'q', session: 'b', what: 'lint', pid: process.pid, since: new Date().toISOString() }) + '\n');
  const st = g.status();
  assert.equal(st.held.estimateMinutes, 7.5, 'the last ten are 3..12');
  assert.equal(st.queued[0].estimateMinutes, 15);
  assert.equal(st.estimateMinutes, 22.5);
});

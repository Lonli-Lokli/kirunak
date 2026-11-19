// Leases (lib/lease.mjs, asilak/kirunak-cross-platform AC-4, E-8, E-9): a directory made with mkdir, its holder file
// touched by its holder, stale when untouched for a minute. Staleness is made here by setting a file's time back.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { besideOf, hold, holderLive, letGo, read, STALE_MS, take } from '../lib/lease.mjs';
import { tempDir } from './helpers.mjs';

const place = () => join(tempDir('kirunak-lease-'), 'lock');
const age = (path, ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('AC-4: a lease is a directory with its holder file; a fresh one refuses a second taker, and once released the next takes it', () => {
  const dir = place();
  const a = take(dir, { what: 'build' });
  assert.ok(a);
  const seen = read(dir);
  assert.equal(seen.stale, false);
  assert.equal(seen.holder.id, a.holder.id);
  assert.equal(seen.holder.pid, process.pid);
  assert.equal(seen.holder.what, 'build');
  assert.equal(take(dir, { what: 'test' }), null, 'a fresh lease is held');
  a.release();
  assert.equal(existsSync(dir), false);
  assert.equal(read(dir), null);
  const b = take(dir, { what: 'test' });
  assert.equal(read(dir).holder.id, b.holder.id);
  b.release();
});

test('E-9: a lease untouched for a minute is stale and taken over; its old holder finds it lost and gives way (E-8)', () => {
  const dir = place();
  const a = take(dir, { what: 'build' });
  age(join(dir, 'holder.json'), STALE_MS + 1000);
  assert.equal(read(dir).stale, true);
  const b = take(dir, { what: 'test' });
  assert.ok(b, 'the stale lease is taken over');
  assert.equal(read(dir).holder.id, b.holder.id);
  assert.equal(a.renew(), false, 'the old holder sees another holder');
  assert.equal(a.lost, true);
  assert.equal(a.update({ job: 1 }), false);
  a.release();
  assert.equal(read(dir).holder.id, b.holder.id, "a lost lease's release leaves the new holder's");
  b.release();
});

test('E-8: a holder whose machine slept, its lease stale but not taken, touches it again and holds it', () => {
  const dir = place();
  const a = take(dir);
  age(join(dir, 'holder.json'), STALE_MS + 1000);
  assert.equal(a.renew(), true);
  assert.equal(read(dir).stale, false);
  assert.equal(take(dir), null);
  a.release();
});

test('a taker that died between mkdir and its holder file leaves a directory that is stale after a minute too', () => {
  const dir = place();
  mkdirSync(dir);
  assert.equal(take(dir), null, 'just made: someone is writing it');
  age(dir, STALE_MS + 1000);
  const b = take(dir);
  assert.ok(b);
  b.release();
});

test('a takeover mutex left by a process that died goes after ten seconds', () => {
  const dir = place();
  take(dir);
  age(join(dir, 'holder.json'), STALE_MS + 1000);
  mkdirSync(`${dir}.take`);
  assert.equal(take(dir), null, 'a live mutex: the takeover waits');
  age(`${dir}.take`, 11_000);
  assert.equal(take(dir), null, 'the dead mutex is cleared, the take is the next one');
  const b = take(dir);
  assert.ok(b);
  b.release();
});

test('keep(): the timer touches the lease, never keeps the process alive, and calls onLost once another took it', async () => {
  const dir = place();
  const file = join(dir, 'holder.json');
  let lost = 0;
  const a = take(dir).keep({ everyMs: 20, onLost: () => lost++ });
  age(file, 30_000);
  await sleep(80);
  assert.ok(Date.now() - read(dir).touched < 5_000, 'touched again');
  age(file, STALE_MS + 1000);
  a.stop();
  const b = take(dir);
  assert.ok(b);
  a.keep({ everyMs: 20, onLost: () => lost++ });
  await sleep(80);
  assert.equal(lost, 1);
  assert.equal(read(dir).holder.id, b.holder.id);
  b.release();
});

test('update() rewrites the holder file beside the id while the lease is this holder\'s', () => {
  const dir = place();
  const a = take(dir, { what: 'build' });
  assert.equal(a.update({ job: 4242, id: 'not mine' }), true);
  const h = JSON.parse(readFileSync(join(dir, 'holder.json'), 'utf8'));
  assert.deepEqual([h.id, h.job, h.what], [a.holder.id, 4242, 'build']);
  a.release();
});

// A process that runs until killed, and the pid of one that has ended, on every OS.
const idle = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
async function deadPid() {
  const c = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => c.on('exit', r));
  return c.pid;
}

test('AC-4: a file held by the lease beside it: hold() makes and keeps it, holderLive() reads it, letGo() removes it', () => {
  const path = join(tempDir('kirunak-held-'), 'run.json');
  writeFileSync(path, '{}');
  assert.ok(hold(path));
  assert.equal(existsSync(besideOf(path)), true);
  assert.equal(read(besideOf(path)).holder.pid, process.pid);
  assert.equal(holderLive(path, process.pid), true);
  age(join(besideOf(path), 'holder.json'), STALE_MS + 1000);
  assert.equal(holderLive(path, process.pid), false, 'a stale lease: its holder is gone, though the pid runs');
  letGo(path);
  assert.equal(existsSync(besideOf(path)), false);
});

test('E-4: a file with no lease beside it, written before leases, is read by its pid alone', async () => {
  const path = join(tempDir('kirunak-held-'), 'run.json');
  writeFileSync(path, '{}');
  assert.equal(holderLive(path, process.pid), true);
  assert.equal(holderLive(path, await deadPid()), false);
  assert.equal(holderLive(path, 77, { isAlive: () => true }), true, 'the caller\'s own pid check');
});

test('hold() refuses a fresh lease whose holder runs, and takes one over at once whose holder is gone or is the one handing it on', async () => {
  const path = join(tempDir('kirunak-held-'), 'lock.json');
  const other = idle();
  try {
    take(besideOf(path), { pid: other.pid });
    assert.equal(hold(path), null, 'held by a live holder');
    assert.ok(hold(path, {}, { from: other.pid }), 'handed on');
    letGo(path);
    take(besideOf(path), { pid: await deadPid() });
    assert.ok(hold(path), 'its holder is gone');
    assert.equal(read(besideOf(path)).holder.pid, process.pid);
    letGo(path);
  } finally {
    other.kill();
  }
});

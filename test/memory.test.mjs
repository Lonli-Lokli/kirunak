import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freemem } from 'node:os';
import { memoryCheck, waitForMemory } from '../lib/memory.mjs';
import { freeMemory } from '../lib/os.mjs';

// asilak/kirunak-cross-platform AC-11: the memory a heavy job or a session starts with.

const MB = 2 ** 20;
const ws = (freeMemoryMB) => ({ machine: { maxAgents: 2, maxHeavy: 1, ...(freeMemoryMB === undefined ? {} : { freeMemoryMB }) } });

test('freeMemory() is os.freemem() on every OS', () => {
  const a = freeMemory();
  assert.ok(Number.isInteger(a) && a > 0);
  assert.ok(Math.abs(a - freemem()) < 512 * MB, 'the same reading, give or take what moved between the two');
});

test('memoryCheck: with no margin it passes and says what is free; with one, it passes at or above it and not under it', () => {
  const free = () => 3000 * MB + 5;
  assert.deepEqual(memoryCheck(ws(), { free }), { ok: true, why: null, line: '3000 MB of memory free (no machine.freeMemoryMB to wait for)' });
  assert.deepEqual(memoryCheck(ws(0), { free }).ok, true, 'a margin of 0 is none');
  assert.deepEqual(memoryCheck(ws(3000), { free }), { ok: true, why: null, line: null });
  assert.deepEqual(memoryCheck(ws(3001), { free }), { ok: false, why: '3000 MB of memory free, under machine.freeMemoryMB (3001 MB)', line: null });
  assert.equal(memoryCheck(null, { free }).ok, true, 'no workspace, no margin');
});

test('waitForMemory waits while under the margin, says so once and again when it starts; with no margin it says the line unless told not to', async () => {
  const readings = [1000, 1200, 1500, 2600].map((x) => x * MB);
  const said = [];
  const slept = [];
  await waitForMemory(ws(2048), { free: () => readings.shift(), say: (l) => said.push(l), sleep: async (ms) => slept.push(ms), everyMs: 7 });
  assert.deepEqual(said, ['waits for memory: 1000 MB of memory free, under machine.freeMemoryMB (2048 MB)', 'memory free again: it starts']);
  assert.deepEqual(slept, [7, 7, 7]);

  const lines = [];
  const never = async () => assert.fail('no wait with no margin');
  await waitForMemory(ws(), { free: () => 900 * MB, say: (l) => lines.push(l), sleep: never });
  await waitForMemory(ws(), { free: () => 900 * MB, say: (l) => lines.push(l), sleep: never, line: false });
  assert.deepEqual(lines, ['900 MB of memory free (no machine.freeMemoryMB to wait for)']);
});

test('a sleep that throws (an owner\'s stop) ends the wait', async () => {
  await assert.rejects(waitForMemory(ws(1e9), { sleep: async () => { throw new Error('stopped'); } }), /stopped/);
});

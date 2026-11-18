import { freeMemory } from './os.mjs';

// The memory a heavy job or a session starts with (asilak/kirunak-cross-platform AC-11). The memory free now
// (lib/os.mjs freeMemory(): os.freemem() on macOS and Linux, the commit left on Windows) is checked against the
// workspace's `machine.freeMemoryMB`. Below it, the start waits, as a start waits for a machine slot. With none set
// nothing waits, and a line says what is free.

const MB = 2 ** 20;

// → { ok, why, line }: ok false and `why` while below the margin; with no margin, ok and `line` naming what is free.
// With no margin and no `line` wanted nothing is read (on Windows the reading takes two seconds).
export function memoryCheck(ws, { free = freeMemory, line = true } = {}) {
  const margin = Number(ws?.machine?.freeMemoryMB);
  if (!(margin > 0) && !line) return { ok: true, why: null, line: null };
  const mb = Math.floor(free() / MB);
  if (!(margin > 0)) return { ok: true, why: null, line: `${mb} MB of memory free (no machine.freeMemoryMB to wait for)` };
  if (mb >= margin) return { ok: true, why: null, line: null };
  return { ok: false, why: `${mb} MB of memory free, under machine.freeMemoryMB (${margin} MB)`, line: null };
}

// Waits until memoryCheck passes, looking every `everyMs`: the wait said once, and the line of an unset margin when
// `line` (a caller says it once a run). `sleep(ms)` is the caller's, so its stop ends the wait.
export async function waitForMemory(ws, { say = () => {}, sleep, everyMs = 30000, free = freeMemory, line = true } = {}) {
  let told = false;
  for (;;) {
    const m = memoryCheck(ws, { free, line });
    if (m.ok) {
      if (m.line) say(m.line);
      if (told) say('memory free again: it starts');
      return;
    }
    if (!told) say(`waits for memory: ${m.why}`);
    told = true;
    await sleep(everyMs);
  }
}

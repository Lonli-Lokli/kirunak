// The lease keeper (lib/lease.mjs keeperOf): a worker thread that renews its process's kept leases every everyMs,
// whatever the main thread is doing, so a lease stays fresh while that thread blocks on a long synchronous call
// (asilak/kirunak-lease-stale-while-blocked). It renews only while the main thread's last beat is within hungMs: a
// holder whose thread hangs still lets its lease go stale, and is taken over.
import { parentPort, workerData } from 'node:worker_threads';
import { renewAt } from './lease.mjs';

const beat = new BigInt64Array(workerData.beat);
const kept = new Map();

const stop = (key) => {
  clearInterval(kept.get(key)?.timer);
  kept.delete(key);
};

parentPort.on('message', (m) => {
  if (m.op === 'remove') return stop(m.key);
  if (m.op !== 'add') return;
  stop(m.key);
  const k = { last: m.last, timer: null };
  k.timer = setInterval(() => {
    if (Date.now() - Number(Atomics.load(beat, 0)) > m.hungMs) return;
    let ok;
    try {
      ok = renewAt(m.dir, m.path, m.id, k.last, m.staleMs);
    } catch {
      ok = null; // the file gone or held open for a moment: asked again next time
    }
    if (ok === true) k.last = Date.now();
    if (ok === false) stop(m.key);
    if (ok !== null) parentPort.postMessage({ key: m.key, ok, last: k.last });
  }, m.everyMs);
  kept.set(m.key, k);
});

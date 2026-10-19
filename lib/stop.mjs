import { constants } from 'node:os';

// Stopping kirunak (Ctrl-C, a TERM, a closed terminal). onStop(fn) registers fn and returns its unregister. On the
// first SIGINT, SIGTERM or SIGHUP every registered fn runs once with the signal's name (a fn may return a promise, which
// is awaited), then the process exits with 128 + the signal's number (130, 143, 129). A second signal while stopping
// exits at once. The handlers are installed only while a fn is registered, so a process with none keeps Node's default.

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// One registry per process, even if two copies of this module are loaded.
const S = (globalThis[Symbol.for('kirunak.stop')] ??= { fns: new Set(), installed: false, stopping: false });

const codeOf = (signal) => 128 + constants.signals[signal];

async function stop(signal) {
  if (S.stopping) process.exit(codeOf(signal));
  S.stopping = true;
  const waits = [];
  for (const fn of [...S.fns]) {
    try {
      const r = fn(signal);
      if (r && typeof r.then === 'function') waits.push(r);
    } catch (e) {
      process.stderr.write(`kirunak: while stopping: ${e?.message ?? e}\n`);
    }
  }
  for (const r of await Promise.allSettled(waits)) {
    if (r.status === 'rejected') process.stderr.write(`kirunak: while stopping: ${r.reason?.message ?? r.reason}\n`);
  }
  process.exit(codeOf(signal));
}
S.handler ??= stop;

function install() {
  if (S.installed) return;
  for (const s of SIGNALS) process.on(s, S.handler);
  S.installed = true;
}

function uninstall() {
  // While stopping the handlers stay, so a second signal still exits through process.exit and its 'exit' handlers.
  if (!S.installed || S.fns.size || S.stopping) return;
  for (const s of SIGNALS) process.off(s, S.handler);
  S.installed = false;
}

export function onStop(fn) {
  const entry = (signal) => fn(signal);
  S.fns.add(entry);
  install();
  return () => {
    S.fns.delete(entry);
    uninstall();
  };
}

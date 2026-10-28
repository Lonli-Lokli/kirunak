import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoLocal, logEvent } from './approval.mjs';
import { KError, refuse } from './errors.mjs';
import { list, pidRuns, quadDamagePath, quadDamageRun } from './bugs.mjs';
import { lock, unlock } from './bug-review.mjs';
import { oneLine } from './drafts.mjs';
import { logLimits } from './limits.mjs';
import { cut } from './notice.mjs';
import { parseId } from './workspace.mjs';

// Quad Damage (gulnya/quad-damage AC-1, AC-9, AC-10, AC-12, AC-13, E-2, E-3, E-4): `k bugs quad-damage`, the owner's
// verb, starts one detached run that takes the bugs marked `quad-damage: yes` one at a time, in the list's own order,
// each fixed and then reviewed while the plan's windows allow. The run file (bugs.mjs's quadDamagePath) says the run
// lives and which bug it is on; its folder $KIRUNAK_HOME/bugs/quad-damage/<started>/ keeps run.log, state.json and
// summary.md. Nothing of a run goes into a repo but what a bug's own work commits.

// The pid that hands the run file to the detached process doing the run.
export const RUN_ENV = 'KIRUNAK_QUAD_DAMAGE';
// The session label of the run's readings in the limits log.
export const LABEL = 'quad-damage';
// The 5-hour window at PAUSE_AT% or more pauses the run until its reset and a minute (AC-9); the week's at STOP_AT% or
// more stops it (AC-10).
export const PAUSE_AT = 90;
export const STOP_AT = 98;
const AFTER_RESET_MS = 60 * 1000;
// The kirunak-push line (AC-13): the summary's first line and each bug in a few words, cut where the hook that hands a
// push to the session cuts it (hooks/escalate-state.mjs's PUSH_MAX).
export const PUSH_MAX = 200;
const WHY_WORDS = 40;
const K = fileURLToPath(new URL('../bin/k.mjs', import.meta.url));

export const runsDir = (home) => join(home, 'bugs', 'quad-damage');
// The live run's state, { pid, started, by, via, folder, bug, phase, try, since, waitUntil }, or null (AC-12).
export const state = quadDamageRun;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// Written whole and renamed into place, so a reader never sees half a file.
function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n');
  renameSync(tmp, path);
}

// 14:05 of a time in a record (isoLocal's), or of a Date.
const hhmm = (t) => (t == null ? '?' : (typeof t === 'string' ? t : isoLocal(t)).slice(11, 16));

// A refusal of a run thrown out of the bug's work, or of the reading before a session: the run stops with `why`.
export class Stop extends Error {
  constructor(why) {
    super(why);
    this.why = why;
  }
}

// --- The run file (E-3) ---

const running = (r) => refuse(`Quad Damage runs already: pid ${r.pid}, started ${r.started ?? 'at a time not recorded'}, ` +
  `${r.bug ? `on ${r.bug} (${r.phase ?? 'starting'}${r.try ? `, try ${r.try}` : ''})` : 'between bugs'}; a second one waits ` +
  'until it ends, and k bugs quad-damage --status shows it');

// Takes the run file for `pid`, made with O_EXCL: refused while another live pid holds it, naming that run. A dead
// pid's file, or one that cannot be read, is taken over, and so is the file of `from`, the process that hands it on,
// keeping its start and folder. → the run's state.
export function claim(home, { pid = process.pid, from = null, via = 'shell', now = new Date() } = {}) {
  const path = quadDamagePath(home);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    if (!existsSync(path)) {
      const mine = { pid, started: isoLocal(now), by: 'owner', via, folder: null, bug: null, phase: null, try: null, since: null, waitUntil: null };
      try {
        writeFileSync(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
        return mine;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        continue;
      }
    }
    const held = readJson(path);
    if (held && (held.pid === pid || (from && held.pid === from))) {
      const mine = { ...held, pid };
      writeJson(path, mine);
      return mine;
    }
    if (held && pidRuns(held.pid)) throw running(held);
    rmSync(path, { force: true });
  }
  throw running(readJson(path) ?? { pid: '?' });
}

// Lets the run file go, only while it is `pid`'s.
export function release(home, pid = process.pid) {
  const path = quadDamagePath(home);
  if (readJson(path)?.pid === pid) rmSync(path, { force: true });
}

// A new run's folder, named by its start (filesystem-safe, local time): 2026-10-27T23-40-05, -2 after it when taken.
function folderFor(home, now) {
  const base = join(runsDir(home), isoLocal(now).slice(0, 19).replace(/:/g, '-'));
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

// The bugs a run takes, in the list's own order (AC-2): those marked `quad-damage: yes`.
export const marked = (ws, home = ws.home) => list(ws, { home }).filter((r) => r.quadDamage);

// --- Keeping the Mac awake (E-2) ---

// `caffeinate -i -w <pid>` on macOS, which ends with the pid; elsewhere nothing. → its process, or null.
export function keepAwake(pid, { platform = process.platform, bin = 'caffeinate' } = {}) {
  if (platform !== 'darwin') return null;
  const child = spawn(bin, ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

// --- One bug's work (S-4 builds it) ---

// A bug's fixing sessions and its review, each after `await ctx.beforeSession()`. ctx: { ws, home, bug (its row from
// list()), folder (the run's), dir (the bug's own in it, made), runner, pid (the run's), beforeSession() → the reading
// (throws Stop), setPhase(phase, try = the current, fields) (fixing|reviewing, before each session), relock() (the
// bug's lock again, after a review() let it go), log(line), now() → Date, sleep(ms) }. → { outcome: 'merged', sha,
// repo } or { outcome: 'waits', why }, either with `stop: '<why>'` to end the run after it; or { stop: '<why>' } alone,
// the bug then not reached. A Stop thrown is { stop } alone; anything else thrown, the bug waits with its message.
export async function workBug() {
  return { outcome: 'waits', why: 'not built yet' };
}

// --- The run ---

// The reading before every session (AC-9, AC-10), logged with the run's label: extra usage, the week at STOP_AT% or
// more, or a reading that failed stops the run (going on blind could reach extra usage); the 5-hour window at PAUSE_AT%
// or more waits until its reset and a minute, then reads again. → the reading the session goes on with.
async function gate(c, setPhase, log) {
  for (;;) {
    let r;
    try {
      r = typeof c.runner?.limits === 'function' ? await c.runner.limits() : { error: 'the runner has no limits reading' };
    } catch (e) {
      r = { error: e.message };
    }
    if (!r || r.error || !r.week || !r.fiveHour) throw new Stop(`the limits reading failed: ${oneLine(r?.error) || 'it gave no windows'}`);
    logLimits(c.ws, r, { label: LABEL, now: c.now() });
    log(`limits: week ${r.week.used}%, 5-hour ${r.fiveHour.used}%${r.overage ? ', extra usage' : ''}`);
    if (r.overage) throw new Stop('the plan is in extra usage');
    if (r.week.used >= STOP_AT) throw new Stop(`the week's limit is at ${Math.trunc(r.week.used)}%`);
    if (r.fiveHour.used < PAUSE_AT) return r;
    const reset = new Date(r.fiveHour.resetsAt * 1000);
    const was = { phase: c.cur.phase, try: c.cur.try };
    setPhase('waiting', was.try, { waitUntil: isoLocal(reset) });
    log(`the 5-hour window is at ${Math.trunc(r.fiveHour.used)}%: waiting until ${hhmm(reset)} and a minute`);
    await c.sleep(Math.max(0, reset.getTime() + AFTER_RESET_MS - c.now().getTime()));
    setPhase(was.phase, was.try, { waitUntil: null });
  }
}

// One bug: passed over when another live pid holds its lock ("being reviewed", the owner's Review & merge); else its
// lock taken with the run's pid for the whole bug, its work done, and the lock let go. → { result: { id, outcome,
// sha?, repo?, why? }, stop }.
async function one(c, row) {
  const id = row.id;
  try {
    lock(c.home, id, { pid: c.pid });
  } catch (e) {
    if (e instanceof KError) return { result: { id, outcome: 'waits', why: 'being reviewed' } };
    throw e;
  }
  const { repo, slug } = parseId(id);
  const dir = join(c.folder, repo, slug);
  mkdirSync(dir, { recursive: true });
  const setPhase = (phase, n = c.cur.try, fields = {}) => c.save({ phase, try: n, since: isoLocal(c.now()), ...fields });
  const ctx = {
    ws: c.ws, home: c.home, bug: row, folder: c.folder, dir, runner: c.runner, pid: c.pid, setPhase,
    beforeSession: () => gate(c, setPhase, ctx.log),
    relock: () => lock(c.home, id, { pid: c.pid }),
    log: (line) => c.log(`${id}: ${line}`), now: c.now, sleep: c.sleep,
  };
  c.save({ bug: id, phase: 'fixing', try: 1, since: isoLocal(c.now()), waitUntil: null });
  c.log(`${id}: taken`);
  let r;
  try {
    r = (await c.work(ctx)) ?? {};
  } catch (e) {
    r = e instanceof Stop ? { stop: e.why } : { outcome: 'waits', why: `its work failed: ${oneLine(e.message)}` };
  } finally {
    unlock(c.home, id, c.pid);
    c.save({ bug: null, phase: null, try: null, since: null, waitUntil: null });
  }
  const stop = r.stop ? oneLine(r.stop) : null;
  if (r.outcome === 'merged') return { result: { id, outcome: 'merged', sha: r.sha ?? null, repo: r.repo ?? row.fixRepo ?? row.repo }, stop };
  if (r.outcome === 'waits') return { result: { id, outcome: 'waits', why: oneLine(r.why) || 'no reason given' }, stop };
  if (stop) return { result: { id, outcome: 'not-reached' }, stop };
  return { result: { id, outcome: 'waits', why: `its work gave no outcome${r.outcome ? ` (${r.outcome})` : ''}` }, stop };
}

// The run itself, in the detached process (or a test's): the run file taken (from the process that started it), the
// Mac kept awake, then before each bug the list read again and the first marked bug not yet tried in this run taken,
// until none is left or the run stops. At the end, or a stop, every marked bug not tried is "not reached", summary.md
// is written and the run file goes. The runner, the work, sleep, the clock and caffeinate are seams for the tests.
// → { folder, started, ended, stopped, bugs, summary }.
export async function run({
  ws, home = ws.home, via = 'shell', from = null, pid = process.pid, runner = ws.seams?.runner, work = workBug,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), caffeinate = keepAwake,
}) {
  const held = claim(home, { pid, from, via, now: now() });
  const folder = held.folder ?? folderFor(home, now());
  mkdirSync(folder, { recursive: true });
  const runLog = join(folder, 'run.log');
  const bugs = [];
  const c = {
    ws, home, folder, runner, pid, work, sleep, now, cur: held,
    log: (line) => appendFileSync(runLog, `${isoLocal(now()).slice(11, 19)} ${line}\n`),
    save: (fields) => {
      c.cur = { ...c.cur, ...fields };
      writeJson(quadDamagePath(home), c.cur);
      writeJson(join(folder, 'state.json'), { ...c.cur, bugs });
    },
  };
  const tried = new Set();
  let stopped = null;
  try {
    c.save({ folder });
    caffeinate(pid);
    c.log(`Quad Damage runs: pid ${pid}, via ${via}`);
    for (;;) {
      const row = marked(ws, home).find((r) => !tried.has(r.id));
      if (!row) break;
      tried.add(row.id);
      const { result, stop } = await one(c, row);
      bugs.push(result);
      c.log(`${row.id}: ${result.outcome}${result.why ? `: ${result.why}` : ''}`);
      if (stop) {
        stopped = stop;
        break;
      }
    }
  } catch (e) {
    stopped = `the run failed: ${oneLine(e.message)}`;
  }
  try {
    if (stopped) for (const r of marked(ws, home)) if (!tried.has(r.id)) bugs.push({ id: r.id, outcome: 'not-reached' });
  } catch {
    // The list could not be read again: the summary names the bugs the run reached.
  }
  const ended = isoLocal(now());
  const summary = summaryText({ started: held.started, ended, bugs, stopped });
  try {
    writeFileSync(join(folder, 'summary.md'), summary);
    writeJson(join(folder, 'state.json'), { ...c.cur, ended, stopped, bugs });
    if (stopped) c.log(`stopped: ${stopped}`);
    const count = (o) => bugs.filter((b) => b.outcome === o).length;
    logEvent(ws, { time: new Date().toISOString(), kind: 'quad-damage', via, folder, merged: count('merged'), waits: count('waits'), notReached: count('not-reached'), stopped });
  } finally {
    release(home, pid);
  }
  return { folder, started: held.started, ended, stopped, bugs, summary };
}

// --- The summary (AC-13) ---

const bugLine = (b) => (b.outcome === 'merged' ? `- ${b.id}: merged ${String(b.sha ?? '?').slice(0, 7)} into ${b.repo}'s master`
  : b.outcome === 'waits' ? `- ${b.id}: waits: ${b.why}` : `- ${b.id}: not reached`);

// summary.md: the run's line, then a line a bug in the order the run met them.
export function summaryText({ started, ended, bugs, stopped = null }) {
  const count = (o) => bugs.filter((b) => b.outcome === o).length;
  const head = `Quad Damage, ${hhmm(started)} to ${hhmm(ended)}: ${count('merged')} merged, ${count('waits')} wait, ` +
    `${count('not-reached')} not reached${stopped ? `; stopped: ${stopped}` : ''}`;
  return [head, ...bugs.map(bugLine)].join('\n') + '\n';
}

// The kirunak-push line: the summary's first line, then each bug in a few words, cut at PUSH_MAX.
export function pushLine(summary) {
  const [first = '', ...rest] = summary.trim().split('\n');
  const few = rest.map((l) => l.match(/^- (\S+): (merged|waits|not reached)(?:: (.*))?/)).filter(Boolean)
    .map(([, id, what, why]) => (what === 'waits' && why ? `${id} waits: ${cut(why, WHY_WORDS)}` : `${id} ${what}`));
  return cut([first, few.join('; ')].filter(Boolean).join('. '), PUSH_MAX);
}

// `k bugs quad-damage --summary [<folder>]`: the latest run's summary, or the one of the folder named (a path, or a run
// folder's name). → { folder, summary, push }.
export function summaryOf(home, folder = null) {
  const root = runsDir(home);
  let dir;
  if (folder) dir = existsSync(folder) ? resolve(folder) : join(root, folder);
  else {
    const runs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
    if (!runs.length) throw refuse(`no Quad Damage run yet: ${root} holds none`);
    dir = join(root, runs.at(-1));
  }
  const path = join(dir, 'summary.md');
  if (!existsSync(path)) {
    const live = state(home);
    throw refuse(`no Quad Damage summary in ${dir}` + (live?.folder === dir ? `: its run goes on (pid ${live.pid}), and k bugs ` +
      'quad-damage --status shows it' : ''));
  }
  const summary = readFileSync(path, 'utf8');
  return { folder: dir, summary, push: pushLine(summary) };
}

// --- Status (AC-12) ---

// The run in one line, for `k bugs quad-damage --status` and what shows the run.
export function statusLine(r) {
  if (!r) return 'Quad Damage is not running';
  if (r.phase === 'waiting') return `Quad Damage waits for the 5-hour window until ${hhmm(r.waitUntil)}`;
  if (!r.bug) return `Quad Damage runs, between bugs, since ${hhmm(r.started)}`;
  return `Quad Damage runs: ${r.bug}, ${r.phase}${r.phase === 'fixing' && r.try ? ` (try ${r.try})` : ''} since ${hhmm(r.since ?? r.started)}`;
}

// --- Starting it ---

// What a start would do now, touching nothing (--dry-run): refused as the start would be. → { bugs }.
export function preview({ ws, home = ws.home }) {
  const live = state(home);
  if (live) throw running(live);
  const bugs = marked(ws, home).map((r) => r.id);
  if (!bugs.length) throw refuse('no bug is marked quad-damage: yes, so a run would take none; k bugs lists the bugs');
  return { bugs };
}

// `k bugs quad-damage`: the run file taken here (E-3), handed to a detached `k bugs quad-damage` in its own process
// group that does the run, its output in the run's log; returns at once. → { pid, started, log, folder, bugs }.
export function start({ ws, via = 'shell', home = ws.home, now = new Date() }) {
  const held = claim(home, { via, now });
  try {
    const bugs = marked(ws, home).map((r) => r.id);
    if (!bugs.length) throw refuse('no bug is marked quad-damage: yes, so a run would take none; k bugs lists the bugs');
    const folder = folderFor(home, now);
    mkdirSync(folder, { recursive: true });
    writeJson(quadDamagePath(home), { ...held, folder });
    const log = join(folder, 'run.log');
    appendFileSync(log, `--- Quad Damage, ${held.started} (via ${via})\n`);
    const fd = openSync(log, 'a');
    let child;
    try {
      child = spawn(process.execPath, [K, 'bugs', 'quad-damage', '--via', via], {
        detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, KIRUNAK_HOME: home, [RUN_ENV]: String(process.pid) },
      });
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw refuse(`the Quad Damage run did not start; see ${log}`);
    // The run file is the working process's from here; it takes it over as its own once it runs.
    const now2 = readJson(quadDamagePath(home));
    if (now2?.pid === process.pid) writeJson(quadDamagePath(home), { ...now2, pid: child.pid });
    child.unref();
    return { pid: child.pid, started: held.started, log, folder, bugs };
  } catch (e) {
    release(home, process.pid);
    throw e;
  }
}

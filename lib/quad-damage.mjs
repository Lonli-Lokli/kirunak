import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoLocal, logEvent } from './approval.mjs';
import { KError, refuse } from './errors.mjs';
import { bugPaths, fixOf, list, mainOf, MARK, pidRuns, quadDamagePath, quadDamageRun, repoNamed, reviewsOf, sameSha } from './bugs.mjs';
import { firstCall, heavyCommand, lock, review, runDir, sessionDenied, spent, unlock } from './bug-review.mjs';
import { oneLine, parseDraft } from './drafts.mjs';
import { commit } from './git.mjs';
import { logLimits } from './limits.mjs';
import { cut } from './notice.mjs';
import { parseId } from './workspace.mjs';
import { register, unregister } from '../plugins/machine-guard-pids.mjs';
import { killTree } from '../plugins/resource-guard-local.mjs';
import { LOGIN_GONE } from '../plugins/runner-claude.mjs';

// Quad Damage (gulnya/quad-damage AC-1, AC-9, AC-10, AC-12, AC-13, E-2, E-3, E-4): `k bugs quad-damage`, the owner's
// verb, starts one detached run that takes the bugs marked `quad-damage: yes` one at a time, in the list's own order,
// each fixed and then reviewed while the plan's windows allow. The run file (bugs.mjs's quadDamagePath) says the run
// lives and which bug it is on; its folder $KIRUNAK_HOME/bugs/quad-damage/<started>/ keeps run.log, progress.log (a
// line for the owner at each change of the run's status, AC-16), state.json and summary.md. Nothing of a run goes into
// a repo but what a bug's own work commits.

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
// A progress line's reason is cut here, so each line stays short in the chat (AC-16); `--progress` reads the file
// again every POLL_MS.
const PROGRESS_WHY = 160;
export const POLL_MS = 3000;
const K = fileURLToPath(new URL('../bin/k.mjs', import.meta.url));

// The owner's stop (gulnya/quad-damage AC-17): `k bugs quad-damage --stop` writes the stop request beside the run file,
// naming the run's pid, and sends the run STOP_SIGNAL; the run, hearing it, stops at once in whatever phase it is.
// SIGWINCH, whose default is to be ignored: one that comes before the run listens kills nothing, and the run takes the
// request when it next looks, before its first bug (SIGUSR1 is node's inspector, SIGUSR2 its diagnostic report).
export const STOP_SIGNAL = 'SIGWINCH';
// The run's stop reason, and the why of the bug it was on.
export const OWNER_STOP = 'the owner stopped it';
export const OWNER_WHY = 'the owner stopped the run';
export const stopPath = (home) => join(home, 'bugs', 'quad-damage.stop.json');
// How long --stop waits for the run file to go, and how often it looks.
export const STOP_WAIT_MS = 120000;
const STOP_POLL_MS = 250;

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

// A wait of `ms`, cut short when `signal` aborts (the owner's stop).
function sleepFor(ms, signal = null) {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      r();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// `p`, or the abort of `signal` if it comes first (a seam's sleep that does not hear the signal).
async function orStop(p, signal) {
  if (!signal) return p;
  let off = null;
  const stopped = new Promise((r) => {
    if (signal.aborted) return r();
    signal.addEventListener('abort', r, { once: true });
    off = () => signal.removeEventListener('abort', r);
  });
  try {
    return await Promise.race([p, stopped]);
  } finally {
    off?.();
  }
}

// 14:05 of a time in a record (isoLocal's), or of a Date.
const hhmm = (t) => (t == null ? '?' : (typeof t === 'string' ? t : isoLocal(t)).slice(11, 16));
// A reason as a progress line carries it: one line, cut short.
const brief = (why) => cut(oneLine(why) || 'no reason given', PROGRESS_WHY);

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

// The stop request (AC-17) names `pid`.
const stopAsked = (home, pid) => readJson(stopPath(home))?.pid === pid;

// The run's ear for the owner's stop: STOP_SIGNAL to its pid. → a function that stops listening.
function listenForStop(heard) {
  process.on(STOP_SIGNAL, heard);
  return () => process.off(STOP_SIGNAL, heard);
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

// --- One bug's work (AC-4, AC-5, AC-6, AC-7, AC-8, AC-11, AC-14, E-1, E-5, E-6, E-7) ---

// The fixing session's environment names the bug, so kirunak's own session-start hooks stay quiet in it, as a review's
// KIRUNAK_BUG_REVIEW does.
export const FIX_ENV = 'KIRUNAK_BUG_FIX';
// A fixing session ends at its 150th tool call's result or at 150 minutes, whichever is first, with --max-turns at
// the same count behind it (AC-11).
export const FIX_LIMIT = { calls: 150, minutes: 150 };
const FIX_BRIEF = new URL('../templates/quad-damage-brief.md', import.meta.url);
const SKILL = fileURLToPath(new URL('../skills/k-bug/SKILL.md', import.meta.url));
const HEAVY_DEFAULT = "the heavy-lock command this machine's CLAUDE.md names, with the job's command after it and your session id as its session";
const KILL_WAIT_MS = 15000;
const REPORT = /^(FIXED|SKIPPED|FAILED)\b[\s:.-]*(.*)$/;
const REASON_MAX = 300;

const oneRow = (ctx, id) => list(ctx.ws, { home: ctx.home }).find((r) => r.id === id) ?? null;
const reviewRel = (s, v) => `${s.p.dirRel}/${v.file}`;
// A reason for a line that ends with its source: no square brackets of its own.
const plain = (text) => cut(oneLine(text).replace(/\[/g, '(').replace(/\]/g, ')'), REASON_MAX);

// The fixing session's brief, from templates/quad-damage-brief.md; a retry's names the review it works from and the
// head that review judged (AC-7).
function fixBrief(ws, s) {
  const retry = s.retry ? `\nThis is the retry after a review: ${reviewRel(s, s.retry)} (${join(s.p.root, s.p.dirRel, s.retry.file)}) ` +
    `judged the head ${s.retry.head} of ${s.p.branch} and lists findings. Read it first, then fix each finding on ${s.p.branch}, on top ` +
    'of that head, with a test where one fits. A finding you judge wrong: say why in the report, and fix the rest. FIXED once ' +
    'every finding is answered and committed: kirunak reviews the branch again.\n' : '';
  const fill = {
    id: s.id, try: String(s.try), sid: s.sid, title: s.row.title, path: s.p.path, fixRepo: s.fix.name, fixRoot: s.fix.root,
    branch: s.p.branch, main: s.main, report: s.report, retry, skill: SKILL, tree: s.tree,
    heavy: 'A heavy job (a Gradle or Xcode build or test, a booted emulator or simulator) runs only through this ' +
      `machine's heavy lock, never bare: ${heavyCommand(ws, s.sid) ?? HEAVY_DEFAULT}.`,
    bugRel: s.p.rel, bugRoot: s.p.root, calls: String(s.limit.calls), minutes: String(s.limit.minutes),
  };
  return readFileSync(FIX_BRIEF, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m);
}

// What a fixing session's stream says as it goes (AC-11): its tool calls and their results, the plan's overage, a
// login gone, its first call (gulnya/headless-tools AC-3) and its result. `end(why)` ends the session: at the limit's
// calls, or on overage.
function reader(limit, end) {
  const seen = { calls: 0, results: 0, overage: false, loginGone: false, first: null, result: null };
  const items = (m, type) => (Array.isArray(m.message?.content) ? m.message.content.filter((x) => x?.type === type).length : 0);
  seen.onMessage = (m) => {
    if (seen.over) return; // what streams in while the session is killed counts for nothing
    if (m.type === 'assistant') {
      if (m.error === 'authentication_failed') seen.loginGone = true;
      seen.first ??= firstCall(m);
      seen.calls += items(m, 'tool_use');
    } else if (m.type === 'user') {
      seen.results += items(m, 'tool_result');
      if (seen.results >= limit.calls) end('calls');
    } else if (m.type === 'rate_limit_event' && m.rate_limit_info?.isUsingOverage === true) {
      seen.overage = true;
      end('overage');
    } else if (m.type === 'result') seen.result = m;
  };
  return seen;
}

// One fixing session (AC-4, AC-5, AC-8, AC-14, E-6): fresh, headless, through the runner, on Opus (ws.bugs.fixModel),
// no Agent tool and no dollar cap, in the fix repo with the bug's repo and the run's folder added; ended at the limit's
// calls or minutes, or on overage. → { calls, turns, ended, overage, loginGone, exit, said, report }: `report` the text
// of the report it wrote, or null.
async function fixSession(ctx, s) {
  const { ws } = ctx;
  ctx.setPhase('fixing', s.try);
  await ctx.beforeSession();
  s.sid = randomUUID();
  s.report = join(ctx.dir, `fix-${s.try}.md`);
  rmSync(s.report, { force: true });
  const brief = fixBrief(ws, s);
  writeFileSync(join(ctx.dir, `fix-${s.try}.brief.md`), brief);
  let ended = null;
  let stopNow;
  const stopped = new Promise((r) => (stopNow = r));
  const end = (why) => {
    if (ended) return;
    ended = why;
    seen.over = true;
    stopNow(null);
  };
  const seen = reader(s.limit, end);
  // The owner's stop ends the session as the limits do (AC-17).
  const onStop = () => end('stopped');
  ctx.halt?.addEventListener('abort', onStop, { once: true });
  if (ctx.halt?.aborted) end('stopped');
  const addDirs = [...new Set([s.p.root, ctx.folder].filter((d) => d !== s.fix.root))];
  ctx.log(`fixing, try ${s.try}: session ${s.sid} in ${s.fix.root}`);
  const handle = await ctx.runner.start({
    brief, prompt: brief, cwd: s.fix.root, sessionId: s.sid, model: ws.bugs?.fixModel || 'opus',
    ...(ws.bugs?.fixEffort ? { effort: ws.bugs.fixEffort } : {}),
    disallowedTools: sessionDenied(ws), addDirs, maxTurns: s.limit.calls, env: { [FIX_ENV]: s.id }, onMessage: seen.onMessage,
  });
  if (handle.pid) register(ws, handle.pid, { task: s.id, step: `quad-damage fix ${s.try}`, session: handle.sessionId || s.sid });
  const timer = setTimeout(() => end('minutes'), s.limit.minutes * 60000);
  let o;
  try {
    o = await Promise.race([handle.done, stopped]);
    if (!o) {
      if (handle.pid) await killTree(handle.pid);
      let wait;
      o = await Promise.race([handle.done, new Promise((r) => (wait = setTimeout(() => r({}), KILL_WAIT_MS)))]);
      clearTimeout(wait);
    }
  } finally {
    clearTimeout(timer);
    ctx.halt?.removeEventListener('abort', onStop);
    if (handle.pid) unregister(ws, handle.pid);
  }
  const result = seen.result ?? (o.result?.type === 'result' || o.result?.num_turns != null ? o.result : null);
  const said = [result?.result, o.stderr].filter((t) => typeof t === 'string' && t.trim()).map(oneLine).join(' ').slice(0, 200);
  const failed = !!result?.is_error || (o.exitCode != null && o.exitCode !== 0);
  const out = {
    calls: seen.calls, turns: result?.num_turns ?? null, ended: ended ?? (result?.subtype === 'error_max_turns' ? 'calls' : null),
    overage: seen.overage, loginGone: seen.loginGone || (failed && LOGIN_GONE.test(said)), exit: o.exitCode ?? null, said,
    report: existsSync(s.report) ? readFileSync(s.report, 'utf8') : null,
  };
  writeFileSync(join(ctx.dir, `fix-${s.try}.json`), JSON.stringify({ sessionId: handle.sessionId || s.sid, ...out, report: s.report, firstCall: seen.first, result }, null, 2) + '\n');
  // The branch's head when it holds commits master does not, so run.log names what the session committed (AC-16).
  let branch = null;
  try {
    branch = fixOf(s.fix.root, s.p.branch);
  } catch {
    // No head to name: the line says the session's end alone.
  }
  const at = branch?.ahead > 0 ? `; ${s.p.branch} at ${branch.head.slice(0, 12)}, ${branch.ahead} ahead of ${s.main}` : '';
  const how = out.ended === 'stopped' ? ", ended by the owner's stop" : out.ended ? `, ended at its ${out.ended}` : '';
  const cost = spent(result, seen.first);
  ctx.log(`fixing, try ${s.try}: ${out.calls} tool calls${how}, exit ${out.exit}${cost ? `, ${cost}` : ''}${at}`);
  return out;
}

// SKIPPED (AC-4, E-6): the bug's mark set to no and the session's reason under What was found, the bug file committed
// alone in its repo, so the owner sees why and marks it yes again once it holds. → the problem, or null.
function skipped(ctx, s, why) {
  const text = readFileSync(s.p.path, 'utf8');
  const lines = text.split('\n');
  const line = `- Quad Damage skipped it on ${isoLocal(ctx.now()).slice(0, 10)}: ${plain(why) || 'no reason given'} [file ${s.report}]`;
  const at = lines.findIndex((l) => /^##\s+What was found\s*$/.test(l));
  if (at < 0) lines.push('', '## What was found', line);
  else {
    let next = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
    if (next < 0) next = lines.length;
    while (next > at + 1 && !lines[next - 1].trim()) next--;
    lines.splice(next, 0, line);
  }
  const d = parseDraft(lines.join('\n'));
  if (d.frontEnd) {
    if (MARK in d.front) lines[d.frontLine[MARK] - 1] = `${MARK}: no`;
    else lines.splice(d.frontEnd - 1, 0, `${MARK}: no`);
  }
  writeFileSync(s.p.path, lines.join('\n'));
  try {
    commit(s.p.root, [s.p.rel], `kirunak: bug ${s.id}: Quad Damage skipped it, ${MARK}: no`);
    return null;
  } catch (e) {
    return oneLine(e.message);
  }
}

// The fixing session's end, read (AC-8, AC-11, E-7). → { fixed: true } for a FIXED report, or the bug's result; a
// SKIPPED's or a FAILED's carries `said`, its progress line (AC-16).
function afterFix(ctx, s, f) {
  const branch = `what holds is on ${s.p.branch} in ${s.fix.name}`;
  // The owner's stop ended it (AC-17): the bug waits with what its branch holds.
  if (f.ended === 'stopped') return { outcome: 'waits', why: OWNER_WHY, stop: OWNER_STOP };
  const halt = (why) => (s.worked || f.calls > 0 ? { outcome: 'waits', why: `the run stopped in its fixing session: ${why}`, stop: why } : { stop: why });
  if (f.loginGone) return halt(`the login is gone${f.said ? `: ${f.said}` : ''}`);
  if (f.overage) return halt('the plan is in extra usage');
  if (f.calls === 0 && (f.turns ?? 0) <= 1) return halt(`a fixing session made no tool call (exit ${f.exit}${f.said ? `: ${f.said}` : ''})`);
  s.worked = true;
  if (f.ended === 'calls') return { outcome: 'waits', why: `its fixing session, try ${s.try}, reached ${s.limit.calls} tool calls; ${branch}` };
  if (f.ended === 'minutes') return { outcome: 'waits', why: `its fixing session, try ${s.try}, reached ${s.limit.minutes} minutes; ${branch}` };
  if (f.report === null) return { outcome: 'waits', why: `its fixing session, try ${s.try}, wrote no report (exit ${f.exit}); ${branch}` };
  const [first = '', second = ''] = f.report.replace(/^\s+/, '').split('\n');
  const m = REPORT.exec(first.trim());
  if (!m) return { outcome: 'waits', why: `its fixing session's report begins "${cut(oneLine(first), 60)}", not FIXED, SKIPPED or FAILED: ${s.report}` };
  const why = oneLine(/^Why:\s*(.*)$/i.exec(second.trim())?.[1] || m[2]);
  if (m[1] === 'SKIPPED') {
    const problem = skipped(ctx, s, why);
    return { outcome: 'waits', why: `skipped, ${MARK} now no: ${plain(why) || 'no reason given'}${problem ? `; but the bug file's commit failed: ${problem}` : ''}`, said: `skipped: ${brief(plain(why))}` };
  }
  if (m[1] === 'FAILED') return { outcome: 'waits', why: `its fixing session failed: ${plain(why) || 'no reason given'}; ${branch}`, said: `failed: ${brief(plain(why))}` };
  return { fixed: true };
}

// One review (AC-6, E-5): review() of lib/bug-review.mjs, as the owner's Review & merge runs it, through the run's
// runner. It takes the bug's lock from the run's pid and lets it go, so the run takes it again to carry on. The owner's
// stop ends its session (outcome stopped); once its verdict is clean it says it merges, and a stop then waits for the
// merge (AC-17).
async function reviewOnce(ctx, s) {
  ctx.setPhase('reviewing', s.try);
  await ctx.beforeSession();
  const ws = ctx.runner && ctx.runner !== ctx.ws.seams?.runner ? { ...ctx.ws, seams: { ...ctx.ws.seams, runner: ctx.runner } } : ctx.ws;
  const onMerging = () => {
    ctx.setPhase('merging');
    ctx.log('review clean: merging');
  };
  const r = await (ctx.review ?? review)({
    ws, id: s.id, via: 'quad-damage', home: ctx.home, from: ctx.pid, abort: ctx.halt ?? null, onMerging, ...(ctx.processes ? { processes: ctx.processes } : {}),
  });
  ctx.log(`review: ${r.outcome}${r.review?.rel ? `, ${r.review.rel}` : ''}${r.spent ? `; ${r.spent}` : ''}`);
  s.worked = true;
  return r;
}

// E-7 for a review session: a malformed review whose session failed before working (the login gone, one turn at most,
// or a failed exit with no result), read from the result.json review() leaves in the review's folder, is no finding but
// a failure that stops the run. → its reason, or null: a session that worked keeps its malformed review a finding.
function reviewFailed(ctx, s, r) {
  if (r.outcome !== 'findings' || !r.malformed || !r.review?.rel) return null;
  const n = /review-(\d+)\.md$/.exec(r.review.rel)?.[1];
  let o;
  try {
    o = JSON.parse(readFileSync(join(runDir(ctx.home, s.id), `review-${n}`, 'result.json'), 'utf8'));
  } catch {
    return null;
  }
  const res = o.result && typeof o.result === 'object' ? o.result : null;
  const said = cut(oneLine(typeof res?.result === 'string' ? res.result : ''), 200);
  const failed = !!res?.is_error || (o.exitCode != null && o.exitCode !== 0);
  if (failed && LOGIN_GONE.test(said)) return `the login is gone: ${said}`;
  if (o.timedOut) return null;
  if (!res) return failed ? `exit ${o.exitCode} and no result` : null;
  return (res.num_turns ?? 0) <= 1 ? `no tool call (exit ${o.exitCode}${said ? `: ${said}` : ''})` : null;
}

// A bug's fixing sessions and its review, each after `await ctx.beforeSession()`. ctx: { ws, home, bug (its row from
// list()), folder (the run's), dir (the bug's own in it, made), runner, pid (the run's), beforeSession() → the reading
// (throws Stop), setPhase(phase, try = the current, fields) (fixing|reviewing, before each session), relock() (the
// bug's lock again, after a review() let it go), log(line), progress(line) (the owner's line, AC-16), now() → Date,
// sleep(ms) }; a test may add limit (FIX_LIMIT's shape), processes (review()'s) and review (review() itself). →
// { outcome: 'merged', sha, repo } or { outcome: 'waits', why, said? (its progress line, when not "waits: <why>") },
// either with `stop: '<why>'` to end the run after it; or { stop: '<why>' } alone, the bug then not reached. A Stop
// thrown is { stop } alone; anything else thrown, the bug waits with its message.
//
// A fix ready goes straight to review (E-1); a head a review refused with findings takes its retry first. A FIXED
// report with commits ahead of master goes to review; findings there take one retry from them and a second review,
// and refused twice the bug waits with both (AC-7, counted over every findings review beside the bug, the owner's
// Review & merge's too). A conflict, a merge refused, a SKIPPED, a FAILED or a session ended at its limit waits; a
// review session that failed before working (E-7) waits and stops the run.
export async function workBug(ctx) {
  const { ws, bug } = ctx;
  const p = bugPaths(ws, bug.id);
  const fix = repoNamed(ws, bug.fixRepo);
  if (!fix) return { outcome: 'waits', why: `its fix repo ${bug.fixRepo} is no repo of the workspace and not kirunak` };
  const main = mainOf(fix.root);
  if (!main) return { outcome: 'waits', why: `its fix repo ${fix.name} has neither master nor main` };
  const s = { id: bug.id, row: bug, p, fix, main, tree: `${fix.root}-quad-${p.slug}`, limit: ctx.limit ?? FIX_LIMIT, try: 1, worked: false, sessions: 0 };
  const twice = (found) => ({ outcome: 'waits', why: `refused twice by its reviews: ${found.slice(-2).map((v) => reviewRel(s, v)).join(' and ')}` });
  for (let row = bug; ;) {
    const reviews = reviewsOf(p.dir);
    const found = reviews.filter((v) => v.verdict === 'findings');
    if (!row.fixReady) {
      const refusal = row.head ? reviews.filter((v) => v.verdict !== 'clean' && sameSha(v.head, row.head)).at(-1) : null;
      if (refusal && refusal.verdict !== 'findings') {
        return { outcome: 'waits', why: `its review ${reviewRel(s, refusal)} refused the head ${row.head.slice(0, 12)} (${refusal.verdict ?? 'no verdict'})` };
      }
      if (found.length >= 2) return twice(found);
      if (s.sessions >= 2) return { outcome: 'waits', why: `two fixing sessions in this run left no fix ready on ${p.branch}` };
      s.retry = refusal;
      s.try = Math.min(2, found.length + 1);
      s.sessions++;
      const f = await fixSession(ctx, s);
      const next = afterFix(ctx, s, f);
      if (!next.fixed) return next;
      row = oneRow(ctx, s.id);
      if (!row) return { outcome: 'waits', why: `its bug file is gone after its fixing session: ${p.path}` };
      if (!row.fixReady) return { outcome: 'waits', why: `its report says FIXED, but ${p.branch} in ${fix.name} has no commit ahead of ${main} at a head no review refused` };
      ctx.progress(`fix committed ${row.head.slice(0, 7)}`);
    }
    const r = await reviewOnce(ctx, s);
    if (r.outcome === 'stopped') return { outcome: 'waits', why: OWNER_WHY, stop: OWNER_STOP };
    const failed = reviewFailed(ctx, s, r);
    if (failed) return { outcome: 'waits', why: `its review session failed: ${failed}`, stop: `a review session failed: ${failed}` };
    if (r.outcome === 'merged') return { outcome: 'merged', sha: r.merged, repo: r.fixRepo };
    if (r.outcome === 'conflict') return { outcome: 'waits', why: `${p.branch} no longer merges onto ${main}${r.conflict?.length ? ` (${r.conflict.join(', ')})` : ''}: ${r.review?.rel}` };
    if (r.outcome === 'merge-refused') return { outcome: 'waits', why: `its review is clean, but the merge was refused: ${r.why}` };
    if (r.outcome !== 'findings') return { outcome: 'waits', why: `its review ended ${r.outcome}` };
    const now = reviewsOf(p.dir).filter((v) => v.verdict === 'findings');
    if (now.length >= 2) return twice(now);
    ctx.progress(`review found something, try ${now.length + 1}`);
    ctx.relock();
    row = oneRow(ctx, s.id);
    if (!row) return { outcome: 'waits', why: `its bug file is gone after its review: ${p.path}` };
  }
}

// --- The run ---

// The reading before every session (AC-9, AC-10), logged with the run's label: extra usage, the week at STOP_AT% or
// more, or a reading that failed stops the run (going on blind could reach extra usage); the 5-hour window at PAUSE_AT%
// or more waits until its reset and a minute, then reads again. A pause and its end each write a progress line, which
// never names a reading (AC-16). → the reading the session goes on with.
async function gate(c, setPhase, log) {
  // The owner's stop before a session, or during a reading or a wait, ends the run there (AC-17).
  const halted = () => {
    if (c.halt?.aborted) throw new Stop(OWNER_STOP);
  };
  for (let paused = false; ; paused = true) {
    halted();
    let r;
    try {
      r = typeof c.runner?.limits === 'function' ? await c.runner.limits() : { error: 'the runner has no limits reading' };
    } catch (e) {
      r = { error: e.message };
    }
    halted();
    if (!r || r.error || !r.week || !r.fiveHour) throw new Stop(`the limits reading failed: ${oneLine(r?.error) || 'it gave no windows'}`);
    logLimits(c.ws, r, { label: LABEL, now: c.now() });
    log(`limits: week ${r.week.used}%, 5-hour ${r.fiveHour.used}%${r.overage ? ', extra usage' : ''}`);
    if (r.overage) throw new Stop('the plan is in extra usage');
    // The reason names the line reached, never the reading, which run.log keeps: a progress line shows it (AC-16).
    if (r.week.used >= STOP_AT) throw new Stop(`the week's limit reached ${STOP_AT}%`);
    if (r.fiveHour.used < PAUSE_AT) {
      if (paused) c.progress('Quad Damage goes on');
      return r;
    }
    const reset = new Date(r.fiveHour.resetsAt * 1000);
    const was = { phase: c.cur.phase, try: c.cur.try };
    setPhase('waiting', was.try, { waitUntil: isoLocal(reset) });
    log(`the 5-hour window is at ${Math.trunc(r.fiveHour.used)}%: waiting until ${hhmm(reset)} and a minute`);
    c.progress(`Quad Damage paused for the 5-hour window until ${hhmm(reset)}`);
    await orStop(c.sleep(Math.max(0, reset.getTime() + AFTER_RESET_MS - c.now().getTime()), c.halt), c.halt);
    halted();
    setPhase(was.phase, was.try, { waitUntil: null });
  }
}

// One bug: passed over when another live pid holds its lock ("being reviewed", the owner's Review & merge); else its
// lock taken with the run's pid for the whole bug, its work done, and the lock let go. → { result: { id, outcome,
// sha?, repo?, why? }, stop, said (the bug's end in its progress line, when not "waits: <why>") }.
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
  // The bug's started line, once its first session passes the limits: a bug the limits stop before it never started.
  // Its phase and try are set before each reading, so a fix ready and a retry first both show (AC-16).
  let started = false;
  const ctx = {
    ws: c.ws, home: c.home, bug: row, folder: c.folder, dir, runner: c.runner, pid: c.pid, halt: c.halt, setPhase,
    beforeSession: async () => {
      const reading = await gate(c, setPhase, ctx.log);
      if (!started) {
        started = true;
        const how = c.cur.phase === 'reviewing' ? ', fix ready, to review' : c.cur.try > 1 ? `, try ${c.cur.try} from its review's findings` : '';
        ctx.progress(`started${how}`);
      }
      return reading;
    },
    relock: () => lock(c.home, id, { pid: c.pid }),
    log: (line) => c.log(`${id}: ${line}`), progress: (line) => c.progress(`${id}: ${line}`), now: c.now, sleep: c.sleep,
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
  // The owner's stop (AC-17): a merge it let finish stays merged, a bug waiting of its own reason keeps it, and any
  // other end of the bug it was on waits, "the owner stopped the run"; the run stops after it.
  if (c.halt?.aborted) {
    if (r.outcome !== 'merged' && r.outcome !== 'waits') r = { outcome: 'waits', why: OWNER_WHY };
    r = { ...r, stop: OWNER_STOP };
  }
  const stop = r.stop ? oneLine(r.stop) : null;
  if (r.outcome === 'merged') return { result: { id, outcome: 'merged', sha: r.sha ?? null, repo: r.repo ?? row.fixRepo ?? row.repo }, stop };
  if (r.outcome === 'waits') return { result: { id, outcome: 'waits', why: oneLine(r.why) || 'no reason given' }, stop, said: r.said ?? null };
  if (stop) return { result: { id, outcome: 'not-reached' }, stop };
  return { result: { id, outcome: 'waits', why: `its work gave no outcome${r.outcome ? ` (${r.outcome})` : ''}` }, stop };
}

// The run itself, in the detached process (or a test's): the run file taken (from the process that started it), the
// Mac kept awake, then before each bug the list read again and the first marked bug not yet tried in this run taken,
// until none is left or the run stops. At the end, or a stop, every marked bug not tried is "not reached", summary.md
// is written and the run file goes. The owner's stop (AC-17) is heard through `listen(heard)` (STOP_SIGNAL by default;
// → a function that stops listening), and counts only while the stop request names the run's pid. The runner, the
// work, sleep (ms, signal), the clock, caffeinate and listen are seams for the tests.
// → { folder, started, ended, stopped, bugs, summary }.
export async function run({
  ws, home = ws.home, via = 'shell', from = null, pid = process.pid, runner = ws.seams?.runner, work = workBug,
  sleep = sleepFor, now = () => new Date(), caffeinate = keepAwake, listen = listenForStop,
}) {
  const held = claim(home, { pid, from, via, now: now() });
  // A stop request left by a run before this one is no stop of this one.
  if (existsSync(stopPath(home)) && !stopAsked(home, pid)) rmSync(stopPath(home), { force: true });
  const halt = new AbortController();
  const folder = held.folder ?? folderFor(home, now());
  mkdirSync(folder, { recursive: true });
  const runLog = join(folder, 'run.log');
  const progressLog = join(folder, 'progress.log');
  const bugs = [];
  const c = {
    ws, home, folder, runner, pid, work, sleep, now, cur: held, halt: halt.signal,
    log: (line) => appendFileSync(runLog, `${isoLocal(now()).slice(11, 19)} ${line}\n`),
    // The owner's line at each change of the run's status, HH:MM on the run's clock (AC-16).
    progress: (line) => appendFileSync(progressLog, `${hhmm(now())} ${line}\n`),
    save: (fields) => {
      c.cur = { ...c.cur, ...fields };
      writeJson(quadDamagePath(home), c.cur);
      writeJson(join(folder, 'state.json'), { ...c.cur, bugs });
    },
  };
  const tried = new Set();
  let stopped = null;
  const heard = () => {
    if (halt.signal.aborted || !stopAsked(home, pid)) return;
    c.log('the owner asked the run to stop');
    halt.abort();
  };
  let unlisten = null;
  try {
    c.save({ folder });
    caffeinate(pid);
    c.log(`Quad Damage runs: pid ${pid}, via ${via}`);
    unlisten = listen(heard);
    for (;;) {
      // A stop between bugs, or one asked before the run listened, takes no next bug.
      heard();
      if (halt.signal.aborted) {
        stopped = OWNER_STOP;
        break;
      }
      const row = marked(ws, home).find((r) => !tried.has(r.id));
      if (!row) break;
      tried.add(row.id);
      const { result, stop, said } = await one(c, row);
      bugs.push(result);
      const sha = String(result.sha ?? '?');
      c.log(`${row.id}: ${result.outcome}${result.outcome === 'merged' ? ` ${sha.slice(0, 12)} into ${result.repo}` : ''}${result.why ? `: ${result.why}` : ''}`);
      if (result.outcome === 'merged') c.progress(`${row.id}: review clean, merged ${sha.slice(0, 7)} into ${result.repo}`);
      else if (result.outcome === 'waits') c.progress(`${row.id}: ${said ?? `waits: ${brief(result.why)}`}`);
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
    // The last progress line goes before summary.md, whose writing ends a --progress wait.
    c.progress(stopped ? `Quad Damage stopped: ${brief(stopped)}` : `Quad Damage done: ${tally(bugs)}`);
    writeFileSync(join(folder, 'summary.md'), summary);
    writeJson(join(folder, 'state.json'), { ...c.cur, ended, stopped, bugs });
    if (stopped) c.log(`stopped: ${stopped}`);
    const count = (o) => bugs.filter((b) => b.outcome === o).length;
    logEvent(ws, { time: new Date().toISOString(), kind: 'quad-damage', via, folder, merged: count('merged'), waits: count('waits'), notReached: count('not-reached'), stopped });
  } finally {
    try {
      unlisten?.();
    } catch {
      // Nothing more is heard.
    }
    if (stopAsked(home, pid)) rmSync(stopPath(home), { force: true });
    release(home, pid);
  }
  return { folder, started: held.started, ended, stopped, bugs, summary };
}

// --- The summary (AC-13) ---

const bugLine = (b) => (b.outcome === 'merged' ? `- ${b.id}: merged ${String(b.sha ?? '?').slice(0, 7)} into ${b.repo}'s master`
  : b.outcome === 'waits' ? `- ${b.id}: waits: ${b.why}` : `- ${b.id}: not reached`);

// The bugs counted: "n merged, m wait, k not reached".
function tally(bugs) {
  const count = (o) => bugs.filter((b) => b.outcome === o).length;
  return `${count('merged')} merged, ${count('waits')} wait, ${count('not-reached')} not reached`;
}

// summary.md: the run's line, then a line a bug in the order the run met them.
export function summaryText({ started, ended, bugs, stopped = null }) {
  const head = `Quad Damage, ${hhmm(started)} to ${hhmm(ended)}: ${tally(bugs)}${stopped ? `; stopped: ${stopped}` : ''}`;
  return [head, ...bugs.map(bugLine)].join('\n') + '\n';
}

// The kirunak-push line: the summary's first line, then each bug in a few words, cut at PUSH_MAX.
export function pushLine(summary) {
  const [first = '', ...rest] = summary.trim().split('\n');
  const few = rest.map((l) => l.match(/^- (\S+): (merged|waits|not reached)(?:: (.*))?/)).filter(Boolean)
    .map(([, id, what, why]) => (what === 'waits' && why ? `${id} waits: ${cut(why, WHY_WORDS)}` : `${id} ${what}`));
  return cut([first, few.join('; ')].filter(Boolean).join('. '), PUSH_MAX);
}

// A run's folder: the one named (a path, or a run folder's name), or the latest run's.
function runFolder(home, folder = null) {
  const root = runsDir(home);
  if (folder) return existsSync(folder) ? resolve(folder) : join(root, folder);
  const runs = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  if (!runs.length) throw refuse(`no Quad Damage run yet: ${root} holds none`);
  return join(root, runs.at(-1));
}

// `k bugs quad-damage --summary [<folder>]`: the latest run's summary, or the one of the folder named (a path, or a run
// folder's name). → { folder, summary, push }.
export function summaryOf(home, folder = null) {
  const dir = runFolder(home, folder);
  const path = join(dir, 'summary.md');
  if (!existsSync(path)) {
    const live = state(home);
    throw refuse(`no Quad Damage summary in ${dir}` + (live?.folder === dir ? `: its run goes on (pid ${live.pid}), and k bugs ` +
      'quad-damage --status shows it' : ''));
  }
  const summary = readFileSync(path, 'utf8');
  return { folder: dir, summary, push: pushLine(summary) };
}

// --- Progress (AC-16) ---

// A word the shell takes as it is, or one quoted.
const shq = (s) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The command that waits for the lines after the first `after` of a run's progress.
export const progressCommand = (folder, after) => `k bugs quad-damage --progress ${shq(folder)} --after ${after}`;

// `k bugs quad-damage --progress [<folder>] --after <n>`: reads only, and never starts a run. Waits, reading the run's
// progress.log every `poll` ms, until it holds more than `after` whole lines or the run has ended: summary.md written,
// or the run file gone, its pid dead or naming another folder. → { folder, after (the lines read), lines (the new
// ones), ended, next (the command for the next wait, while the run goes on), summary and push (once it has ended,
// as summaryOf gives them; null when it ended with no summary, killed) }.
export async function progressOf(home, folder = null, after = 0, { poll = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = runFolder(home, folder);
  if (!existsSync(dir)) throw refuse(`no Quad Damage run in ${dir}`);
  const summaryPath = join(dir, 'summary.md');
  const read = () => {
    let text = '';
    try {
      text = readFileSync(join(dir, 'progress.log'), 'utf8');
    } catch {
      // No line yet.
    }
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1);
  };
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const over = () => {
    if (existsSync(summaryPath)) return true;
    const live = state(home);
    return !live || (live.folder != null && real(live.folder) !== real(dir));
  };
  for (;;) {
    // The end is read before the lines: the run writes its last line before summary.md.
    const ended = over();
    const all = read();
    if (ended || all.length > after) {
      const out = { folder: dir, after: all.length, lines: all.slice(after), ended, next: null, summary: null, push: null };
      if (!ended) return { ...out, next: progressCommand(dir, all.length) };
      return existsSync(summaryPath) ? { ...out, ...summaryOf(home, dir) } : out;
    }
    await sleep(poll);
  }
}

// --progress's output: the new lines, then `kirunak-next: <the next wait>` while the run goes on; at its end the
// summary as --summary prints it, `kirunak-push:` line and all.
export function progressText(p) {
  const tail = !p.ended ? [`kirunak-next: ${p.next}`]
    : p.summary ? [p.summary.trimEnd(), `kirunak-push: ${p.push}`]
    : [`Quad Damage ended with no summary: its process is gone; ${join(p.folder, 'run.log')} shows how far it got`,
      'kirunak-push: Quad Damage ended with no summary: its process is gone'];
  return [...p.lines, ...tail].join('\n');
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

// --- The owner's stop (AC-17) ---

// What --stop would do now, touching nothing (--dry-run). → { text }.
export function stopPreview({ home }) {
  const live = state(home);
  return { text: live ? `would stop Quad Damage: ${statusLine(live)}` : 'Quad Damage is not running' };
}

// `k bugs quad-damage --stop`, the owner's: the stop request written for the live run's pid and STOP_SIGNAL sent to
// it, then a wait of up to `waitMs` for the run to end (its run file gone or another's). The run does the rest: the
// session it is in ended, a merge under way let finish, the bug waits, the rest not reached, its summary written.
// `kill`, `sleep` and the wait are seams for the tests. → { stopped, pid?, folder?, text }.
export async function stop({
  ws = null, home = ws.home, via = 'shell', kill = process.kill.bind(process), waitMs = STOP_WAIT_MS, poll = STOP_POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(),
}) {
  const live = state(home);
  if (!live) return { stopped: false, text: 'Quad Damage is not running' };
  const { pid, folder = null } = live;
  writeJson(stopPath(home), { pid, by: 'owner', via, at: isoLocal(now()) });
  try {
    kill(pid, STOP_SIGNAL);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  if (ws) logEvent(ws, { time: new Date().toISOString(), kind: 'quad-damage-stop', via, pid, folder });
  const ends = Date.now() + waitMs;
  for (;;) {
    if (state(home)?.pid !== pid) {
      if (readJson(stopPath(home))?.pid === pid) rmSync(stopPath(home), { force: true });
      const where = folder ? `; its summary: ${join(folder, 'summary.md')}` : '';
      return { stopped: true, pid, folder, text: `Quad Damage stopped: the owner stopped it${where}` };
    }
    if (Date.now() >= ends) {
      return { stopped: false, pid, folder, text: `Quad Damage is still stopping: pid ${pid}; k bugs quad-damage --status shows it` };
    }
    await sleep(poll);
  }
}

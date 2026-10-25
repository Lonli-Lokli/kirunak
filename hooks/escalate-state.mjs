import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { segments } from './kirunak-freeze.mjs';

// The escalation hook's rules (gulnya/enforced-escalation S-2 design §4), shared by hooks/kirunak-escalate.mjs, the
// freeze hook's two notes and the tests: which commands count, the signature of a failure, the counting, the state
// files, the rung and the message. It imports nothing but node: modules and the freeze hook's segment parser, because
// it runs in a hook on every failed Bash call.

// ---- Which commands count (R4.3, E-5, E-7) ----

// A build or test command, matched at the start of the command a call runs; a workspace adds more in `hook.commands`.
const BUILD = new RegExp(`^(?:${[
  'npm test', 'npm run test[:\\w-]*', 'npx (?:jest|vitest|mocha|tsc)', 'yarn test', 'pnpm test', 'node --test',
  '(?:\\S*/)?gradlew', 'gradle', 'xcodebuild', 'swift (?:test|build)', 'pytest', 'python3? -m pytest',
  'go (?:test|build|vet)', 'cargo (?:test|build|check|clippy)', 'make', 'mvn', 'dotnet (?:test|build)', 'tsc',
  'detekt', 'swiftlint',
].join('|')})(?=\\s|$)`);

// A segment's words, without its redirections and their targets (`2>&1`, `> out.txt`).
function wordsOf(tokens) {
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (typeof tokens[i] === 'string') words.push(tokens[i]);
    else if (typeof tokens[i + 1] === 'string') i++;
  }
  return words;
}

// The words past `env` (and its options, `-u NAME` with its name) and `VAR=x` assignments.
function bare(words) {
  let w = words;
  for (;;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? '')) w = w.slice(1);
    else if (w[0] === 'env') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) w = w.slice(['-u', '-C', '-P', '-S'].includes(w[0]) ? 2 : 1);
    } else return w;
  }
}

// The command heavy-lock.mjs runs (`node …/heavy-lock.mjs run … -- <command>`), or null when it is not one (E-7).
function unlocked(words) {
  const at = /(?:^|\/)node(?:js)?$/.test(words[0] ?? '') ? 1 : 0;
  if (!/(?:^|\/)heavy-lock\.mjs$/.test(words[at] ?? '') || words[at + 1] !== 'run') return null;
  const dash = words.indexOf('--', at + 2);
  return dash < 0 ? [] : words.slice(dash + 1);
}

const matches = (re, text) => {
  try {
    return new RegExp(re).test(text);
  } catch {
    return false; // a bad workspace regex counts nothing
  }
};

/**
 * The build or test command a Bash call runs, as its words joined by spaces, or null when it runs none: past a
 * leading `cd <dir> &&`, `env` and `VAR=x` words and heavy-lock.mjs's wrapper, the first segment must match BUILD
 * or one of `extra` (the workspace's `hook.commands`). A failed `ls` or `git` never counts.
 */
export function commandOf(command, extra = []) {
  const list = segments(command);
  let i = 0;
  while (i < list.length && wordsOf(list[i])[0] === 'cd') i++;
  let words = bare(wordsOf(list[i] ?? []));
  const inner = unlocked(words);
  if (inner) words = bare(inner);
  if (!words.length) return null;
  const text = words.join(' ');
  return BUILD.test(text) || (Array.isArray(extra) && extra.some((re) => matches(re, text))) ? text : null;
}

// ---- The signature of a failure (R4.4; S-1 §1: one text, `Exit code N` first, maybe middle-truncated or timed out) ----

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TRUNCATED = /\.\.\. \[\d+ characters truncated\] \.\.\./g;
const TIMED_OUT = /^Command timed out after /;

// A test's time at the end of its line: `(0.77ms)`, `3ms`.
const untimed = (s) => s.replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '').replace(/\s+\d+(?:\.\d+)?\s*m?s$/, '').trim();
const file = (path) => basename(path.replace(/^file:\/\//, ''));

// Every line's match of `re`, mapped by `fn`.
const grab = (lines, re, fn = (m) => m[1]) => lines.flatMap((l) => {
  const m = re.exec(l);
  const item = m && fn(m);
  return item ? [item] : [];
});

// The runners in the order they are tried; the first that finds an item names the failure. Each item leaves out line
// numbers and times, so a fix that moves lines but leaves the error is the same error.
const RUNNERS = [
  ['node', (ls) => [
    ...grab(ls, /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/),
    ...grab(ls, /^\s*✖ (.+)$/, (m) => (m[1].trim() === 'failing tests:' ? null : untimed(m[1]))),
  ]],
  ['jest', (ls) => grab(ls, /^\s*● (.+)$/, (m) => (m[1].trim() === 'Console' ? null : m[1].trim()))],
  ['go', (ls) => {
    const tests = grab(ls, /^\s*--- FAIL: (\S+)/);
    return tests.length ? tests : grab(ls, /^(?:\.\/)?(\S+\.go):\d+:\d+: (.+)$/, (m) => `${file(m[1])} ${m[2]}`);
  }],
  ['pytest', (ls) => grab(ls, /^(?:FAILED|ERROR) (\S+)/)],
  ['vitest', (ls) => {
    const files = grab(ls, /^\s*FAIL\s+(.+)$/, (m) => m[1].trim());
    return files.length ? files : grab(ls, /^\s*×\s+(.+)$/, (m) => untimed(m[1]));
  }],
  ['cargo', (ls) => grab(ls, /^test (\S+) \.\.\. FAILED$/)],
  ['gradle', (ls) => [
    ...grab(ls, /^(\S+) > (.+?) FAILED$/, (m) => `${m[1].split('.').pop()} > ${m[2]}`),
    ...grab(ls, /^e: (.+?):\d+:\d+ (.+)$/, (m) => `${file(m[1])} ${m[2]}`),
    ...grab(ls, /^(.+\.java):\[?\d+.*?error: (.+)$/, (m) => `${file(m[1])} ${m[2]}`),
  ]],
  ['xcode', (ls) => [
    ...grab(ls, /Test Case '-\[(\S+) (\S+)\]' failed/, (m) => `${m[1]} ${m[2]}`),
    ...grab(ls, /Test Case '([^'\s]+)' failed/),
    ...grab(ls, /✘ Test (?:"(.+?)"|(\S+?\(.*?\))) (?:failed|recorded)/, (m) => m[1] ?? m[2]),
  ]],
  ['tsc', (ls) => [
    ...grab(ls, /^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/, (m) => `${file(m[1])} ${m[2]} ${m[3]}`),
    ...grab(ls, /^(.+?):\d+:\d+ - error (TS\d+): (.+)$/, (m) => `${file(m[1])} ${m[2]} ${m[3]}`),
  ]],
  ['compiler', (ls) => grab(ls, /^(.+?):\d+(?::\d+)?: (?:fatal )?error: (.+)$/, (m) => `${file(m[1])} ${m[2].trim()}`)],
  ['cargo', (ls) => grab(ls, /^error(?:\[(E\d+)\])?: (.+)$/, (m) =>
    (/could not compile|previous errors?|test failed, to rerun/.test(m[2]) ? null : `${m[1] ? `${m[1]} ` : ''}${m[2]}`))],
];

// A line with its numbers, hex and paths' line numbers as `#`.
const numberless = (line) => line.trim().replace(/0x[0-9a-f]+/gi, '#').replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+(?:[.,:]\d+)*/g, '#');

const sign = (kind, items, label) => {
  const sorted = [...new Set(items)].sort();
  return {
    kind,
    label: (label ?? sorted[0]).slice(0, 80),
    hash: createHash('sha1').update(`${kind}\n${sorted.join('\n')}`).digest('hex'),
    items: sorted,
  };
};

/**
 * The failure's signature { kind, label, hash, items } from a failed call's `error` text and its command, or null
 * when the text has neither an `Exit code N` line nor a timeout (the shell never started). When no runner's lines are
 * there: a timed-out command is `<command> timed out`; anything else is the command, the exit code and its last line
 * without numbers.
 */
export function signatureOf(error, command = '') {
  const raw = String(error ?? '').replace(ANSI, '').replace(TRUNCATED, '\n').split(/\r?\n/);
  let code = null;
  let timedOut = false;
  const lines = [];
  raw.forEach((line, i) => {
    const exit = i < 2 && code === null ? /^Exit code (\d+)\s*$/.exec(line) : null;
    if (exit) code = Number(exit[1]);
    else if (TIMED_OUT.test(line.trim())) timedOut = true;
    else lines.push(line);
  });
  if (code === null && !timedOut) return null;
  for (const [kind, find] of RUNNERS) {
    const items = find(lines);
    if (items.length) return sign(kind, items);
  }
  if (timedOut) return sign('timeout', [`${command} timed out`]);
  const last = numberless(lines.filter((l) => l.trim()).at(-1) ?? '');
  const label = last ? `${command}: ${last}` : command;
  return sign('other', [label, `exit ${code}`], label);
}

// ---- The state files (R4.6, E-14) ----

const ID = /^[A-Za-z0-9_-]+$/;
const DAY = 24 * 60 * 60 * 1000;
export const KEEP_DAYS = 14;

export const configPath = (home) => join(home, 'escalate', 'config.json');
export const logPath = (home) => join(home, 'escalate.log');

// The main session's file, or a subagent's, whose failures are counted apart (E-14); null for an id that is not one.
export function statePath(home, session, agent = null) {
  if (!ID.test(session ?? '') || (agent != null && !ID.test(agent))) return null;
  return join(home, 'escalate', agent ? `${session}.${agent}.json` : `${session}.json`);
}

function readJson(path) {
  try {
    const x = JSON.parse(readFileSync(path, 'utf8'));
    return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}

// What k install wrote from the workspace (R4.2); null when it is not there.
export const readConfig = (home) => readJson(configPath(home));

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// The state of a session or a subagent. The launches (`agents`) and the block live in the session's file only, the
// caller's (E-13).
export function readState(home, session, agent = null) {
  const path = statePath(home, session, agent);
  const known = (path && readJson(path)) ?? {};
  return {
    session,
    agent: agent ?? null,
    model: known.model ?? null,
    edited: known.edited ?? null,
    failures: obj(known.failures),
    background: obj(known.background),
    ...(agent ? {} : { agents: obj(known.agents), block: known.block ?? null }),
  };
}

// Written whole and renamed, as lib/keeper.mjs updateSession writes a session's file.
export function writeState(home, state) {
  const path = statePath(home, state.session, state.agent);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + '\n');
  renameSync(tmp, path);
}

// Removes the state files untouched for 14 days and the temp files a crash left, never config.json; the count.
export function prune(home, now = Date.now()) {
  const dir = join(home, 'escalate');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (name === 'config.json' || !/\.json(?:\.\d+\.tmp)?$/.test(name)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > KEEP_DAYS * DAY) {
        unlinkSync(join(dir, name));
        removed++;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

// One line of escalate.log (R3.2); a record, never a reason to fail.
export function logLine(home, line) {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(logPath(home), JSON.stringify(line) + '\n');
  } catch {
    // the same
  }
}

// ---- The counting (R4.4, E-5, E-6, AC-11) ----

// The repeats that fire: the workspace's `hook.repeats`, else 2 (fail, edit, fail, edit, fail; E-6).
export const repeatsOf = (config) =>
  (Number.isInteger(config?.hook?.repeats) && config.hook.repeats >= 1 ? config.hook.repeats : 2);

/**
 * Counts a failure with signature `sig` into `state.failures` and says what it was: `new` (first seen), `rerun`
 * (seen, with no edit since: a rerun is not a fix that failed, and nothing changes), `repeat` (seen again after an
 * edit), `fire` (that repeat reached `repeats`; once a signature, AC-11) or `after` (a failure of one that fired).
 * A test written red and then fixed is one failure and no repeat (E-5). S-6 turns the first `after` into the block.
 */
export function count(state, sig, repeats, now = new Date()) {
  const at = now.toISOString();
  const f = state.failures[sig.hash];
  if (!f) {
    state.failures[sig.hash] = { repeats: 0, editedSince: false, fired: false, blocked: false, kind: sig.kind, label: sig.label, last: at };
    return 'new';
  }
  if (f.fired) {
    f.last = at;
    return 'after';
  }
  if (!f.editedSince) return 'rerun';
  f.repeats += 1;
  f.editedSince = false;
  f.last = at;
  if (f.repeats < repeats) return 'repeat';
  f.fired = true;
  return 'fire';
}

// An allowed edit makes the next failure of every tracked signature a fix that failed; false when nothing changed,
// so nothing is written.
export function markEdited(state, now = new Date()) {
  const open = Object.values(state.failures).filter((f) => f && !f.editedSince);
  if (!open.length) return false;
  for (const f of open) f.editedSince = true;
  state.edited = now.toISOString();
  return true;
}

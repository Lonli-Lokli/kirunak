import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, tmpdir } from 'node:os';

// The core's default `runner` (orchestrator.md §3): a headless `claude -p`, every flag from cli-reference.md and
// headless.md. Not --bare: a step needs the repo's CLAUDE.md, the PreToolUse hooks and the subscription. The process
// gets its own process group, so the orchestrator's timeout can kill its tree.

export const KEEP_ALIVE_PROMPT = 'keep-alive: reply with the word ok';
export const LIMITS_PROMPT = 'reply with the word ok';
const LIMITS_TIMEOUT_MS = 120000;
// The words of a session whose login is gone; an assistant message's `error` says it too, `authentication_failed`.
export const LOGIN_GONE = /\/login\b|not logged in|invalid api key|oauth token/i;
const OUTPUT_CAP = 10 * 1024 * 1024;

// The argv after `claude`. step: { prompt, model, effort, permissionMode, maxTurns, maxBudgetUsd, allowedTools,
// disallowedTools, deny, sessionId, resume, addDirs, stream }. `stream` asks for stream-json (which needs --verbose), a
// message a line as it comes, in place of the one JSON result. No --model or --effort when none is named, so Claude Code's own
// default applies. `tools` (a fixing session's or a review's) goes as --tools, so the session starts with only those
// tools' definitions; none named keeps every tool. `deny` (permission rules, a review's) goes as --settings' permissions.deny, with auto memory off (the repo's memory is shared with the implementing
// sessions and loads before any rule applies); the deny list adds to the
// other settings' rules. A new run reads its brief on stdin; a resumed one takes its prompt as the argument after -p.
export function claudeArgs(step) {
  const args = ['-p'];
  if (step.resume && step.prompt) args.push(step.prompt);
  args.push('--output-format', step.stream ? 'stream-json' : 'json');
  if (step.stream) args.push('--verbose');
  if (step.model) args.push('--model', step.model);
  if (step.effort) args.push('--effort', step.effort);
  args.push('--permission-mode', step.permissionMode || 'auto');
  if (step.maxTurns) args.push('--max-turns', String(step.maxTurns));
  if (step.maxBudgetUsd) args.push('--max-budget-usd', String(step.maxBudgetUsd));
  if (step.tools?.length) args.push('--tools', step.tools.join(','));
  for (const t of step.allowedTools || []) args.push('--allowedTools', t);
  for (const t of step.disallowedTools ?? ['Agent']) args.push('--disallowedTools', t);
  if (step.deny?.length) args.push('--settings', JSON.stringify({ permissions: { deny: step.deny }, autoMemoryEnabled: false }));
  if (!step.resume) args.push('--session-id', step.sessionId);
  for (const d of step.addDirs || []) args.push('--add-dir', d);
  if (step.resume) args.push('--resume', step.resume);
  return args;
}

// The JSON result on stdout (headless.md), or null. A stream of messages yields its last `result` message.
export function parseResult(stdout) {
  const text = String(stdout || '').trim();
  const pick = (x) => (Array.isArray(x) ? x.filter((m) => m?.type === 'result').pop() ?? null : x && typeof x === 'object' ? x : null);
  try {
    return pick(JSON.parse(text));
  } catch {}
  for (const line of text.split('\n').reverse()) {
    try {
      const x = pick(JSON.parse(line));
      if (x) return x;
    } catch {}
  }
  return null;
}

// The limits reading (gulnya/quad-damage AC-9, AC-10): the argv after `claude` for one turn on Haiku with no tools,
// whose stream carries the plan's `rate_limit_event`. --tools takes a list, so its empty one goes last.
export function limitsArgs() {
  return ['-p', LIMITS_PROMPT, '--model', 'haiku', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', '--tools', ''];
}

// The reading in a stream's lines: the last rate_limit_event with both windows, unifiedWindows' five_hour and
// seven_day, as { fiveHour: { used, resetsAt }, week: { used, resetsAt }, overage }, used in percent (two decimals) and
// resetsAt in epoch seconds; a refused turn after it still leaves a reading, the windows being why it was refused. With
// none, { error } says why: the login gone (an assistant message's `error`, or its words), the session failed, or no
// event came, or one without its windows.
export function readLimits(stdout, { exitCode = 0, stderr = '' } = {}) {
  const lines = [];
  for (const line of String(stdout || '').split('\n')) {
    try {
      const x = JSON.parse(line);
      if (x && typeof x === 'object') lines.push(x);
    } catch {}
  }
  const window = (w) => (Number.isFinite(w?.utilization) && Number.isFinite(w?.resetsAt) ? { used: Math.round(w.utilization * 10000) / 100, resetsAt: w.resetsAt } : null);
  const events = lines.filter((x) => x.type === 'rate_limit_event');
  for (const e of [...events].reverse()) {
    const u = e.rate_limit_info?.unifiedWindows;
    const fiveHour = window(u?.five_hour);
    const week = window(u?.seven_day);
    if (fiveHour && week) return { fiveHour, week, overage: e.rate_limit_info.isUsingOverage === true };
  }
  const result = lines.filter((x) => x.type === 'result').pop() ?? null;
  const assistant = lines.filter((x) => x.type === 'assistant');
  const words = (x) => (x?.message?.content || []).filter((c) => c?.type === 'text').map((c) => c.text);
  const parts = [...assistant.flatMap(words), result?.result, stderr].filter((t) => typeof t === 'string' && t.trim()).map((t) => t.replace(/\s+/g, ' ').trim());
  const said = [...new Set(parts)].join(' ').slice(0, 200);
  if (assistant.some((x) => x.error === 'authentication_failed') || LOGIN_GONE.test(said)) {
    return { error: `the login is gone: ${said || 'authentication failed'}` };
  }
  if (exitCode !== 0 || result?.is_error) return { error: `the session failed (exit ${exitCode})${said ? `: ${said}` : ''}` };
  if (events.length) return { error: 'its rate_limit_event has no unifiedWindows with five_hour and seven_day' };
  return { error: 'the session gave no rate_limit_event' };
}

// onMessage(message), when given, gets each line of stdout that parses as a JSON object, as it comes; what it throws
// is ignored, so a reader's fault never ends the session.
function spawnClaude(bin, args, { cwd, env, stdin, raw = false, onMessage = null }) {
  let out = '';
  let err = '';
  let part = '';
  const read = (b) => {
    const lines = (part + b).split('\n');
    part = lines.pop();
    for (const line of lines) {
      try {
        const x = JSON.parse(line);
        if (x && typeof x === 'object') onMessage(x);
      } catch {}
    }
  };
  const cap = (s, b) => (s.length + b.length > OUTPUT_CAP ? (s + b).slice(-OUTPUT_CAP) : s + b);
  let child;
  try {
    child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { pid: undefined, done: Promise.resolve({ exitCode: 127, result: null, usage: null, stderr: e.message, ...(raw ? { stdout: '' } : {}) }) };
  }
  child.stdout.on('data', (b) => {
    out = cap(out, String(b));
    if (onMessage) read(String(b));
  });
  child.stderr.on('data', (b) => (err = cap(err, String(b))));
  child.stdin.on('error', () => {});
  child.stdin.end(stdin ?? '');
  const closed = new Promise((r) => child.on('close', r));
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ exitCode: 127, result: null, usage: null, stderr: err + e.message, ...(raw ? { stdout: out } : {}) }));
    child.on('exit', async (code, signal) => {
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      if (onMessage && part) read('\n');
      const result = parseResult(out);
      resolve({ exitCode: code ?? 128 + (constants.signals[signal] || 0), result, usage: result?.usage ?? null, stderr: err, ...(raw ? { stdout: out } : {}) });
    });
  });
  return { pid: child.pid, done };
}

// runnerClaude(ws, { bin }): `bin` is the command, `claude` unless a test passes a fake.
export default function runnerClaude(ws, { bin = 'claude' } = {}) {
  const mode = () => ws?.runner?.permissionMode || 'auto';
  return {
    name: 'runner-claude',
    version: '1',
    provides: {
      runner: {
        // start(step) → { pid, sessionId, done: Promise<{ exitCode, result, usage, stderr }> }. step adds to the
        // seam's fields: prompt (the brief's text, or the resume prompt), sessionId, maxBudgetUsd, permissionMode,
        // addDirs, deny (a review's) and env (KIRUNAK_TASK, KIRUNAK_STEP); and onMessage(message), when the caller
        // reads the session as it goes (gulnya/quad-damage AC-11): the session then streams, each message handed to it.
        // The caller ends a session by killing the group of its pid.
        start(step) {
          const sessionId = step.resume || step.sessionId || randomUUID();
          const onMessage = typeof step.onMessage === 'function' ? step.onMessage : null;
          const args = claudeArgs({ ...step, prompt: step.prompt ?? step.brief, sessionId, permissionMode: step.permissionMode || mode(), stream: !!onMessage });
          const run = spawnClaude(bin, args, { cwd: step.cwd, env: step.env, stdin: step.resume ? '' : step.prompt ?? step.brief, onMessage });
          return { pid: run.pid, sessionId, done: run.done };
        },

        // One turn on the conversation, so its cache's lifetime starts again (orchestrator.md §5); the step's own
        // flags (add-dirs, model) come in `step`, since a resume does not remember them. → { pid, done: Promise<{
        // exitCode, result, usage }> }, so the orchestrator can hold it to a deadline and kill it; the whole result is
        // saved as the step's keep-<k>.json.
        keepAlive(sessionId, cwd, step = {}) {
          const args = claudeArgs({ ...step, resume: sessionId, prompt: KEEP_ALIVE_PROMPT, maxTurns: 1, maxBudgetUsd: null, permissionMode: step.permissionMode || mode() });
          const run = spawnClaude(bin, args, { cwd, env: step.env });
          return { pid: run.pid, done: run.done.then(({ exitCode, result, usage }) => ({ exitCode, result, usage })) };
        },

        // limits({ cwd, env, timeoutMs }) → Promise<the reading, or { error }> (readLimits): one turn on Haiku in an
        // empty place (the temporary folder unless `cwd` names one), killed with its tree when it outlasts timeoutMs.
        // Not part of the seam: a runner without it gives no reading.
        limits({ cwd = tmpdir(), env, timeoutMs = LIMITS_TIMEOUT_MS } = {}) {
          const run = spawnClaude(bin, limitsArgs(), { cwd, env, raw: true });
          let timer;
          const late = new Promise((resolve) => {
            timer = setTimeout(() => {
              try {
                process.kill(-run.pid, 'SIGKILL');
              } catch {}
              resolve({ error: `no reading in ${timeoutMs / 1000} s: the session was stopped` });
            }, timeoutMs);
          });
          const read = run.done.then(({ exitCode, stdout, stderr }) => readLimits(stdout, { exitCode, stderr }));
          return Promise.race([read, late]).finally(() => clearTimeout(timer));
        },
      },
    },
  };
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';

// The core's default `runner` (orchestrator.md §3): a headless `claude -p`, every flag from cli-reference.md and
// headless.md. Not --bare: a step needs the repo's CLAUDE.md, the PreToolUse hooks and the subscription. The process
// gets its own process group, so the orchestrator's timeout can kill its tree.

export const KEEP_ALIVE_PROMPT = 'keep-alive: reply with the word ok';
const OUTPUT_CAP = 10 * 1024 * 1024;

// The argv after `claude`. step: { prompt, model, effort, permissionMode, maxTurns, maxBudgetUsd, allowedTools,
// disallowedTools, sessionId, resume, addDirs }. No --model or --effort when none is named, so Claude Code's own
// default applies. A new run reads its brief on stdin; a resumed one takes its prompt as the argument after -p.
export function claudeArgs(step) {
  const args = ['-p'];
  if (step.resume && step.prompt) args.push(step.prompt);
  args.push('--output-format', 'json');
  if (step.model) args.push('--model', step.model);
  if (step.effort) args.push('--effort', step.effort);
  args.push('--permission-mode', step.permissionMode || 'auto');
  if (step.maxTurns) args.push('--max-turns', String(step.maxTurns));
  if (step.maxBudgetUsd) args.push('--max-budget-usd', String(step.maxBudgetUsd));
  for (const t of step.allowedTools || []) args.push('--allowedTools', t);
  for (const t of step.disallowedTools ?? ['Agent']) args.push('--disallowedTools', t);
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

function spawnClaude(bin, args, { cwd, env, stdin }) {
  let out = '';
  let err = '';
  const cap = (s, b) => (s.length + b.length > OUTPUT_CAP ? (s + b).slice(-OUTPUT_CAP) : s + b);
  let child;
  try {
    child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { pid: undefined, done: Promise.resolve({ exitCode: 127, result: null, usage: null, stderr: e.message }) };
  }
  child.stdout.on('data', (b) => (out = cap(out, String(b))));
  child.stderr.on('data', (b) => (err = cap(err, String(b))));
  child.stdin.on('error', () => {});
  child.stdin.end(stdin ?? '');
  const closed = new Promise((r) => child.on('close', r));
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ exitCode: 127, result: null, usage: null, stderr: err + e.message }));
    child.on('exit', async (code, signal) => {
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      const result = parseResult(out);
      resolve({ exitCode: code ?? 128 + (constants.signals[signal] || 0), result, usage: result?.usage ?? null, stderr: err });
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
        // addDirs and env (KIRUNAK_TASK, KIRUNAK_STEP).
        start(step) {
          const sessionId = step.resume || step.sessionId || randomUUID();
          const args = claudeArgs({ ...step, prompt: step.prompt ?? step.brief, sessionId, permissionMode: step.permissionMode || mode() });
          const run = spawnClaude(bin, args, { cwd: step.cwd, env: step.env, stdin: step.resume ? '' : step.prompt ?? step.brief });
          return { pid: run.pid, sessionId, done: run.done };
        },

        // One turn on the conversation, so its cache's lifetime starts again (orchestrator.md §5); the step's own
        // flags (add-dirs, model) come in `step`, since a resume does not remember them.
        async keepAlive(sessionId, cwd, step = {}) {
          const args = claudeArgs({ ...step, resume: sessionId, prompt: KEEP_ALIVE_PROMPT, maxTurns: 1, maxBudgetUsd: null, permissionMode: step.permissionMode || mode() });
          const { result } = await spawnClaude(bin, args, { cwd, env: step.env }).done;
          return result?.usage ?? null;
        },
      },
    },
  };
}

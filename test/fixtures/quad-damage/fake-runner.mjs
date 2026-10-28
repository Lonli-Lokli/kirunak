// gulnya/quad-damage S-4: a fake runner for Quad Damage's tests, no claude anywhere. A fixing session (its env names
// KIRUNAK_BUG_FIX) plays the next act of the script; a review session (KIRUNAK_BUG_REVIEW) writes the next verdict
// into the file its brief names. In a test it is fake(script); as a workspace plugin (the CLI's run) its script is the
// JSON file $FAKE_SCRIPT names.
//
// A verdict: 'clean' or 'findings' (the file written, 3 turns), or { text (the file's whole text, or null for none),
// exitCode (0), result (the result message, 3 turns by default; null for none) } for a review session gone wrong, or
// { verdict, sleep } for one that takes `sleep` seconds in a process of its own first (killed, it writes nothing), or
// { verdict, first, cost } for one whose first call's usage `first` streams and whose result costs `cost`.
//
// An act: { calls (tool calls streamed, 3), turns (the result's num_turns, calls + 1), first (a usage streamed before
// the calls, as the first call's), cost (the result's total_cost_usd), messages (streamed after the calls), sleep (the session's seconds, 0.05), commit: { file, text } (committed on the fix branch, in the worktree the
// brief names), master: { file, text } (committed on the fix repo's master after the fix, as the owner might), report
// (its text, or null for none) }. A session killed before its sleep ends does none of it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const READING = { fiveHour: { used: 10, resetsAt: 1793142600 }, week: { used: 50, resetsAt: 1793545200 }, overage: false };
const FINDING = "1. tiles.txt:1: the hour is not the forecast's refresh";
const use = (n) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'ls' } }] } });
const call = (usage) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }], usage } });
const answer = (n) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'ok' }] } });

function review(step, script) {
  const head = /^head: (\S+)$/m.exec(step.brief)[1];
  const base = /^base: (\S+)$/m.exec(step.brief)[1];
  const out = /^## Write `([^`]+)`$/m.exec(step.brief)[1];
  const next = script.verdicts.shift() ?? 'clean';
  if (typeof next === 'object' && next.sleep != null) {
    const child = spawn('sleep', [String(next.sleep)], { detached: true, stdio: 'ignore' });
    const done = new Promise((resolve) => child.on('exit', (code, signal) => {
      if (signal) return resolve({ exitCode: 128 + 15, result: null });
      script.verdicts.unshift(next.verdict ?? 'clean');
      resolve(review(step, script).done);
    }));
    return { pid: child.pid, sessionId: step.sessionId, done };
  }
  const verdict = typeof next === 'object' && 'verdict' in next ? next.verdict : next;
  const odd = typeof next === 'object' ? next : {};
  if (odd.first && typeof step.onMessage === 'function') step.onMessage(call(odd.first));
  const text = typeof verdict === 'object' ? verdict.text : `---\nverdict: ${verdict}\nhead: ${head}\nbase: ${base}\n---\n\n## Findings\n${verdict === 'clean' ? 'none' : FINDING}\n`;
  if (text != null) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  const result = 'result' in odd ? odd.result : { type: 'result', subtype: 'success', is_error: false, num_turns: 3, ...(odd.cost != null ? { total_cost_usd: odd.cost } : {}) };
  return { pid: null, sessionId: step.sessionId, done: Promise.resolve({ exitCode: odd.exitCode ?? 0, result }) };
}

function play(step, act) {
  const report = /^Your report goes to (.+)\.$/m.exec(step.brief)[1];
  const tree = /worktree add (\S+) -b /.exec(step.brief)[1];
  const branch = /Its fix branch: (\S+), from/.exec(step.brief)[1];
  if (act.commit) {
    if (!existsSync(tree)) {
      const has = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: step.cwd }).status === 0;
      git(step.cwd, 'worktree', 'add', '-q', ...(has ? [tree, branch] : ['-b', branch, tree, 'master']));
    }
    writeFileSync(join(tree, act.commit.file), act.commit.text);
    git(tree, 'add', '-A');
    git(tree, 'commit', '-q', '-m', 'the fix');
  }
  if (act.master) {
    writeFileSync(join(step.cwd, act.master.file), act.master.text);
    git(step.cwd, 'commit', '-q', '-am', 'master moves on');
  }
  if (act.report != null) {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, act.report);
  }
}

export function fake(script = {}) {
  script.fixes ??= [];
  script.verdicts ??= [];
  const steps = [];
  return {
    steps,
    limits: async () => script.reading ?? READING,
    keepAlive: () => null,
    start(step) {
      steps.push(step);
      if (step.env?.KIRUNAK_BUG_REVIEW) return review(step, script);
      const act = script.fixes.shift() ?? { calls: 0, turns: 1, report: null };
      const calls = act.calls ?? 3;
      const child = spawn('sleep', [String(act.sleep ?? 0.05)], { detached: true, stdio: 'ignore' });
      const done = new Promise((resolve) => child.on('exit', (code, signal) => {
        if (signal) return resolve({ exitCode: 128 + 15, result: null, stderr: '' });
        try {
          play(step, act);
        } catch (e) {
          return resolve({ exitCode: 1, result: { type: 'result', subtype: 'error', is_error: true, num_turns: calls + 1, result: e.message }, stderr: '' });
        }
        const cost = act.cost != null ? { total_cost_usd: act.cost } : {};
        resolve({ exitCode: 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: act.turns ?? calls + 1, result: 'done', ...cost }, stderr: '' });
      }));
      setImmediate(() => {
        if (typeof step.onMessage !== 'function') return;
        if (act.first) step.onMessage(call(act.first));
        for (let n = 1; n <= calls; n++) {
          step.onMessage(use(n));
          step.onMessage(answer(n));
        }
        for (const m of act.messages ?? []) step.onMessage(m);
      });
      return { pid: child.pid, sessionId: step.sessionId, done };
    },
  };
}

export default {
  name: 'fake-runner',
  version: '1',
  provides: { runner: fake(process.env.FAKE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8')) : {}) },
};

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attribute, decide, IDLE_MIN, LAG, lastUsage, limitOf, OVERSHOOT, projectRoot, SLACK, thresholdOf, userWindow, windowOf,
  windowSetting,
} from '../hooks/compact-rules.mjs';
import { factsOf } from '../hooks/kirunak-compact.mjs';
import { runningBy } from '../lib/steps.mjs';
import { makeRepos, writeJson } from './fixtures/compact/repos.mjs';

// gulnya/fresh-session-per-step S-4: the step boundary and the PreCompact hook (S-3 design §1-§4).

const HOOK = fileURLToPath(new URL('../hooks/kirunak-compact.mjs', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/compact/', import.meta.url));
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');
const MODEL = 'claude-opus-5-5';

// Transcript lines with only what the hook reads.
const assistant = (ctx, model = MODEL) =>
  JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: ctx - 102, output_tokens: 5 } } });
const toolResult = (bytes) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(bytes) }] } });
const writeTranscript = (path, lines) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
};

// ---- §1 The step boundary (R1.1-R1.4, E-2) ----

test('runningBy: two steps started in the same minute hold the boundary until the second finishes (E-2)', () => {
  const dir = makeRepos().top;
  const text = fixture('progress-overlap.md');
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-3']);
  assert.deepEqual(runningBy(`${text}2026-01-05 23:58 S-3 finished\n`, ['s-main'], dir), []);
});

test('runningBy: the chain\'s old id holds, a by-hand or k run start does not, needs.json pauses, failed closes', () => {
  const dir = makeRepos().top;
  const text = fixture('progress-mixed.md');
  assert.deepEqual(runningBy(text, ['s-main', 's-old'], dir), ['S-1', 'S-4', 'S-6']);
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-4', 'S-6']);
  writeJson(join(dir, 'steps', 'S-4', 'needs.json'), { owner: 'which one?' });
  assert.deepEqual(runningBy(text, ['s-main'], dir), ['S-6']);
  assert.deepEqual(runningBy(`${text}2026-01-05 11:00 S-4 resumed (session k-run-2)\n`, ['s-main'], join(dir, 'none')), ['S-4', 'S-6']);
  assert.deepEqual(runningBy(text, [], dir), []);
  assert.deepEqual(runningBy('', ['s-main'], dir), []);
});

test('runningBy: a 2,000-line progress.md in under 5 ms', () => {
  const dir = makeRepos().top;
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`2026-01-05 10:00 S-${i} started (session s-main)`, `2026-01-05 10:01 S-${i} finished`);
  const text = `${lines.join('\n')}\n2026-01-05 11:00 S-9999 started (session s-main)\n`;
  runningBy(text, ['s-main'], dir);
  const t0 = performance.now();
  const got = runningBy(text, ['s-main'], dir);
  const ms = performance.now() - t0;
  assert.deepEqual(got, ['S-9999']);
  assert.ok(ms < 5, `${ms.toFixed(2)} ms`);
});

// ---- §2 The context, the model, the window, the threshold (R2.1-R2.7) ----

test('lastUsage: the newest main-thread entry, passing over a synthetic one and a sidechain one', () => {
  const r = makeRepos();
  const path = join(r.top, 't.jsonl');
  writeFileSync(path, fixture('transcript.jsonl'));
  assert.deepEqual(lastUsage(path), { ctx: 152203, model: MODEL });
  writeFileSync(path, '{"type":"user","message":{"content":"no usage"}}\n');
  assert.equal(lastUsage(path), null);
  assert.equal(lastUsage(join(r.top, 'missing.jsonl')), null);
  assert.equal(lastUsage(null), null);
});

test('lastUsage: two 300 KB tool results after the last assistant entry are read past in the second read', () => {
  const path = join(makeRepos().top, 't.jsonl');
  writeTranscript(path, [assistant(90000), assistant(140000), toolResult(300 * 1024), toolResult(300 * 1024)]);
  assert.deepEqual(lastUsage(path), { ctx: 140000, model: MODEL });
  writeTranscript(path, [assistant(140000), toolResult(1100 * 1024)]);
  assert.equal(lastUsage(path), null);
});

test('windowOf: the ladder\'s 1M models, [1m] ids, and 200k for any other', () => {
  for (const id of ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-x-4[1m]']) assert.equal(windowOf(id), 1_000_000, id);
  assert.equal(windowOf('claude-other-4'), 200_000);
  assert.equal(windowOf(null), 200_000);
});

test('projectRoot: a repo\'s root, its subdirectory and its worktree give the main checkout; outside git and home give cwd', () => {
  const r = makeRepos();
  assert.equal(projectRoot(r.app), r.app);
  assert.equal(projectRoot(r.sub), r.app);
  assert.equal(projectRoot(r.worktree), r.app);
  assert.equal(projectRoot(r.plain), r.plain);
  assert.equal(projectRoot(r.sub, { homeDir: r.app }), r.sub);
  assert.equal(projectRoot(r.worktree, { mode: 'cwd' }), r.worktree);
});

test('windowSetting: env, per-model over top-level, local over shared over user, the root\'s file over a leftover, none', () => {
  const r = makeRepos();
  const base = { cwd: r.app, configDir: r.configDir, model: MODEL, roots: [r.app] };
  assert.deepEqual(windowSetting({ ...base, env: {} }), { window: 183000, from: { kind: 'local', file: join(r.app, '.claude', 'settings.local.json'), key: 'autoCompactWindow' }, kirunak: true, root: r.app });
  const env = windowSetting({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } });
  assert.deepEqual([env.window, env.from.kind, env.kirunak], [300000, 'env', false]);
  writeJson(join(r.app, '.claude', 'settings.local.json'), { autoCompactWindow: 183000, modelSettings: { [MODEL]: { autoCompactWindow: 200000 } } });
  const per = windowSetting({ ...base, env: {} });
  assert.deepEqual([per.window, per.from.key], [200000, `modelSettings.${MODEL}.autoCompactWindow`]);
  let asked = 0;
  windowSetting({ ...base, env: {}, model: () => (asked++, MODEL) });
  assert.equal(asked, 1, 'the model is asked for when a file has modelSettings');
  writeJson(join(r.sub, '.claude', 'settings.local.json'), { autoCompactWindow: 400000 });
  assert.equal(windowSetting({ ...base, cwd: r.sub, env: {} }).window, 200000, 'the root\'s file wins over a leftover');
  rmSync(join(r.app, '.claude', 'settings.local.json'));
  const left = windowSetting({ ...base, cwd: r.sub, env: {} });
  assert.deepEqual([left.window, left.from.kind, left.kirunak], [400000, 'local', true]);
  writeJson(join(r.plain, '.claude', 'settings.json'), { autoCompactWindow: 350000 });
  const shared = windowSetting({ ...base, cwd: r.plain, env: {} });
  assert.deepEqual([shared.window, shared.from.kind, shared.kirunak], [350000, 'shared', false]);
  const user = windowSetting({ ...base, cwd: r.worktree, env: {} });
  assert.deepEqual([user.window, user.from.kind, user.kirunak], [500000, 'user', false]);
  rmSync(join(r.configDir, 'settings.json'));
  assert.deepEqual(windowSetting({ ...base, cwd: r.worktree, env: {} }).from, { kind: 'none', file: null, key: null });
  const other = windowSetting({ ...base, cwd: r.other, env: {} });
  assert.deepEqual([other.window, other.from.kind, other.kirunak], [250000, 'local', false]);
});

test('thresholdOf clamps to [100,000, the model\'s window]; limitOf takes the number, else the user\'s, under the model\'s point', () => {
  assert.equal(thresholdOf(183000, 1_000_000), 150000);
  assert.equal(thresholdOf(50000, 1_000_000), 100000 - SLACK);
  assert.equal(thresholdOf(500000, 200_000), 200_000 - SLACK);
  assert.equal(thresholdOf(null, 1_000_000), 1_000_000 - SLACK);
  assert.equal(limitOf({ midStepLimit: 'user', user: 500000, wModel: 1_000_000 }), 500000);
  assert.equal(limitOf({ midStepLimit: 300000, user: 500000, wModel: 1_000_000 }), 300000);
  assert.equal(limitOf({ midStepLimit: 'user', user: 1_000_000, wModel: 1_000_000 }), 1_000_000 - SLACK - LAG);
  assert.equal(limitOf({ midStepLimit: 'user', user: 500000, wModel: 200_000 }), 117000);
  const r = makeRepos({ user: { autoCompactWindow: 500000, modelSettings: { [MODEL]: { autoCompactWindow: 400000 } } } });
  assert.equal(userWindow({ configDir: r.configDir, model: MODEL, wModel: 1_000_000 }).window, 400000);
  assert.equal(userWindow({ configDir: r.configDir, model: 'claude-other-4', wModel: 200_000 }).window, 500000);
  assert.deepEqual(userWindow({ configDir: join(r.top, 'none'), model: MODEL, wModel: 1_000_000 }), { window: 1_000_000, from: { kind: 'none', key: null } });
});

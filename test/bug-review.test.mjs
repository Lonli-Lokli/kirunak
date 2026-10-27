import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { list, reviewLockPath, reviewing } from '../lib/bugs.mjs';
import { checkReview, lock, review } from '../lib/bug-review.mjs';
import { events, gitCommitAll, gitInit, k, makeWorkspace, sh } from './helpers.mjs';

// gulnya/kirunak-bugs S-2: `k bug review <id>`, Review & merge, with a fake runner that writes the review file in
// scratch repos: never a real claude, never the real KIRUNAK_HOME.

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const BUG = 'hub/stale-tiles';
const BRANCH = 'bug/stale-tiles';
const git = (dir, ...args) => sh(dir, 'git', args).trim();
const NOBODY = () => [];

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const bugText = (front = '') => `---
id: ${BUG}
title: Stale map tiles
written: 2026-10-22
${front}---

## Who raised it
> the map shows yesterday's tiles
owner, 2026-10-22, session 5f0c2a

## Why
After a refresh the map keeps the old tiles.

## What was found
- the tile cache never expires [file tiles.txt]

## Fix written
- the cache expires

## Questions
1. Should the cache expire hourly?
   Proposed: hourly, as the forecast refreshes hourly
`;

// The invented workspace, kirunak's own checkout a scratch repo, the bug committed in hub and its fix, bug/stale-tiles,
// one commit changing tiles.txt in the fix repo (hub, or kirunak with `fixRepo: 'kirunak'`), checked out in a worktree
// of its own as a fixing session leaves it.
async function bugWorkspace({ fixRepo = null, plugin = false } = {}) {
  const w = await makeWorkspace();
  const self = join(w.root, 'kirunak-self');
  mkdirSync(self);
  gitInit(self);
  writeFileSync(join(self, 'tiles.txt'), 'cache: forever\n');
  gitCommitAll(self);
  let module = readFileSync(w.modulePath, 'utf8').replace("queue: './queue.md',", `queue: './queue.md',\n  kirunakRoot: ${JSON.stringify(self)},`);
  if (plugin) module = module.replace("plugins: ['./plugins/checklist.mjs']", "plugins: ['./plugins/checklist.mjs', './plugins/fake-runner.mjs']");
  writeFileSync(w.modulePath, module);
  if (plugin) writeFileSync(join(w.hub, 'kirunak', 'plugins', 'fake-runner.mjs'), FAKE_PLUGIN);
  writeFileSync(join(w.hub, 'tiles.txt'), 'cache: forever\n');
  put(join(w.hub, 'kirunak', 'bugs', 'stale-tiles.md'), bugText(fixRepo ? `fix-repo: ${fixRepo}\n` : ''));
  gitCommitAll(w.hub, 'the bug');
  w.ws.kirunakRoot = realpathSync(self);
  w.self = realpathSync(self);
  w.fix = fixRepo ? w.self : realpathSync(w.hub);
  w.tree = join(w.root, 'fix-tree');
  git(w.fix, 'worktree', 'add', '-q', '-b', BRANCH, w.tree);
  writeFileSync(join(w.tree, 'tiles.txt'), 'cache: one hour\n');
  gitCommitAll(w.tree, 'the cache expires');
  w.head = git(w.fix, 'rev-parse', BRANCH);
  w.bug = join(w.hub, 'kirunak', 'bugs', 'stale-tiles.md');
  return w;
}

const review1 = (w) => join(w.hub, 'kirunak', 'bugs', 'stale-tiles', 'review-1.md');
const answer = (verdict, head, base, findings = verdict === 'clean' ? 'none' : '1. tiles.txt:1: the hour is not the forecast\'s refresh') =>
  `---\nverdict: ${verdict}\nhead: ${head}\nbase: ${base}\n---\n\n## Findings\n${findings}\n`;

// A runner whose session writes what `write({ head, base, step })` returns into the file the brief names (nothing for
// null), after a short sleep; `calls` holds each step it was given, `errors` what `write` threw (the session still ends).
function fakeRunner(write) {
  const calls = [];
  const errors = [];
  return {
    calls,
    errors,
    start(step) {
      calls.push(step);
      const head = /^head: (\S+)$/m.exec(step.brief)[1];
      const base = /^base: (\S+)$/m.exec(step.brief)[1];
      const out = /^## Write `([^`]+)`$/m.exec(step.brief)[1];
      const child = spawn('sleep', ['0.05'], { detached: true });
      const done = new Promise((resolve) => child.on('exit', () => {
        try {
          const text = write({ head, base, step });
          if (text !== null) put(out, text);
        } catch (e) {
          errors.push(e);
        }
        resolve({ exitCode: 0, result: { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: step.sessionId, total_cost_usd: 0.1 } });
      }));
      return { pid: child.pid, sessionId: step.sessionId, done };
    },
    keepAlive: () => null,
  };
}

// The same, as a workspace plugin for the CLI: FAKE_VERDICT the verdict, FAKE_HOLD a file it waits for before it
// writes, FAKE_CALLS a file each call appends a line to.
const FAKE_PLUGIN = `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export default {
  name: 'fake-runner', version: '1',
  provides: { runner: {
    start(step) {
      const head = /^head: (\\S+)$/m.exec(step.brief)[1];
      const base = /^base: (\\S+)$/m.exec(step.brief)[1];
      const out = /^## Write \`([^\`]+)\`$/m.exec(step.brief)[1];
      if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, step.env.KIRUNAK_BUG_REVIEW + '\\n');
      const done = new Promise((resolve) => {
        const tick = () => {
          if (process.env.FAKE_HOLD && !existsSync(process.env.FAKE_HOLD)) return setTimeout(tick, 20);
          const verdict = process.env.FAKE_VERDICT || 'clean';
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, '---\\nverdict: ' + verdict + '\\nhead: ' + head + '\\nbase: ' + base + '\\n---\\n\\n## Findings\\n' + (verdict === 'clean' ? 'none' : '1. tiles.txt:1: wrong') + '\\n');
          resolve({ exitCode: 0, result: { type: 'result', subtype: 'success', num_turns: 1, session_id: step.sessionId, total_cost_usd: 0 } });
        };
        tick();
      });
      return { pid: null, sessionId: step.sessionId, done };
    },
    keepAlive: () => null,
  } },
};
`;

const parents = (root, rev) => git(root, 'rev-list', '--parents', '-n', '1', rev).split(' ').slice(1);
const fileAt = (root, rev, path) => git(root, 'show', `${rev}:${path}`);

test('a clean review merges the fix into master with --no-ff, closes the bug, removes its worktree, and pushes nothing', async () => {
  const w = await bugWorkspace();
  const before = git(w.hub, 'rev-parse', 'master');
  const runner = fakeRunner(({ head, base }) => answer('clean', head, base));
  w.ws.seams.runner = runner;
  const r = await review({ ws: w.ws, id: BUG, via: 'mod', processes: NOBODY });
  assert.equal(r.outcome, 'merged', JSON.stringify(r.problems));
  assert.deepEqual(r.problems, []);
  // The review session: Opus, the bug named in its env, a detached tree of the head it may not write, no agents.
  const [step] = runner.calls;
  assert.equal(step.model, 'opus');
  assert.equal(step.env.KIRUNAK_BUG_REVIEW, BUG);
  assert.deepEqual(step.disallowedTools, ['Agent']);
  assert.ok(step.deny.includes(`Write(/${step.cwd}/**)`) && step.deny.includes('Read(~/.claude/projects/**)'), step.deny.join(' '));
  assert.match(step.brief, /git diff master\.\.\.bug\/stale-tiles/);
  assert.match(step.brief, /cache: one hour/);
  assert.match(step.brief, /Stale map tiles/);
  assert.ok(!existsSync(step.cwd), 'the review tree is removed after the session');
  // The merge: a merge commit on master whose second parent is the fix, nothing pushed (there is no remote to push to).
  const merge = git(w.hub, 'rev-parse', r.merged);
  const ps = parents(w.hub, merge);
  assert.equal(ps.length, 2);
  assert.equal(ps[1], w.head);
  assert.ok(git(w.hub, 'merge-base', '--is-ancestor', before, merge) === '');
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
  assert.equal(git(w.hub, 'status', '--porcelain'), '');
  // The review committed beside the bug, then the bug and its folder removed in a commit naming the merge and review.
  assert.ok(!existsSync(w.bug) && !existsSync(review1(w)));
  const close = git(w.hub, 'log', '-1', '--format=%B', 'master');
  assert.match(close, /^kirunak: close the bug hub\/stale-tiles: bug\/stale-tiles merged into hub's master as [0-9a-f]{12}, after its review kirunak\/bugs\/stale-tiles\/review-1\.md/);
  assert.equal(readFileSync(join(w.hub, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/master');
  assert.match(fileAt(w.hub, r.review.commit, 'kirunak/bugs/stale-tiles/review-1.md'), /^verdict: clean$/m);
  // The fix's worktree and branch go once merged; the lock is let go; the event names who ran it.
  assert.ok(!existsSync(w.tree));
  assert.equal(git(w.hub, 'branch', '--list', BRANCH), '');
  assert.equal(reviewing(w.home, BUG), null);
  assert.ok(!existsSync(reviewLockPath(w.home, BUG)));
  const e = events(w.home).find((x) => x.kind === 'bug-review');
  assert.equal(e.via, 'mod');
  assert.equal(e.outcome, 'merged');
});

test('findings merge nothing: the review is committed beside the bug and the fix is not ready at that head', async () => {
  const w = await bugWorkspace();
  const master = git(w.hub, 'rev-parse', 'master');
  w.ws.seams.runner = fakeRunner(({ head, base }) => answer('findings', head, base));
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'findings');
  assert.deepEqual(r.findings, ["1. tiles.txt:1: the hour is not the forecast's refresh"]);
  assert.equal(git(w.hub, 'rev-parse', 'master~1'), master, 'only the review was committed');
  assert.equal(git(w.hub, 'log', '-1', '--format=%s'), 'kirunak: review-1.md of the bug hub/stale-tiles: findings');
  assert.equal(git(w.hub, 'diff', '--name-only', 'master~1', 'master'), 'kirunak/bugs/stale-tiles/review-1.md');
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: forever\n');
  assert.ok(existsSync(w.bug) && existsSync(w.tree));
  const row = list(w.ws).find((x) => x.id === BUG);
  assert.equal(row.fixReady, false);
  assert.equal(reviewing(w.home, BUG), null);
  await assert.rejects(review({ ws: w.ws, id: BUG, processes: NOBODY }), /has no fix ready \(fix not ready: review-1\.md found findings\)/);
});


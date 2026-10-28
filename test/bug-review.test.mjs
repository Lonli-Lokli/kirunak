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
// `first`, when given, is the usage its first call streams to the step's onMessage.
function fakeRunner(write, { first = null } = {}) {
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
        if (first) step.onMessage?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'reading' }], usage: first } });
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

test('a review starts without the workspace\'s denied tools, Agent always among them, and says what it spent (gulnya/headless-tools AC-1, AC-3)', async () => {
  const w = await bugWorkspace();
  w.ws.bugs = { ...w.ws.bugs, disallowedTools: ['Skill'] };
  const first = { input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 12000, output_tokens: 9 };
  const runner = fakeRunner(({ head, base }) => answer('findings', head, base), { first });
  w.ws.seams.runner = runner;
  const r = await review({ ws: w.ws, id: BUG, via: 'mod', processes: NOBODY });
  assert.equal(r.outcome, 'findings');
  assert.deepEqual(runner.calls[0].disallowedTools, ['Agent', 'Skill']);
  assert.equal(typeof runner.calls[0].onMessage, 'function', 'the review streams, so its first call is read');
  assert.equal(r.spent, '$0.10, first call 12,004 tokens (input 4, cache read 0, cache write 12,000)');
  const saved = JSON.parse(readFileSync(join(w.home, 'bugs', 'hub', 'stale-tiles', 'review-1', 'result.json'), 'utf8'));
  assert.deepEqual(saved.firstCall, { input: 4, cacheRead: 0, cacheWrite: 12000 });
  assert.equal(saved.result.total_cost_usd, 0.1);
});

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
  assert.deepEqual(step.disallowedTools, ['Agent', 'Artifact', 'Workflow', 'AskUserQuestion', 'Skill', 'ScheduleWakeup', 'SendFeedback', 'ReportFindings', 'ListAgents', 'ReadNotifications'], 'gulnya/headless-tools AC-1');
  assert.equal('tools' in step, false, 'no --tools: every deferred tool stays loadable through ToolSearch (E-1)');
  assert.ok(step.deny.includes(`Write(/${step.cwd}/**)`) && step.deny.includes('Read(~/.claude/projects/**)'), step.deny.join(' '));
  assert.match(step.brief, /git diff master\.\.\.bug\/stale-tiles/);
  assert.match(step.brief, /cache: one hour/);
  assert.match(step.brief, /Stale map tiles/);
  // E-2: a heavy test runs only through the heavy lock, at most that one job; with no bugs.heavyLock, CLAUDE.md's.
  assert.match(step.brief, /runs only through this machine's heavy lock, never bare: the heavy-lock command this machine's CLAUDE\.md names/);
  assert.match(step.brief, /Run at most that one queued job in this session/);
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

test('a malformed verdict is a finding: kirunak writes it so, quoting the session\'s file, and merges nothing', async () => {
  for (const [said, problem] of [
    [({ head, base }) => answer('looks good', head, base), /verdict looks good is neither clean nor findings/],
    [({ base }) => answer('clean', 'deadbeefdeadbeef', base), /head deadbeefdeadbeef is not the head reviewed/],
    [({ head, base }) => answer('clean', head, base, '1. tiles.txt:1: but also this'), /a clean verdict lists 1 finding/],
    [({ head, base }) => `---\nverdict: clean\nhead: ${head}\nbase: ${base}\n---\nall fine\n`, /no ## Findings section/],
    [() => null, /the review session wrote no review file/],
  ]) {
    const w = await bugWorkspace();
    w.ws.seams.runner = fakeRunner(said);
    const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
    assert.equal(r.outcome, 'findings', String(problem));
    assert.equal(r.merged, null);
    assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: forever\n');
    const text = readFileSync(review1(w), 'utf8');
    assert.match(text, /^verdict: findings$/m);
    assert.match(text, new RegExp(`^head: ${w.head}$`, 'm'));
    assert.match(text, /^1\. The review is not one kirunak can take, so it counts as a finding: /m);
    assert.match(text, problem);
    if (said({ head: 'x', base: 'y' }) !== null) assert.match(text, /^> verdict: /m, 'the session\'s file is quoted');
    assert.equal(list(w.ws).find((x) => x.id === BUG).fixReady, false);
  }
  // A well-formed file passes the same check.
  assert.deepEqual(checkReview(answer('clean', 'a'.repeat(40), 'b'.repeat(40)), { head: 'a'.repeat(40), base: 'b'.repeat(40) }).problems, []);
});

test('a conflict merges nothing, runs no review, and is written beside the bug naming its files', async () => {
  const w = await bugWorkspace();
  writeFileSync(join(w.hub, 'tiles.txt'), 'cache: a day\n');
  gitCommitAll(w.hub, 'master changes the same line');
  const master = git(w.hub, 'rev-parse', 'master');
  const runner = fakeRunner(() => assert.fail('no review runs on a conflict'));
  w.ws.seams.runner = runner;
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'conflict');
  assert.deepEqual(r.conflict, ['tiles.txt']);
  assert.equal(runner.calls.length, 0);
  assert.equal(git(w.hub, 'rev-parse', 'master~1'), master);
  const text = readFileSync(review1(w), 'utf8');
  assert.match(text, /^verdict: conflict$/m);
  assert.match(text, new RegExp(`^base: ${master}$`, 'm'));
  assert.match(text, /^- tiles\.txt$/m);
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: a day\n');
  assert.equal(git(w.hub, 'status', '--porcelain'), '');
  assert.equal(list(w.ws).find((x) => x.id === BUG).fixReady, false);
});

test('a second Review & merge is refused while the first lives, naming its pid and start; a dead one\'s lock is taken over', async () => {
  const w = await bugWorkspace();
  const first = spawn('sleep', ['30'], { detached: true });
  try {
    put(reviewLockPath(w.home, BUG), JSON.stringify({ pid: first.pid, started: '2026-10-27T09:00:00.000Z' }) + '\n');
    w.ws.seams.runner = fakeRunner(() => assert.fail('no review runs while another does'));
    await assert.rejects(review({ ws: w.ws, id: BUG, processes: NOBODY }),
      new RegExp(`hub/stale-tiles is in Review & merge already: pid ${first.pid}, started 2026-10-27T09:00:00.000Z`));
    assert.throws(() => lock(w.home, BUG, { pid: 1 << 22 }), /in Review & merge already/);
    // The CLI refuses it too, and its dry run.
    const cli = k(w.home, ['bug', 'review', BUG]);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, new RegExp(`pid ${first.pid}, started 2026-10-27T09:00:00.000Z`));
    assert.equal(JSON.parse(readFileSync(reviewLockPath(w.home, BUG), 'utf8')).pid, first.pid, 'the first one\'s lock stays');
  } finally {
    first.kill('SIGKILL');
  }
  await new Promise((r) => first.on('exit', r));
  w.ws.seams.runner = fakeRunner(({ head, base }) => answer('clean', head, base));
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'merged');
  assert.ok(!existsSync(reviewLockPath(w.home, BUG)));
});

test('a fix in another repo than the bug\'s merges there, and the bug closes in its own repo', async () => {
  const w = await bugWorkspace({ fixRepo: 'kirunak' });
  const hubTiles = readFileSync(join(w.hub, 'tiles.txt'), 'utf8');
  const runner = fakeRunner(({ head, base }) => answer('clean', head, base));
  w.ws.seams.runner = runner;
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'merged', JSON.stringify(r.problems));
  assert.equal(r.fixRepo, 'kirunak');
  assert.deepEqual(parents(w.self, 'master')[1], w.head);
  assert.equal(readFileSync(join(w.self, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), hubTiles);
  assert.match(git(w.hub, 'log', '-1', '--format=%s'), /^kirunak: close the bug hub\/stale-tiles: bug\/stale-tiles merged into kirunak's master as /);
  assert.ok(!existsSync(w.bug));
  assert.equal(git(w.self, 'log', '--format=%s', 'master').split('\n').filter((s) => s.startsWith('kirunak:')).length, 0, 'nothing of the bug in kirunak');
  assert.ok(!existsSync(w.tree));
  assert.ok(runner.calls[0].cwd.startsWith(join(w.home, 'bugs', 'hub', 'stale-tiles')));
});

test('a dirty index in the master checkout is never swept into the merge; a merge that would touch it is refused, and the clean review is taken again at the same head', async () => {
  // Another session's staged file the merge does not touch: merged beside it, the file still staged and in no commit.
  const w = await bugWorkspace();
  writeFileSync(join(w.hub, 'notes.txt'), 'another session\n');
  git(w.hub, 'add', 'notes.txt');
  w.ws.seams.runner = fakeRunner(({ head, base }) => answer('clean', head, base));
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'merged', JSON.stringify(r));
  assert.equal(git(w.hub, 'diff', '--cached', '--name-only'), 'notes.txt');
  assert.equal(git(w.hub, 'log', '--format=%H', '--', 'notes.txt'), '');
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
  assert.equal(git(w.hub, 'diff', '--name-only'), '', 'the checkout is brought up to the merge');
  assert.equal(parents(w.hub, r.merged)[1], w.head);
  assert.equal(git(w.hub, 'show', '--name-only', '--format=', r.closed), 'kirunak/bugs/stale-tiles.md\nkirunak/bugs/stale-tiles/review-1.md');

  // A staged change to the file the merge changes: refused, nothing merged, written in the review, which stays clean.
  const v = await bugWorkspace();
  const master = git(v.hub, 'rev-parse', 'master');
  writeFileSync(join(v.hub, 'tiles.txt'), 'cache: staged elsewhere\n');
  git(v.hub, 'add', 'tiles.txt');
  const runner = fakeRunner(({ head, base }) => answer('clean', head, base));
  v.ws.seams.runner = runner;
  const refused = await review({ ws: v.ws, id: BUG, processes: NOBODY });
  assert.equal(refused.outcome, 'merge-refused');
  assert.match(refused.why, /has changes of its own in files the merge changes \(tiles\.txt\)/);
  assert.equal(git(v.hub, 'rev-list', '--count', `${master}..master`), '2', 'the review and its refusal, no merge');
  assert.equal(git(v.hub, 'diff', '--cached', '--name-only'), 'tiles.txt');
  assert.equal(readFileSync(join(v.hub, 'tiles.txt'), 'utf8'), 'cache: staged elsewhere\n');
  const text = readFileSync(review1(v), 'utf8');
  assert.match(text, /^verdict: clean$/m);
  assert.match(text, /^## Merge refused, /m);
  assert.equal(list(v.ws).find((x) => x.id === BUG).fixReady, true);

  // Once the other session's change is gone, the clean review of that head is taken again: no second session.
  git(v.hub, 'reset', '-q', 'tiles.txt');
  git(v.hub, 'checkout', '--', 'tiles.txt');
  const again = await review({ ws: v.ws, id: BUG, processes: NOBODY });
  assert.equal(again.outcome, 'merged', JSON.stringify(again));
  assert.equal(again.review.reused, true);
  assert.equal(again.review.rel, 'kirunak/bugs/stale-tiles/review-1.md');
  assert.equal(runner.calls.length, 1);
  assert.equal(readFileSync(join(v.hub, 'tiles.txt'), 'utf8'), 'cache: one hour\n');
});

test('a fix whose branch moves during the review is not merged', async () => {
  const w = await bugWorkspace();
  w.ws.seams.runner = fakeRunner(({ head, base }) => {
    writeFileSync(join(w.tree, 'more.txt'), 'later\n');
    gitCommitAll(w.tree, 'a later commit');
    return answer('clean', head, base);
  });
  const r = await review({ ws: w.ws, id: BUG, processes: NOBODY });
  assert.equal(r.outcome, 'merge-refused');
  assert.match(r.why, /bug\/stale-tiles moved to [0-9a-f]+ while [0-9a-f]+ was reviewed/);
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: forever\n');
});

test('k bug review: no fix, a dry run, --json, and --detach returning at once with the lock held by the working process', async () => {
  const w = await bugWorkspace({ plugin: true });
  const scratch = w.root;
  const calls = join(scratch, 'calls.txt');

  const dry = k(w.home, ['bug', 'review', BUG, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^hub\/stale-tiles: bug\/stale-tiles at [0-9a-f]{12} in hub; would run a review and merge when it is clean$/m);
  assert.ok(!existsSync(reviewLockPath(w.home, BUG)));

  const none = k(w.home, ['bug', 'review', 'weather/no-such-bug']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no bug weather\/no-such-bug/);

  // --detach: returns while the review waits, names the log, and a second run is refused meanwhile.
  const hold = join(scratch, 'hold');
  const env = { FAKE_HOLD: hold, FAKE_CALLS: calls, FAKE_VERDICT: 'findings' };
  const d = k(w.home, ['bug', 'review', BUG, '--detach', '--json', '--via', 'mod'], env);
  assert.equal(d.status, 0, d.stderr);
  const started = JSON.parse(d.stdout);
  assert.equal(started.log, join(w.home, 'bugs', 'hub', 'stale-tiles', 'review.log'));
  const second = k(w.home, ['bug', 'review', BUG], env);
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`in Review & merge already: pid ${started.pid}, started ${started.started}`));
  assert.equal(reviewing(w.home, BUG)?.pid, started.pid);
  writeFileSync(hold, '');
  for (let i = 0; i < 300 && existsSync(reviewLockPath(w.home, BUG)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(reviewLockPath(w.home, BUG)), 'the detached review ends and lets its lock go');
  assert.equal(readFileSync(calls, 'utf8'), `${BUG}\n`);
  assert.match(readFileSync(started.log, 'utf8'), /review-1\.md found 1 thing; nothing merged.*\n {2}the review's session: \$0\.00\n/, 'gulnya/headless-tools AC-3');
  assert.match(readFileSync(review1(w), 'utf8'), /^verdict: findings$/m);
  assert.equal(events(w.home).find((x) => x.kind === 'bug-review').via, 'mod');

  // The fix is not ready at that head now; a new commit makes it ready, and a clean review merges it.
  const no = k(w.home, ['bug', 'review', BUG]);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /has no fix ready/);
  writeFileSync(join(w.tree, 'tiles.txt'), 'cache: as the forecast\n');
  gitCommitAll(w.tree, 'the fix again');
  const ok = k(w.home, ['bug', 'review', BUG, '--json'], { FAKE_CALLS: calls });
  assert.equal(ok.status, 0, ok.stderr);
  const done = JSON.parse(ok.stdout);
  assert.equal(done.outcome, 'merged');
  assert.equal(done.review.rel, 'kirunak/bugs/stale-tiles/review-2.md');
  assert.equal(readFileSync(join(w.hub, 'tiles.txt'), 'utf8'), 'cache: as the forecast\n');
});

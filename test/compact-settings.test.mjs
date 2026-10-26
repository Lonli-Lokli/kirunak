import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCompact, compactConfig, DEFAULT_COMPACT, rootsOf } from '../lib/compact.mjs';
import { escalateConfig } from '../lib/install.mjs';
import { gitCommitAll, gitInit, ladderWorkspace, sh } from './helpers.mjs';

// The handover's workspace settings (orchestrator.md §5, R7.1-R7.3): the defaults, the checks at load, the folders
// and config.json's `compact` block.

test('the defaults: the handover on, the measured size, the user\'s own window as the mid-step limit, no other folder', async () => {
  assert.deepEqual({ ...DEFAULT_COMPACT }, { enabled: true, handoverSize: 150000, midStepLimit: 'user', alsoIn: [] });
  assert.deepEqual(checkCompact(DEFAULT_COMPACT), [], '150000 + 33000 = 183000 is in the range');
  const { ws } = await ladderWorkspace();
  assert.deepEqual(ws.compact, { enabled: true, handoverSize: 150000, midStepLimit: 'user', alsoIn: [] });
  const { ws: own } = await ladderWorkspace({ compact: { handoverSize: 120000 } });
  assert.deepEqual(own.compact, { enabled: true, handoverSize: 120000, midStepLimit: 'user', alsoIn: [] }, 'merged with the defaults');
});

test('each value out of its range is refused at load, with its message', async () => {
  const bad = [
    [{ enabled: 'yes' }, 'compact.enabled must be true or false, not "yes"'],
    [{ handoverSize: 60000 }, 'compact.handoverSize must be a whole number from 67000 to 967000'],
    [{ handoverSize: 980000 }, 'compact.handoverSize must be a whole number from 67000 to 967000'],
    [{ handoverSize: 150000.5 }, 'compact.handoverSize must be a whole number'],
    [{ midStepLimit: 'mine' }, 'compact.midStepLimit must be \'user\' (the user\'s own window) or a whole number of at most 967000'],
    [{ midStepLimit: 970000 }, 'compact.midStepLimit must be \'user\''],
    [{ midStepLimit: 282999 }, 'compact.midStepLimit 282999 is under 283000 (handoverSize + 33000 + 100000): below that the hook could never hold a call'],
    [{ alsoIn: '~/sources/kirunak' }, 'compact.alsoIn must be a list of folders'],
    [{ alsoIn: [''] }, 'compact.alsoIn must be a list of folders'],
  ];
  for (const [compact, message] of bad) {
    const [problem] = checkCompact({ ...DEFAULT_COMPACT, ...compact });
    assert.ok(problem?.startsWith(message), `${JSON.stringify(compact)}: ${problem}`);
    await assert.rejects(ladderWorkspace({ compact }), (e) => e.message.includes(`: ${message}`), JSON.stringify(compact));
  }
  assert.deepEqual(checkCompact({ ...DEFAULT_COMPACT, midStepLimit: 283000 }), [], 'the floor itself passes');
  assert.deepEqual(checkCompact({ ...DEFAULT_COMPACT, midStepLimit: 500000 }), [], 'the owner\'s 500,000 passes');
  assert.deepEqual(checkCompact({ ...DEFAULT_COMPACT, midStepLimit: 967000 }), [], 'a 1M model\'s own point passes');
  assert.match(checkCompact(5)[0], /^compact must be an object/);
  await assert.rejects(ladderWorkspace({ compact: [] }), /compact must be an object/);
});

// A scratch git repo with a worktree, and a link to it: { dir, repo, worktree, link }.
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-compact-roots-')));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  gitInit(repo);
  writeFileSync(join(repo, 'README'), 'x\n');
  gitCommitAll(repo);
  const worktree = join(dir, 'repo-wt');
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', 'side', worktree]);
  symlinkSync(repo, join(dir, 'link'));
  return { dir, repo, worktree, link: join(dir, 'link') };
}

test('alsoIn is expanded and made real at load; a worktree root is its main checkout\'s, and each folder counts once', async () => {
  const s = scratch();
  const { ws } = await ladderWorkspace({ compact: { alsoIn: [s.link, join(s.dir, 'gone')] } });
  assert.deepEqual(ws.compact.alsoIn, [s.repo, join(s.dir, 'gone')], 'the link made real; a folder not there kept as written');
  const two = { repos: [{ name: 'side', root: s.worktree }], compact: { ...DEFAULT_COMPACT, alsoIn: [s.repo] } };
  assert.deepEqual(rootsOf(two), [{ name: 'side', root: s.worktree, dir: s.repo }], 'the worktree reads the main checkout\'s file');
  assert.deepEqual(rootsOf(null), []);
});

test('config.json carries the compact block: the switch, the size, the window, the limit and the roots, with and without alsoIn', async () => {
  const s = scratch();
  const ws = { repos: [{ name: 'repo', root: s.repo }], compact: { ...DEFAULT_COMPACT } };
  assert.deepEqual(compactConfig(ws), { enabled: true, handoverSize: 150000, window: 183000, midStepLimit: 'user', roots: [s.repo] });
  const other = join(s.dir, 'other');
  mkdirSync(other);
  ws.compact = { enabled: false, handoverSize: 100000, midStepLimit: 400000, alsoIn: [other] };
  assert.deepEqual(escalateConfig(ws).compact, { enabled: false, handoverSize: 100000, window: 133000, midStepLimit: 400000, roots: [s.repo, other] });
  assert.deepEqual(escalateConfig(null).compact, { enabled: true, handoverSize: 150000, window: 183000, midStepLimit: 'user', roots: [] },
    'before k init: the defaults, no roots');
});

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { copyLocalFiles } from '../lib/git.mjs';
import { loadWorkspaceModule } from '../lib/workspace.mjs';
import { gitCommitAll, gitInit, makeWorkspace, sh, tempDir } from './helpers.mjs';

// A repo's `localFiles` (the fault of 2026-11-25: Review & merge's tree had no local.properties, so its Gradle job
// failed in configuration): copied from the root into a new worktree, the workspace refusing a bad list.

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

test('copyLocalFiles copies the ignored files named, a folder too, and skips one the root lacks, one git tracks and one the tree has', () => {
  const dir = tempDir('kirunak-local-');
  const root = join(dir, 'app');
  mkdirSync(root);
  gitInit(root);
  put(join(root, '.gitignore'), 'local.properties\nsecrets/\nkept.txt\n');
  put(join(root, 'settings.gradle'), 'tracked\n');
  gitCommitAll(root);
  put(join(root, 'local.properties'), 'sdk.dir=/sdk\n');
  put(join(root, 'secrets', 'deep', 'key.txt'), 'k\n');
  put(join(root, 'kept.txt'), 'the root\'s\n');
  const tree = join(dir, 'tree');
  sh(root, 'git', ['worktree', 'add', '-q', '--detach', tree, 'HEAD']);
  put(join(tree, 'kept.txt'), 'the tree\'s\n');
  put(join(root, 'settings.gradle'), 'changed in the root\n');

  const r = copyLocalFiles(root, tree, ['local.properties', 'secrets', 'missing.env', 'settings.gradle', 'kept.txt']);
  assert.deepEqual(r, { copied: ['local.properties', 'secrets'], missing: ['missing.env'], skipped: ['settings.gradle', 'kept.txt'] });
  assert.equal(readFileSync(join(tree, 'local.properties'), 'utf8'), 'sdk.dir=/sdk\n');
  assert.equal(readFileSync(join(tree, 'secrets', 'deep', 'key.txt'), 'utf8'), 'k\n');
  assert.equal(readFileSync(join(tree, 'settings.gradle'), 'utf8'), 'tracked\n', 'a tracked file is the commit\'s, never copied');
  assert.equal(readFileSync(join(tree, 'kept.txt'), 'utf8'), 'the tree\'s\n', 'nothing is overwritten');
  assert.equal(sh(tree, 'git', ['status', '--porcelain']).trim(), '', 'the copies are ignored there too');
  assert.deepEqual(copyLocalFiles(root, tree, []), { copied: [], missing: [], skipped: [] });
});

test('a repo\'s localFiles load trimmed, none by default; a list that is no list of paths, or names one absolute or leaving the repo, is refused naming the repo', async () => {
  const { ws } = await makeWorkspace();
  const dir = dirname(ws.modulePath);
  const named = (file, localFiles) => {
    writeFileSync(join(dir, file), readFileSync(ws.modulePath, 'utf8')
      .replace("{ name: 'hub', root: '..' }", `{ name: 'hub', root: '..', localFiles: ${JSON.stringify(localFiles)} }`));
    return loadWorkspaceModule(join(dir, file));
  };
  assert.deepEqual(ws.repos.map((r) => r.localFiles), [[], []]);
  const good = await named('good.mjs', [' local.properties', 'config/dev.env', './a/../b.txt']);
  assert.deepEqual(good.repos.find((r) => r.name === 'hub').localFiles, ['local.properties', 'config/dev.env', './a/../b.txt']);
  for (const [file, bad] of [['string.mjs', 'local.properties'], ['empty.mjs', ['']], ['number.mjs', [3]]]) {
    await assert.rejects(named(file, bad), /repo hub: localFiles is a list of paths relative to its root/, file);
  }
  for (const [file, bad] of [['abs.mjs', '/etc/passwd'], ['up.mjs', '../weather/local.properties'], ['dots.mjs', 'a/../../x'],
    ['home.mjs', '~/x'], ['drive.mjs', 'C:\\x'], ['self.mjs', '.']]) {
    await assert.rejects(named(file, [bad]), /repo hub: localFiles .* is not inside the repo/, file);
  }
});

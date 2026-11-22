// Run by test/temp-cleanup.test.mjs with `node --test` under a private $TMPDIR: every helper that makes a temp folder,
// in a test that passes and in one that fails, so the run shows the folders go either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeClaude, ladderWorkspace, makeWorkspace, tempDir } from '../../helpers.mjs';

test('every helper makes its folder', async () => {
  const made = [(await makeWorkspace()).root, fakeClaude().dir, (await ladderWorkspace()).dir, tempDir('kirunak-x-')];
  assert.ok(made.every((d) => existsSync(d)));
});

test('a test that fails still has its folder removed', () => {
  tempDir('kirunak-failing-');
  assert.fail('this test fails on purpose');
});

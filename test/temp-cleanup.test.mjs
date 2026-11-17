import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURES, KIRUNAK } from './helpers.mjs';

// A test run leaves $TMPDIR as it found it (the bug gulnya/kirunak-tests-leave-temp): its fixtures once stayed
// behind, 14.6 GB of them in a day. Each test file below runs in a child under a $TMPDIR of its own, counted after.
const leftAfter = (file) => {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-temp-cleanup-'));
  try {
    // Without NODE_TEST_CONTEXT, which would make the child's `node --test` skip its files as a nested run.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = spawnSync(process.execPath, ['--test', file], { cwd: KIRUNAK, encoding: 'utf8', env: { ...env, TMPDIR: dir } });
    return { status: r.status, out: r.stdout + r.stderr, left: readdirSync(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('every helper\'s temp folder is gone when its test file ends, its tests passed or failed', () => {
  const r = leftAfter(join(FIXTURES, 'temp', 'leaves-nothing.mjs'));
  assert.match(r.out, /every helper makes its folder/);
  assert.match(r.out, /this test fails on purpose/);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.left, []);
});

test('a fixture-heavy test file leaves no temp folder behind', () => {
  const r = leftAfter(join(KIRUNAK, 'test', 'slap.test.mjs'));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.left, []);
});

// So a new test cannot leak again: only the helper makes temp folders, and so only the helper removes them.
test('no test makes a temp folder but through tempDir in helpers.mjs', () => {
  const files = readdirSync(join(KIRUNAK, 'test'), { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => join(KIRUNAK, 'test', f));
  const makers = files.filter((f) => !f.endsWith(join('test', 'helpers.mjs')) && !f.endsWith('temp-cleanup.test.mjs') && /mkdtemp/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(makers.map((f) => relative(KIRUNAK, f)), []);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// npm runs scripts through cmd.exe on Windows, which passes single quotes on to node as part of the pattern: node then
// matches no file, reports 0 tests and exits 0. Double quotes reach node bare from cmd.exe and sh alike.
test('the test script quotes its pattern with double quotes, so npm test runs the suite on Windows too (asilak/kirunak-npm-test-windows)', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(scripts.test, /'/);
  assert.match(scripts.test, /^node --test "test\/\*\.test\.mjs"$/);
});

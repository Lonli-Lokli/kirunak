import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIRUNAK, gitInit, sh } from './helpers.mjs';
import { isNotCode, measure, parseAttrs, parseNumstat, score, tier } from '../lib/slap.mjs';

test('the formula on the spec\'s cases', () => {
  assert.equal(score(10, 1), 3);
  assert.equal(score(45, 45), 20);
  assert.equal(score(1500, 1), 111);
  assert.equal(score(300, 5), 47);
  assert.equal(score(0, 0), 0);
});

test('the tiers', () => {
  assert.deepEqual([0, 10, 11, 35, 36, 70, 71, 400].map(tier), ['S', 'S', 'M', 'M', 'L', 'L', 'XL', 'XL']);
});

test('only code counts', () => {
  for (const p of ['package-lock.json', 'a/yarn.lock', 'Cargo.lock', 'web/dist/app.js', 'build/x.kt', 'a.min.js', 'a.js.map', 'README.md', 'notes.txt', 'data/x.tsv', 'x.csv']) {
    assert.ok(isNotCode(p), p);
  }
  for (const p of ['src/a.kt', 'lib/x.mjs', 'res/values/strings.xml', 'package.json', 'build.gradle.kts', 'scripts/run.sh']) {
    assert.ok(!isNotCode(p), p);
  }
});

test('numstat with a rename, and the attributes', () => {
  const files = parseNumstat('3\t1\tsrc/a.kt\0-\t-\timg.png\0' + '2\t2\t\0old/b.kt\0new/b.kt\0');
  assert.deepEqual(files.map((f) => f.path), ['src/a.kt', 'img.png', 'new/b.kt']);
  assert.equal(files[1].binary, true);
  const marked = parseAttrs('gen/T.kt\0linguist-generated\0set\0src/a.kt\0linguist-generated\0unspecified\0');
  assert.deepEqual([...marked], ['gen/T.kt']);
  const m = measure([...files, { added: 900, deleted: 0, path: 'gen/T.kt', binary: false }], marked);
  assert.equal(m.L, 8);
  assert.equal(m.F, 2);
  assert.deepEqual(m.skipped.map((s) => s.why), ['binary', 'marked in .gitattributes']);
});

// A temp repo with the hook installed as k install writes it.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-slap-'));
  gitInit(dir);
  const hook = join(dir, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(hook, `#!/bin/sh\nexec node ${JSON.stringify(join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs'))} "$@"\n`);
  chmodSync(hook, 0o755);
  return dir;
}

const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join('\n') + '\n';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KIRUNAK_') && !k.startsWith('GIT_')));
const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
const put = (dir, path, text) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const message = (dir) => sh(dir, 'git', ['log', '-1', '--format=%B']).trim();

// Ten files of a hundred lines: SLAP 118, XL.
const bigChange = (dir) => {
  for (let i = 0; i < 10; i++) put(dir, `src/f${i}.mjs`, lines(100, `f${i}_`));
};

test('a small commit records its score', () => {
  const dir = repo();
  put(dir, 'src/a.mjs', lines(10));
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-q', '-m', 'Add a\n\nThe body.\n\nCo-Authored-By: Someone <s@example.com>']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(message(dir), 'Add a\n\nThe body.\n\nCo-Authored-By: Someone <s@example.com>\nSLAP: 3 (S)');
});

test('an XL commit is refused, also under --no-verify', () => {
  const dir = repo();
  put(dir, 'README.md', '# r\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'root']);
  bigChange(dir);
  git(dir, ['add', '-A']);
  for (const extra of [[], ['--no-verify']]) {
    const r = git(dir, ['commit', '-q', ...extra, '-m', 'Everything at once']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /this commit is XL, SLAP 118: 1000 lines of code in 10 files/);
    assert.match(r.stderr, /no override/);
  }
  assert.equal(message(dir), 'root\n\nSLAP: 0 (S)');
});

test('prose, data, binary and generated files do not count', () => {
  const dir = repo();
  put(dir, '.gitattributes', 'gen/** linguist-generated\n');
  put(dir, 'docs/research.md', lines(3000));
  put(dir, 'data/table.tsv', lines(3000));
  put(dir, 'img.bin', Buffer.from([0, 1, 2, 0, 255]));
  for (let i = 0; i < 10; i++) put(dir, `gen/T${i}.kt`, lines(300));
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-q', '-m', 'Docs and generated tables']);
  assert.equal(r.status, 0, r.stderr);
  // Only .gitattributes counts: one line in one file rounds to 0.
  assert.match(message(dir), /SLAP: 0 \(S\)$/);
});

test('an amend is measured against the parent, and its line replaced', () => {
  const dir = repo();
  put(dir, 'README.md', '# r\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'root']);
  put(dir, 'src/a.mjs', lines(10));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Add a']);
  put(dir, 'src/b.mjs', lines(10, 'b'));
  git(dir, ['add', '-A']);
  assert.equal(git(dir, ['commit', '-q', '--amend', '--no-edit']).status, 0);
  assert.equal(message(dir), 'Add a\n\nSLAP: 6 (S)');
  bigChange(dir);
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-q', '--amend', '--no-edit']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /XL/);
});

test('a merge, a cherry-pick and a revert are not measured again', () => {
  const dir = repo();
  put(dir, 'README.md', '# r\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'root']);
  git(dir, ['checkout', '-q', '-b', 'side']);
  bigChange(dir);
  git(dir, ['add', '-A']);
  // Made before the rule: written with the hook out of the way.
  assert.equal(git(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Old XL work']).status, 0);
  const big = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', 'master']);
  put(dir, 'src/m.mjs', lines(5));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Main work']);
  const merge = git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'side']);
  assert.equal(merge.status, 0, merge.stderr);
  assert.doesNotMatch(message(dir), /SLAP/);
  const revert = git(dir, ['revert', '--no-edit', '-m', '1', 'HEAD']);
  assert.equal(revert.status, 0, revert.stderr);
  git(dir, ['checkout', '-q', '-b', 'other', 'HEAD~2']);
  const pick = git(dir, ['cherry-pick', big]);
  assert.equal(pick.status, 0, pick.stderr);
});

test('the root commit is measured against the empty tree', () => {
  const dir = repo();
  bigChange(dir);
  git(dir, ['add', '-A']);
  assert.notEqual(git(dir, ['commit', '-q', '-m', 'Root of everything']).status, 0);
});

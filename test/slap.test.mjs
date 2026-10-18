import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIRUNAK, gitInit, sh } from './helpers.mjs';
import { limit, measure, parseDiff, patternFor, score, tier } from '../lib/slap.mjs';
import { compile } from '../lib/ignore.mjs';

test('the formula on the spec\'s cases', () => {
  assert.equal(score(10, 1), 3);
  assert.equal(score(45, 45), 20);
  assert.equal(score(1500, 1), 111);
  assert.equal(score(300, 5), 47);
  assert.equal(score(0, 0), 0);
});

test('the tiers, and the most lines at most M allows', () => {
  assert.deepEqual([0, 10, 11, 35, 36, 70, 71, 400].map(tier), ['S', 'S', 'M', 'M', 'L', 'L', 'XL', 'XL']);
  assert.deepEqual([1, 3, 5, 10, 20].map(limit), [207, 209, 250, 126, 79]);
  assert.equal(score(207, 1), 35);
  assert.equal(score(208, 1), 36);
});

test('raw and numstat together: renames, deletions, binaries moved or changed', () => {
  const sha = (c) => c.repeat(40);
  const out = [
    `:100644 100644 ${sha('a')} ${sha('b')} M`, 'src/a.kt',
    `:100644 000000 ${sha('c')} ${sha('0')} D`, 'gone.kt',
    `:100644 100644 ${sha('d')} ${sha('e')} R097`, 'old/b.kt', 'new/b.kt',
    `:100644 100644 ${sha('f')} ${sha('f')} R100`, 'a.png', 'img/a.png',
    `:000000 100644 ${sha('0')} ${sha('9')} A`, 'new.png',
    '3\t1\tsrc/a.kt', '0\t400\tgone.kt', '2\t2\t', 'old/b.kt', 'new/b.kt', '-\t-\t', 'a.png', 'img/a.png', '-\t-\tnew.png', '',
  ].join('\0');
  const files = parseDiff(out);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary, f.moved]), [
    ['src/a.kt', 'M', false, false], ['gone.kt', 'D', false, false], ['new/b.kt', 'R', false, false],
    ['img/a.png', 'R', true, true], ['new.png', 'A', true, false],
  ]);
  const m = measure(files);
  assert.equal(m.L, 8);
  assert.equal(m.F, 2);
  assert.deepEqual(m.binaries, ['new.png']);
  assert.deepEqual(m.skipped.map((x) => x.why), ['deleted', 'moved', 'binary']);
  assert.deepEqual(measure(files, compile('*.png\nsrc/\n')).binaries, []);
  assert.equal(measure(files, compile('*.png\nsrc/\n')).L, 4);
});

test('the pattern a binary file names', () => {
  assert.equal(patternFor('art/icon.webp'), '*.webp');
  assert.equal(patternFor('bin/tool'), '/bin/tool');
  assert.equal(patternFor('.DS_Store'), '/.DS_Store');
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

test('35 passes; 36 is refused, also under --no-verify, with the limit and how to split', () => {
  const dir = repo();
  put(dir, 'src/root.mjs', 'export {};\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'root']);
  put(dir, 'src/a.mjs', lines(207));
  git(dir, ['add', '-A']);
  assert.equal(git(dir, ['commit', '-q', '-m', 'At the edge']).status, 0);
  assert.match(message(dir), /SLAP: 35 \(M\)$/);
  put(dir, 'src/b.mjs', lines(208, 'b'));
  git(dir, ['add', '-A']);
  for (const extra of [[], ['--no-verify']]) {
    const r = git(dir, ['commit', '-q', ...extra, '-m', 'One over']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /this commit is L, SLAP 36: 208 lines of code in 1 files \(src\/b\.mjs\)/);
    assert.match(r.stderr, /at most 207 lines \(207 in 1 file, 250 in 5 files, 126 in 10 files, 79 in 20 files\)/);
    assert.match(r.stderr, /no override/);
    assert.match(r.stderr, /git add -p/);
  }
  assert.match(message(dir), /^At the edge/);
});

test('with no .slapignore everything counts: a Markdown file too', () => {
  const dir = repo();
  put(dir, 'docs/research.md', lines(300));
  git(dir, ['add', '-A']);
  const r = git(dir, ['commit', '-q', '-m', 'Research']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SLAP \d+: 300 lines of code in 1 files \(docs\/research\.md\)/);
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

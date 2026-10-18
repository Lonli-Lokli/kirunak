import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitInit, sh } from './helpers.mjs';
import { compile, ignored } from '../lib/ignore.mjs';

// `.slapignore` is matched as git matches a .gitignore (gitignore(5)); git itself is the oracle.

const PATHS = [
  'README.md', 'docs/guide.md', 'docs/deep/notes.txt', 'src/a.kt', 'src/README.MD', 'src/gen/T.kt', 'gen/T.kt',
  'build/out.js', 'app/build/x.class', 'app/builder.kt', 'web/dist/app.min.js', 'web/app.js.map', 'yarn.lock',
  'a/b/Cargo.lock', 'package-lock.json', 'data/x.tsv', 'logs/run.log', 'keep/important.log', 'img/a.png',
  'img/b.PNG', 'forecast/src/Tables.kt', 'forecast/tables.tsv', 'x/y/z/deep.kt', 'only/dir', 'a?b.kt',
  'name with space.kt', 'sq[1].kt', 'a1.kt', 'ab.kt', '#hash.kt', '!bang.kt', 'trail.kt', 'vendor/keep.kt',
  'vendor/lib/x.kt',
];

const PATTERNS = `# a comment
*.md
docs/**
build/
dist/
*.min.js
*.map
*.lock
/package-lock.json
data/*.tsv
*.log
!keep/important.log
*.png
**/gen/T.kt
forecast/src/Tables.kt
x/**/deep.kt
only/dir/
a[0-9].kt
\\#hash.kt
\\!bang.kt
trail.kt\\
name with space.kt
vendor/
!vendor/keep.kt
`;

test('the patterns match what git leaves out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-ignore-'));
  gitInit(dir);
  for (const p of PATHS) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), 'x\n');
  }
  sh(dir, 'git', ['add', '-A']);
  const file = join(dir, '..', `${dir.split('/').pop()}.slapignore`);
  writeFileSync(file, PATTERNS);
  const git = sh(dir, 'git', ['-c', 'core.ignorecase=false', 'ls-files', '-z', '-c', '-i', `--exclude-from=${file}`])
    .split('\0').filter(Boolean).sort();
  const ours = PATHS.filter((p) => ignored(compile(PATTERNS), p)).sort();
  assert.deepEqual(ours, git);
  assert.ok(ours.length > 15 && ours.length < PATHS.length - 5, 'the fixture exercises both sides');
});

test('the rules, one by one', () => {
  const is = (patterns, path) => ignored(compile(patterns), path);
  assert.ok(is('*.md', 'a/b/c.md'), 'no slash: any level');
  assert.ok(!is('/a.md', 'b/a.md'), 'a leading slash anchors');
  assert.ok(is('docs/*.md', 'docs/a.md') && !is('docs/*.md', 'x/docs/a.md'), 'a middle slash anchors');
  assert.ok(is('build/', 'x/build/y.kt') && !is('build/', 'build'), 'a trailing slash: folders only');
  assert.ok(is('**/gen', 'a/b/gen/c.kt') && is('a/**/b', 'a/b') && is('a/**/b', 'a/x/y/b'));
  assert.ok(is('*.log\n!keep.log', 'a.log') && !is('*.log\n!keep.log', 'keep.log'), 'the last match decides');
  assert.ok(is('logs/\n!logs/keep.log', 'logs/keep.log'), 'nothing inside a left-out folder comes back');
  assert.ok(!is('*.png', 'a.PNG'), 'case-sensitive');
  assert.ok(!is('', 'a.md') && !is('# *.md', 'a.md'), 'blank lines and comments match nothing');
  assert.ok(is('a[!b].kt', 'ac.kt') && !is('a[!b].kt', 'ab.kt') && !is('a[!b].kt', 'a/.kt'));
  assert.ok(is('a?.kt', 'ax.kt') && !is('a?.kt', 'a/.kt'), '? is one character but a slash');
});

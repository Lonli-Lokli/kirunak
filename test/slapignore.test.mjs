import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../lib/install.mjs';
import { approve, marked, register, starter, status, STARTER } from '../lib/slapignore.mjs';
import { readRecords, recordFile } from '../lib/slap.mjs';
import { KIRUNAK, gitInit, gitCommitAll } from './helpers.mjs';

// R21, R23: the starter `k install --git` writes, the registry, and the owner's approval (design/change-size.md §4).

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-slapignore-'));
  const repo = join(dir, 'weather');
  mkdirSync(join(repo, 'src'), { recursive: true });
  gitInit(repo);
  writeFileSync(join(repo, 'src', 'a.kt'), 'val a = 1\n');
  writeFileSync(join(repo, 'src', 'fixture.kt'), Buffer.from([0, 7, 0, 8]));
  writeFileSync(join(repo, 'README.MD'), '# r\n');
  writeFileSync(join(repo, 'icon.png'), Buffer.from([0, 1, 0, 2]));
  writeFileSync(join(repo, 'art.PNG'), Buffer.from([0, 3, 0, 4]));
  mkdirSync(join(repo, 'build'));
  writeFileSync(join(repo, 'build', 'out.bin'), Buffer.from([0, 5]));
  writeFileSync(join(repo, '.gitattributes'), '*.png binary\ngen/** linguist-generated\ndocs/x.kt linguist-documentation=true\nold.kt -linguist-generated\n');
  gitCommitAll(repo);
  return { dir, repo, home: join(dir, 'state') };
}

const k = (args, home, cwd) =>
  spawnSync(process.execPath, [join(KIRUNAK, 'bin', 'k.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, KIRUNAK_HOME: home } });

test('the starter: A-7\'s list, the case variants, the binary files the repo tracks, the .gitattributes marks', () => {
  const s = setup();
  const text = starter(s.repo);
  assert.ok(text.startsWith(STARTER));
  const after = text.slice(STARTER.length);
  assert.match(after, /# The same, in the other cases this repo uses\n\*\.MD\n/);
  // A type every file of which is binary is named by its extension; a binary .kt among code is named alone.
  assert.match(after, /# Binary files this repo tracks\n\*\.PNG\n\*\.png\n\/src\/fixture\.kt\n/);
  assert.match(after, /# Marked generated, vendored or documentation in \.gitattributes\ngen\/\*\*\ndocs\/x\.kt\n$/);
  assert.doesNotMatch(after, /\.bin/, 'build/ already leaves out what is in it');
  assert.deepEqual(marked('a linguist-vendored\n# b linguist-generated\nc text\n'), ['a']);
});

test('k install --git writes the starter, registers the repo, and keeps a .slapignore that is there', () => {
  const s = setup();
  const kirunakRoot = mkdtempSync(join(tmpdir(), 'kirunak-root-'));
  for (const n of ['k-intake', 'k-done']) mkdirSync(join(kirunakRoot, 'skills', n), { recursive: true });
  const opts = { settingsPath: join(s.dir, 'settings.json'), skillsDir: join(s.dir, 'skills'), kirunakRoot, home: s.home, git: s.repo };
  const printed = install({ ...opts, print: true }).actions.join('\n');
  assert.match(printed, /would write .*\.slapignore, a starter for the owner to approve/);
  assert.ok(!existsSync(join(s.repo, '.slapignore')) && !existsSync(recordFile(s.home)), '--print writes nothing');
  const { actions } = install(opts);
  assert.equal(readFileSync(join(s.repo, '.slapignore'), 'utf8'), starter(s.repo));
  assert.ok(actions.some((a) => /ask the owner to read it and type `! k slapignore approve/.test(a)));
  assert.deepEqual(status(s.home).map((x) => x.state), ['unapproved']);
  writeFileSync(join(s.repo, '.slapignore'), '*.md\n');
  install(opts);
  assert.equal(readFileSync(join(s.repo, '.slapignore'), 'utf8'), '*.md\n');
  assert.equal(register(s.home, s.repo), false, 'registered once');
});

test('approve: one repo, then --all; the record keeps its history; a missing file refuses with nothing written', () => {
  const s = setup();
  const other = join(s.dir, 'hub');
  mkdirSync(other);
  gitInit(other);
  for (const r of [s.repo, other]) {
    register(s.home, r);
    writeFileSync(join(r, '.slapignore'), '*.md\n');
  }
  const now = new Date(2026, 9, 18, 22, 0, 0);
  assert.equal(approve({ home: s.home, repos: [s.repo], now })[0].patterns, 1);
  assert.deepEqual(status(s.home).map((x) => x.state), ['approved', 'unapproved']);
  writeFileSync(join(s.repo, '.slapignore'), '*.md\n*.txt\n');
  assert.deepEqual(status(s.home).map((x) => x.state), ['changed', 'unapproved']);
  assert.deepEqual(approve({ home: s.home, all: true, dryRun: true }).map((r) => r.already ?? false), [false, false]);
  assert.deepEqual(status(s.home).map((x) => x.state), ['changed', 'unapproved'], 'a dry run writes nothing');
  const rows = approve({ home: s.home, all: true, now });
  assert.equal(rows.length, 2);
  const rec = Object.values(readRecords(s.home))[0];
  assert.equal(rec.by, 'owner');
  assert.equal(rec.history.length, 2);
  assert.deepEqual(approve({ home: s.home, all: true }), []);
  assert.equal(approve({ home: s.home, repos: ['weather'] })[0].already, true, 'a registered repo by its name');
  const before = readFileSync(recordFile(s.home), 'utf8');
  const third = join(s.dir, 'third');
  mkdirSync(third);
  gitInit(third);
  assert.throws(() => approve({ home: s.home, repos: [s.repo, third] }), /has no \.slapignore to approve/);
  assert.equal(readFileSync(recordFile(s.home), 'utf8'), before);
  assert.throws(() => approve({ home: s.home }), /approve <repo>/);
});

test('end to end: the starter refuses commits until the owner approves it through k', () => {
  const s = setup();
  const hook = join(s.repo, '.git', 'hooks', 'prepare-commit-msg');
  writeFileSync(hook, `#!/bin/sh\nexec node ${JSON.stringify(join(KIRUNAK, 'hooks', 'git-prepare-commit-msg.mjs'))} "$@"\n`);
  chmodSync(hook, 0o755);
  register(s.home, s.repo);
  writeFileSync(join(s.repo, '.slapignore'), starter(s.repo));
  const env = { ...process.env, KIRUNAK_HOME: s.home };
  const git = (args) => spawnSync('git', args, { cwd: s.repo, encoding: 'utf8', env });
  git(['add', '.slapignore']);
  assert.notEqual(git(['commit', '-q', '-m', 'The starter']).status, 0);
  assert.match(k(['slapignore', 'status'], s.home, s.repo).stdout, /^unapproved /);
  const r = k(['slapignore', 'approve', '--all'], s.home, s.repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^approved .*\/weather\/\.slapignore \(\d+ patterns, sha256:/);
  const c = git(['commit', '-q', '-m', 'The starter']);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(k(['slap', '--staged'], s.home, s.repo).status, 0);
});

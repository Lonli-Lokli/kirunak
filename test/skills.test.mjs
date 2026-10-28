import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS as LINKED } from '../lib/install.mjs';
import { KIRUNAK } from './helpers.mjs';

// The seven skills and the README rely on nothing kirunak does not ship (R1, R15, D2): every command they name is one
// of an allow-list, every path is in this repo, a task folder or Claude Code's own settings, every skill is kirunak's.
const FILES = ['skills/k-intake/SKILL.md', 'skills/k-done/SKILL.md', 'skills/k-board-page/SKILL.md', 'skills/k-draft/SKILL.md', 'skills/k-bug/SKILL.md', 'skills/k-go-on/SKILL.md', 'skills/usage-review/SKILL.md', 'README.md'];
const COMMANDS = new Set(['k', 'claude', 'git', 'node', 'npm', 'cd']);
const SLASH = new Set(['/k-intake', '/k-done', '/k-approve', '/k-accept', '/k-hold', '/k-resume', '/k-start', '/kirunak', '/k-board-page', '/clear', '/k-list', '/k-board', '/k-amendments', '/k-approve-amendment', '/k-queue', '/k-drafts', '/k-bugs', '/k-go-on', '/usage-review']);
const SKILLS = new Set(['k-intake', 'k-done', 'k-board-page', 'k-draft', 'k-bug', 'k-go-on', 'usage-review']);

const read = (f) => readFileSync(join(KIRUNAK, f), 'utf8');

function codeLines(text) {
  const out = [];
  for (const m of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    if (!['', 'sh', 'bash', 'shell'].includes(m[1])) continue;
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('---') && !/^[A-Za-z-]+:/.test(t) && !/^[-#]/.test(t)) out.push(t);
    }
  }
  return out;
}

for (const f of FILES) {
  test(`${f} names only allowed commands`, () => {
    const text = read(f);
    for (const line of codeLines(text)) {
      for (const part of line.split(/&&|\|\||;|\|/)) {
        const word = part.trim().replace(/^[!$]\s*/, '').split(/\s+/)[0];
        if (!word || word.startsWith('<') || word.startsWith('[')) continue;
        assert.ok(COMMANDS.has(word), `${f}: "${line}" runs ${word}`);
      }
    }
    for (const m of text.matchAll(/`!\s*(\S+)/g)) assert.equal(m[1], 'k', `${f}: a typed command runs ${m[1]}`);
  });

  test(`${f} names only kirunak's slash commands and skills`, () => {
    const text = read(f);
    for (const m of text.matchAll(/(?<![\w./~<>-])\/[a-z][a-z-]+\b/g)) {
      assert.ok(SLASH.has(m[0]), `${f}: ${m[0]}`);
    }
    for (const m of text.matchAll(/`([a-z][a-z0-9:-]+)` skill|the ([a-z][a-z0-9:-]+) skill/g)) {
      assert.ok(SKILLS.has(m[1] || m[2]), `${f}: the ${m[1] || m[2]} skill`);
    }
  });

  test(`${f} names no path outside this repo`, () => {
    const text = read(f);
    const bad = text.match(/(^|[\s(`'"])(\/Users\/|\/home\/|\/opt\/|\/usr\/|\/private\/|~\/(?!\.claude\/|code\/|\.kirunak))/m);
    assert.equal(bad, null, `${f}: ${bad && bad[0]}`);
  });
}

test('the skills stay short', () => {
  // 130 since a bug's Start fix (gulnya/kirunak-bugs AC-8) took its own section.
  assert.ok(read('skills/k-intake/SKILL.md').split('\n').length <= 130);
  assert.ok(read('skills/k-done/SKILL.md').split('\n').length <= 60);
  assert.ok(read('skills/k-board-page/SKILL.md').split('\n').length <= 40);
  assert.ok(read('skills/k-draft/SKILL.md').split('\n').length <= 80);
  assert.ok(read('skills/k-bug/SKILL.md').split('\n').length <= 80);
  assert.ok(read('skills/k-go-on/SKILL.md').split('\n').length <= 20);
  assert.ok(read('skills/usage-review/SKILL.md').split('\n').length <= 60);
});

test('k install links every skill this repo ships, and only those', () => {
  const shipped = readdirSync(join(KIRUNAK, 'skills')).filter((d) => !d.startsWith('.')).sort();
  assert.deepEqual([...LINKED].sort(), shipped);
  assert.deepEqual([...SKILLS].sort(), shipped);
});

test('a fault goes to k-bug and new work to k-draft: each description says so (gulnya/kirunak-bugs AC-9)', () => {
  const description = (name) => /^description: (.+)$/m.exec(read(`skills/${name}/SKILL.md`))[1];
  assert.match(description('k-bug'), /fault in something that already exists/);
  assert.match(description('k-bug'), /Not for new work/);
  assert.match(description('k-draft'), /Not for a fault in something that exists already/);
  assert.doesNotMatch(description('k-draft'), /--bug-of|a bug turns up/);
});

test('k-go-on is the owner\'s alone: the model may not invoke it (design/approval.md §7, E-11)', () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(read('skills/k-go-on/SKILL.md'))[1];
  assert.match(front, /^name: k-go-on$/m);
  assert.match(front, /^disable-model-invocation: true$/m);
});

test('the README is its four parts and the licence line', () => {
  const text = read('README.md');
  assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['What it is', 'Setup', 'Change size', 'Working a task']);
  assert.match(text.trim().split('\n').at(-1), /MIT/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIRUNAK } from './helpers.mjs';

// The four skills and the README rely on nothing kirunak does not ship (R1, R15, D2): every command they name is one
// of an allow-list, every path is in this repo, a task folder or Claude Code's own settings, every skill is kirunak's.
const FILES = ['skills/k-intake/SKILL.md', 'skills/k-done/SKILL.md', 'skills/k-board-page/SKILL.md', 'skills/k-draft/SKILL.md', 'README.md'];
const COMMANDS = new Set(['k', 'claude', 'git', 'node', 'npm', 'cd']);
const SLASH = new Set(['/k-intake', '/k-done', '/k-approve', '/k-accept', '/k-hold', '/k-resume', '/k-start', '/kirunak', '/k-board-page', '/clear', '/k-list', '/k-board', '/k-amendments', '/k-approve-amendment', '/k-queue', '/k-drafts']);
const SKILLS = new Set(['k-intake', 'k-done', 'k-board-page', 'k-draft']);

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
  assert.ok(read('skills/k-intake/SKILL.md').split('\n').length <= 120);
  assert.ok(read('skills/k-done/SKILL.md').split('\n').length <= 60);
  assert.ok(read('skills/k-board-page/SKILL.md').split('\n').length <= 40);
  assert.ok(read('skills/k-draft/SKILL.md').split('\n').length <= 80);
});

test('the README is its four parts and the licence line', () => {
  const text = read('README.md');
  assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['What it is', 'Setup', 'Change size', 'Working a task']);
  assert.match(text.trim().split('\n').at(-1), /MIT/);
});

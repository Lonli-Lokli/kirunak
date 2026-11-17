// Line endings: kirunak reads its templates the same from a clone whose files have CRLF endings (Windows with
// core.autocrlf true) as from one with LF. The .gitattributes keeps the working tree LF; readText() (lib/os.mjs) turns
// CRLF into LF for a clone made before it, or a file copied in by hand. The CI workflow runs this file on Windows.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { skeleton } from '../lib/bugs.mjs';
import { readText } from '../lib/os.mjs';
import { tempDir } from './helpers.mjs';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const names = readdirSync(TEMPLATES).filter((n) => n.endsWith('.md')).sort();

// A copy of templates/<name> with every line ending CRLF, in a fresh temp folder.
function crlfCopy(name) {
  const lf = readFileSync(join(TEMPLATES, name), 'utf8').replaceAll('\r\n', '\n');
  const path = join(tempDir('kirunak-crlf-'), name);
  writeFileSync(path, lf.replaceAll('\n', '\r\n'));
  return { path, lf };
}

test('no file under templates/ in the working tree holds a carriage return', () => {
  assert.ok(names.length > 0);
  const crlf = names.filter((n) => readFileSync(join(TEMPLATES, n), 'utf8').includes('\r'));
  assert.deepEqual(crlf, []);
});

test('a bug skeleton from a CRLF template without bug-of or fix-repo has neither line, and LF endings', () => {
  const { path } = crlfCopy('bug.md');
  const text = skeleton({ id: 'shop/slow-cart', slug: 'slow-cart', title: 'Slow cart', written: '2026-11-16', session: 's-1', bugOf: null, fixRepo: null, quadDamage: 'no' }, path);
  assert.ok(!text.includes('\r'), 'no carriage return');
  assert.doesNotMatch(text, /^bug-of:/m);
  assert.doesNotMatch(text, /^fix-repo:/m);
  assert.match(text, /^id: shop\/slow-cart\n/m);
});

test('a bug skeleton from a CRLF template keeps the bug-of and fix-repo it names', () => {
  const { path } = crlfCopy('bug.md');
  const text = skeleton({ id: 'shop/slow-cart', slug: 'slow-cart', title: 'Slow cart', written: '2026-11-16', bugOf: 'shop/cart', fixRepo: 'web', quadDamage: 'no' }, path);
  assert.ok(!text.includes('\r'));
  assert.match(text, /^bug-of: shop\/cart\n/m);
  assert.match(text, /^fix-repo: web\n/m);
});

for (const name of names) {
  test(`readText reads a CRLF copy of templates/${name} as its LF text`, () => {
    const { path, lf } = crlfCopy(name);
    const text = readText(path);
    assert.ok(!text.includes('\r'));
    assert.equal(text, lf);
  });
}

test('readText leaves LF text as it is and takes a file URL', () => {
  const path = join(tempDir('kirunak-lf-'), 'a.md');
  writeFileSync(path, 'a\nb\n');
  assert.equal(readText(path), 'a\nb\n');
  assert.equal(readText(pathToFileURL(path)), 'a\nb\n');
});

// Every template kirunak reads goes through readText: no lib file reads a templates/ URL, or fillTemplate's
// `template`, with readFileSync.
test('no lib file reads a template with readFileSync', () => {
  const bad = [];
  for (const file of readdirSync(LIB).filter((n) => n.endsWith('.mjs'))) {
    const src = readFileSync(join(LIB, file), 'utf8');
    const consts = [...src.matchAll(/const (\w+) = new URL\('\.\.\/templates\//g)].map((m) => m[1]);
    for (const name of [...consts, ...(file === 'install.mjs' ? ['template'] : [])]) {
      if (new RegExp(`readFileSync\\([^)]*\\b${name}\\b`).test(src)) bad.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(bad, []);
});

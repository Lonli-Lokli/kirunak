import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

// `claude plugin marketplace add <checkout>` reads this list. An entry whose source is a path inside the checkout is
// run from the checkout's own folder, never from a copy, which is what the mod needs: it runs the checkout's bin/k.mjs
// (design/boards.md §4).
test('the marketplace lists every mod by a path inside the checkout, under the name its plugin.json gives', () => {
  const market = read('.claude-plugin/marketplace.json');
  const mods = readdirSync(join(ROOT, 'mods')).sort();
  assert.deepEqual(market.plugins.map((p) => p.source).sort(), mods.map((m) => `./mods/${m}`));
  for (const entry of market.plugins) {
    const manifest = read(join(entry.source, '.claude-plugin/plugin.json'));
    assert.equal(entry.name, manifest.name, `${entry.source}: listed as ${entry.name}`);
    assert.equal(entry.description, manifest.description, `${entry.source}: its description`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorkspace } from './helpers.mjs';
import { kirunakHome } from '../lib/home.mjs';
import { aspectsOf, loadWorkspaceModule } from '../lib/workspace.mjs';

const STORAGE = `{ repos() {}, queuePath() {}, read() {}, write() {}, exists() {}, hash() {}, commit() {}, head() {}, diff() {}, changedSince() {} }`;

// A workspace module in a temp folder with the given plugin sources.
async function load(plugins) {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-plugins-'));
  const names = Object.keys(plugins);
  for (const [name, src] of Object.entries(plugins)) writeFileSync(join(dir, name), src);
  writeFileSync(join(dir, 'ws.mjs'), `export default { repos: [{ name: 'weather', root: '.' }], queue: './queue.md', plugins: ${JSON.stringify(names.map((n) => './' + n))} };`);
  return loadWorkspaceModule(join(dir, 'ws.mjs'));
}

const plugin = (name, provides) => `export default { name: '${name}', version: '1', provides: ${provides} };`;

test('a workspace fixture loads', async () => {
  const { ws } = await makeWorkspace();
  assert.deepEqual(ws.repos.map((r) => r.name), ['weather', 'hub']);
  assert.equal(ws.seams.checklist.length, 1);
  assert.deepEqual((await aspectsOf(ws)).map((a) => a.id), ['platforms', 'large-text', 'offline']);
  assert.equal(typeof ws.seams.storage.commit, 'function');
  assert.equal(ws.seams.handoff.length, 1);
  assert.deepEqual(ws.machine, { maxAgents: 2, maxHeavy: 1 });
  assert.deepEqual(ws.budget, { calls: 100, minutes: 40, usd: 3 });
  assert.ok(ws.seams.loaded.some((l) => l.seam === 'storage' && /storage-git/.test(l.module)));
});

test('an unknown seam is refused by name', async () => {
  await assert.rejects(load({ 'p.mjs': plugin('p', '{ weather: { x() {} } }') }), /unknown seam: weather/);
});

test('a missing contract function is refused by name', async () => {
  await assert.rejects(load({ 'p.mjs': plugin('p', '{ handoff: { targets() {} } }') }), /seam handoff is missing the function release/);
});

test('two storage plugins are refused, naming both', async () => {
  await assert.rejects(
    load({ 'a.mjs': plugin('a', `{ storage: ${STORAGE} }`), 'b.mjs': plugin('b', `{ storage: ${STORAGE} }`) }),
    (e) => /takes one implementation/.test(e.message) && /a\.mjs/.test(e.message) && /b\.mjs/.test(e.message),
  );
});

test('one storage plugin replaces the default', async () => {
  const ws = await load({ 'a.mjs': plugin('a', `{ storage: ${STORAGE} }`) });
  assert.ok(ws.seams.loaded.some((l) => l.seam === 'storage' && /a\.mjs/.test(l.module)));
  assert.ok(!ws.seams.loaded.some((l) => /storage-git/.test(l.module)));
});

test('two checklist plugins merge in order', async () => {
  const ws = await load({
    'a.mjs': plugin('a', `{ checklist: { aspects: () => [{ id: 'one' }] } }`),
    'b.mjs': plugin('b', `{ checklist: { aspects: () => [{ id: 'two' }, { id: 'three' }] } }`),
  });
  assert.deepEqual((await aspectsOf(ws)).map((a) => a.id), ['one', 'two', 'three']);
});

test('two handoff plugins merge in order, after the core default', async () => {
  const ws = await load({
    'a.mjs': plugin('a', `{ handoff: { targets: () => [{ where: 'a' }], release: () => [] } }`),
    'b.mjs': plugin('b', `{ handoff: { targets: () => [{ where: 'b' }], release: () => [] } }`),
  });
  const mods = ws.seams.loaded.filter((l) => l.seam === 'handoff').map((l) => l.module);
  assert.equal(mods.length, 3);
  assert.match(mods[0], /handoff-notes/);
  assert.match(mods[1], /a\.mjs/);
  assert.match(mods[2], /b\.mjs/);
});

test('a plugin that throws on load stops with its name', async () => {
  await assert.rejects(load({ 'p.mjs': 'throw new Error("boom");' }), /p\.mjs failed to load: boom/);
});

test('KIRUNAK_HOME moves the pointer', () => {
  assert.equal(kirunakHome({ KIRUNAK_HOME: '/tmp/somewhere' }), '/tmp/somewhere');
  assert.match(kirunakHome({}), /\.kirunak$/);
});

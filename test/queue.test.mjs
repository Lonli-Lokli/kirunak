import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, sh } from './helpers.mjs';
import * as queue from '../lib/queue.mjs';

// The fixture plus three more draft tasks, so the queue has something to order.
async function setup() {
  const w = await makeWorkspace();
  for (const slug of ['a', 'b', 'c']) {
    const dir = join(w.weather, 'kirunak', 'tasks', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.md'), `---\nid: weather/${slug}\ntitle: ${slug}\ncreated: 2026-11-02\n---\n`);
  }
  return w;
}

const lastSubject = (repo) => sh(repo, 'git', ['log', '-1', '--format=%s']).trim();

test('add first, last, before and after', async () => {
  const { ws, hub } = await setup();
  queue.add(ws, 'weather/a');
  queue.add(ws, 'weather/b', { first: true });
  queue.add(ws, 'weather/c', { before: 'weather/a' });
  queue.add(ws, 'weather/offline-forecast', { after: 'weather/b' });
  assert.deepEqual(queue.read(ws), ['weather/b', 'weather/offline-forecast', 'weather/c', 'weather/a']);
  assert.equal(lastSubject(hub), 'kirunak: queue add weather/offline-forecast');
});

test('move and remove', async () => {
  const { ws, hub } = await setup();
  for (const id of ['weather/a', 'weather/b', 'weather/c']) queue.add(ws, id);
  queue.move(ws, 'weather/c', { first: true });
  assert.deepEqual(queue.read(ws), ['weather/c', 'weather/a', 'weather/b']);
  assert.equal(lastSubject(hub), 'kirunak: queue move weather/c');
  queue.move(ws, 'weather/c', { after: 'weather/b' });
  assert.deepEqual(queue.read(ws), ['weather/a', 'weather/b', 'weather/c']);
  queue.remove(ws, 'weather/a');
  assert.deepEqual(queue.read(ws), ['weather/b', 'weather/c']);
  assert.equal(lastSubject(hub), 'kirunak: queue remove weather/a');
});

test('a duplicate is refused', async () => {
  const { ws } = await setup();
  queue.add(ws, 'weather/a');
  assert.throws(() => queue.add(ws, 'weather/a'), /already in the queue/);
});

test('an unknown id is refused', async () => {
  const { ws } = await setup();
  assert.throws(() => queue.add(ws, 'weather/nope'), /unknown task weather\/nope/);
  assert.throws(() => queue.add(ws, 'elsewhere/a'), /unknown repo elsewhere/);
  assert.throws(() => queue.remove(ws, 'weather/a'), /not in the queue/);
  assert.throws(() => queue.move(ws, 'weather/a', { first: true }), /not in the queue/);
  queue.add(ws, 'weather/a');
  assert.throws(() => queue.add(ws, 'weather/b', { before: 'weather/c' }), /weather\/c is not in the queue/);
});

test('comment lines are kept', async () => {
  const { ws } = await setup();
  writeFileSync(ws.queue, '# The queue\n# second comment\n');
  queue.add(ws, 'weather/a');
  queue.add(ws, 'weather/b', { first: true });
  queue.remove(ws, 'weather/a');
  assert.equal(readFileSync(ws.queue, 'utf8'), '# The queue\n# second comment\nweather/b\n');
});

test('each change is one commit in the queue repo', async () => {
  const { ws, hub, weather } = await setup();
  const before = Number(sh(hub, 'git', ['rev-list', '--count', 'HEAD']).trim());
  const weatherBefore = sh(weather, 'git', ['rev-parse', 'HEAD']).trim();
  queue.add(ws, 'weather/a');
  queue.add(ws, 'weather/b');
  queue.move(ws, 'weather/b', { first: true });
  queue.remove(ws, 'weather/a');
  assert.equal(Number(sh(hub, 'git', ['rev-list', '--count', 'HEAD']).trim()), before + 4);
  assert.equal(sh(hub, 'git', ['status', '--porcelain']).trim(), '');
  assert.equal(sh(weather, 'git', ['rev-parse', 'HEAD']).trim(), weatherBefore);
});

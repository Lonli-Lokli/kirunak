import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { handoff, start } from '../lib/handoff.mjs';
import { loadWorkspaceModule } from '../lib/workspace.mjs';
import { WHAT } from '../plugins/handoff-notes.mjs';
import { makeWorkspace } from './helpers.mjs';

const ID = 'weather/offline-forecast';
const taskDir = (w) => join(realpathSync(w.weather), 'kirunak', 'tasks', 'offline-forecast');

// Every file under dir but the skipped folders, with its size, time and bytes.
function snapshot(dir, skip) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (skip.some((s) => realpathSync(p) === realpathSync(s))) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(dir, p)] = `${st.size} ${st.mtimeMs} ${readFileSync(p, 'base64')}`;
    }
  };
  walk(dir);
  return out;
}

test('the default targets the task handoff.md and clears the session file', async () => {
  const w = await makeWorkspace();
  const s = start({ ws: w.ws, id: ID, session: 'abc-123', now: new Date('2026-11-07T10:00:00Z') });
  const file = join(w.home, 'sessions', 'abc-123.json');
  assert.equal(s.path, file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { task: ID, step: null, since: '2026-11-07T10:00:00.000Z' });
  const out = await handoff({ ws: w.ws, id: ID, session: 'abc-123', cwd: w.weather });
  assert.deepEqual(out.targets, [{ where: join(taskDir(w), 'handoff.md'), what: WHAT }]);
  for (const words of ['state now', 'open', 'next step', 'decisions with their dates', 'where things', 'git already records']) {
    assert.ok(WHAT.includes(words), words);
  }
  assert.deepEqual(out.released, [{ resource: 'session', line: 'cleared session abc-123' }]);
  assert.ok(!existsSync(file));
  const again = await handoff({ ws: w.ws, id: ID, session: 'abc-123' });
  assert.deepEqual(again.released, [{ resource: 'kirunak', line: 'nothing held' }]);
});

test('the default guard: this session leaves its claims and queue lines, others keep theirs', async () => {
  const w = await makeWorkspace();
  const guard = join(w.home, 'guard');
  mkdirSync(guard, { recursive: true });
  writeFileSync(join(guard, 'claims.json'), JSON.stringify([
    { resource: 'phone-1', by: 's1', why: 'smoke run', until: '2026-11-07T12:00:00Z' },
    { resource: 'tablet', by: 's2', why: 'layout', until: '2026-11-07T12:00:00Z' },
  ]));
  writeFileSync(join(guard, 'queue'), '{"session":"s2","what":"hub build"}\n{"session":"s1","what":"weather unit tests"}\n');
  const out = await handoff({ ws: w.ws, id: ID, session: 's1' });
  assert.deepEqual(out.released, [
    { resource: 'phone-1', line: 'released claim phone-1' },
    { resource: 'guard queue', line: 'left the guard queue: {"session":"s1","what":"weather unit tests"}' },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(guard, 'claims.json'), 'utf8')).map((c) => c.by), ['s2']);
  assert.equal(readFileSync(join(guard, 'queue'), 'utf8'), '{"session":"s2","what":"hub build"}\n');
});

test('a workspace plugin is merged after the default, targets and releases in load order', async () => {
  const w = await makeWorkspace();
  writeFileSync(join(w.hub, 'kirunak', 'plugins', 'handoff-memory.mjs'), `export default () => ({
  name: 'weather-handoff', version: '1',
  provides: { handoff: {
    targets: ({ task, session }) => [{ where: 'the memory directory named in your system prompt', what: 'a line for ' + task.id + ' from ' + session }],
    release: ({ session }) => [{ resource: 'phone-1', line: 'released phone-1 held by ' + session }],
  } },
});
`);
  const modulePath = join(w.hub, 'kirunak', 'workspace-handoff.mjs');
  writeFileSync(modulePath, `export default {
  repos: [{ name: 'weather', root: '../../weather' }, { name: 'hub', root: '..' }],
  queue: './queue.md',
  plugins: ['./plugins/checklist.mjs', './plugins/handoff-memory.mjs'],
};
`);
  const ws = await loadWorkspaceModule(modulePath);
  start({ ws, id: ID, session: 's9' });
  const out = await handoff({ ws, id: ID, session: 's9' });
  assert.deepEqual(out.targets.map((t) => t.where), [join(taskDir(w), 'handoff.md'), 'the memory directory named in your system prompt']);
  assert.equal(out.targets[1].what, `a line for ${ID} from s9`);
  assert.deepEqual(out.released, [
    { resource: 'session', line: 'cleared session s9' },
    { resource: 'phone-1', line: 'released phone-1 held by s9' },
  ]);
});

test('nothing is written outside the task folder and $KIRUNAK_HOME', async () => {
  const w = await makeWorkspace();
  mkdirSync(join(w.home, 'guard'), { recursive: true });
  writeFileSync(join(w.home, 'guard', 'claims.json'), JSON.stringify([{ resource: 'phone-1', by: 's1' }]));
  const before = snapshot(w.root, [w.home, taskDir(w)]);
  start({ ws: w.ws, id: ID, session: 's1' });
  await handoff({ ws: w.ws, id: ID, session: 's1', cwd: w.weather });
  assert.deepEqual(snapshot(w.root, [w.home, taskDir(w)]), before);
});

test('an unknown task and a session id that is not one are refused', async () => {
  const w = await makeWorkspace();
  await assert.rejects(handoff({ ws: w.ws, id: 'weather/no-such-task', session: 's1' }), /unknown task weather\/no-such-task/);
  await assert.rejects(handoff({ ws: w.ws, id: 'nowhere/task', session: 's1' }), /unknown repo nowhere/);
  assert.throws(() => start({ ws: w.ws, id: 'weather/no-such-task', session: 's1' }), /unknown task/);
  assert.throws(() => start({ ws: w.ws, id: ID, session: '../../escape' }), /not a session id/);
  assert.throws(() => start({ ws: w.ws, id: ID }), /session id is needed/);
  await assert.rejects(handoff({ ws: w.ws, id: ID, session: '../x' }), /not a session id/);
});

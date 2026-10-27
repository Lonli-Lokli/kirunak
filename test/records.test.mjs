import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { commitsIn } from '../lib/git.mjs';
import { doneTasks, isRecord, kept, namesTask, recordPaths, tasksNamed, trailerTask } from '../lib/records.mjs';
import { loadWorkspaceModule } from '../lib/workspace.mjs';
import { makeWorkspace, sh } from './helpers.mjs';

const repos = ['gulnya', 'katyafm', 'kirunak'];
const inGulnya = { here: 'gulnya', repos };

test('a message names a task by its id, or in its own repo by its slug as a whole word (accept-shared-repo D-1)', () => {
  const names = (message, id = 'gulnya/kit-wanted', ctx = inGulnya) => namesTask(message, id, ctx);
  assert.equal(names('gulnya/kit-wanted S-3: the drone'), true);
  assert.equal(names('kit-wanted: the drone'), true);
  assert.equal(names('the drone moved out of kit-wanted.'), true);
  assert.equal(names('see kirunak/tasks/kit-wanted/notes.md'), true);
  assert.equal(names('(kit-wanted)'), true);
  // A longer word is another word.
  assert.equal(names('kit-wanted-again: a draft'), false);
  assert.equal(names('the old-kit-wanted list'), false);
  assert.equal(names('kit_wanted'), false);
  assert.equal(names('the kit: wanted'), false);
  // Another repo's task of the same slug is that repo's.
  assert.equal(names('katyafm/settings S-2', 'gulnya/settings'), false);
  assert.equal(names('katyafm/settings S-2, and settings here', 'gulnya/settings'), true);
  assert.equal(names('katyafm/settings S-2', 'katyafm/settings'), true);
  // In another repo, only the id names it.
  assert.equal(names('settings: the sheet', 'gulnya/settings', { here: 'katyafm', repos }), false);
  assert.equal(names('for gulnya/settings', 'gulnya/settings', { here: 'katyafm', repos }), true);
});

test('the Task: trailer names its task, and alone says which task a commit is (accept-shared-repo AC-3, AC-6)', () => {
  const ids = ['gulnya/kit-wanted', 'gulnya/hronka-pinned', 'katyafm/settings'];
  assert.equal(trailerTask('the drone\n\nSLAP: 3 (S)\nTask: gulnya/hronka-pinned\n'), 'gulnya/hronka-pinned');
  assert.equal(trailerTask('the drone\n\nTask: gulnya/a\nTask: gulnya/b'), 'gulnya/b');
  assert.equal(trailerTask('the Task: is not a trailer here'), null);
  assert.deepEqual(tasksNamed('kit-wanted and hronka-pinned\n\nTask: gulnya/hronka-pinned', ids, inGulnya), ['gulnya/hronka-pinned']);
  assert.deepEqual(tasksNamed('kit-wanted, then gulnya/hronka-pinned', ids, inGulnya), ['gulnya/kit-wanted', 'gulnya/hronka-pinned']);
  assert.deepEqual(tasksNamed('a typo', ids, inGulnya), []);
  assert.equal(namesTask('a typo\n\nTask: gulnya/kit-wanted', 'gulnya/kit-wanted', { here: 'katyafm', repos }), true);
});

test('kirunak\'s records are the task folders, the drafts, the bugs, the approvals and the queue file where the workspace keeps it, the drafts\' order beside it (accept-shared-repo AC-5)', async () => {
  const { ws } = await makeWorkspace();
  const records = recordPaths(ws);
  assert.deepEqual(records, ['kirunak/tasks/', 'kirunak/drafts/', 'kirunak/bugs/', 'kirunak/approvals/', 'kirunak/queue.md', 'kirunak/drafts-order.md']);
  for (const x of ['kirunak/tasks/a/notes.md', 'kirunak/drafts/b.md', 'kirunak/bugs/c.md', 'kirunak/bugs/c/review-1.md', 'kirunak/approvals/a.json', 'kirunak/queue.md', 'kirunak/drafts-order.md']) assert.equal(isRecord(x, records), true, x);
  for (const x of ['kirunak/workspace.mjs', 'kirunak/queue.md.bak', 'src/kirunak/tasks/a.ts', 'README.md']) assert.equal(isRecord(x, records), false, x);
  const outside = { ...ws, queue: join(ws.home, 'queue.md'), draftOrder: join(ws.home, 'drafts-order.md') };
  assert.deepEqual(recordPaths(outside), ['kirunak/tasks/', 'kirunak/drafts/', 'kirunak/bugs/', 'kirunak/approvals/']);
});

test('the workspace may name more records, a file or a folder in any of its repos, written yet or not; anything but a list of paths is refused (accept-shared-repo AC-5, D-3)', async () => {
  const { ws } = await makeWorkspace();
  const dir = dirname(ws.modulePath);
  const named = (file, records) => {
    writeFileSync(join(dir, file), readFileSync(ws.modulePath, 'utf8').replace("queue: './queue.md',", `queue: './queue.md',\n  records: ${JSON.stringify(records)},`));
    return loadWorkspaceModule(join(dir, file));
  };
  const records = recordPaths(await named('records.mjs', ['./plan.md', '../../weather/notes/', '~/elsewhere.md']));
  assert.deepEqual(records, ['kirunak/tasks/', 'kirunak/drafts/', 'kirunak/bugs/', 'kirunak/approvals/', 'kirunak/queue.md', 'kirunak/drafts-order.md', 'kirunak/plan.md', 'notes/']);
  for (const x of ['kirunak/plan.md', 'notes/a.md', 'notes/deep/b.md']) assert.equal(isRecord(x, records), true, x);
  for (const x of ['kirunak/plan.md.bak', 'notes', 'docs/notes/a.md', 'kirunak/workspace.mjs']) assert.equal(isRecord(x, records), false, x);
  for (const [file, bad] of [['one.mjs', './plan.md'], ['empty.mjs', ['']], ['number.mjs', [3]]]) {
    await assert.rejects(named(file, bad), /records must be a list of paths, a folder ending with a slash/);
  }
});

test('the text git keeps of a message follows its comment string and cleanup mode, as measured (accept-shared-repo AC-8; steps/S-11/design.md §2)', () => {
  const status = '# Please enter the commit message.\n#\tmodified: kirunak/tasks/kit-wanted/notes.md\n';
  const scissors = (c = '#') => `${c} ------------------------ >8 ------------------------\n`;
  const editor = { GIT_EDITOR: 'vi' };
  const none = { GIT_EDITOR: ':' };
  for (const [name, message, env, cfg, want] of [
    ['A: default, an editor', `msg\n# tag kit-wanted\n${status}`, editor, {}, 'msg'],
    ['B: whitespace, an editor', `msg\n# tag kit-wanted\n${status}`, editor, { cleanup: 'whitespace' }, `msg\n# tag kit-wanted\n${status}`],
    ['C: strip, -m', '#kit-wanted tag\n', none, { cleanup: 'strip' }, ''],
    ['C: default, -m', '#kit-wanted tag\n', none, {}, '#kit-wanted tag'],
    ['D: commentChar ;', 'msg\n# tag kit-wanted\n; note\n; modified: kirunak/tasks/kit-wanted/notes.md\n', editor, { comment: ';' }, 'msg\n# tag kit-wanted'],
    ['E: commentChar auto, read as #', 'typed\n#start\n; modified: kirunak/tasks/kit-wanted/notes.md\n', editor, { comment: 'auto' }, 'typed\n; modified: kirunak/tasks/kit-wanted/notes.md'],
    ['F: commentString //', 'msg\n# tag kit-wanted\n// note kit-wanted\n', editor, { comment: '//' }, 'msg\n# tag kit-wanted'],
    ['G: verbose, default', `msg\n${status}${scissors()}diff --git a/kit-wanted b/kit-wanted\n`, editor, {}, 'msg'],
    ['H: verbose, whitespace', `msg\n${status}${scissors()}diff --git a/kit-wanted b/kit-wanted\n`, editor, { cleanup: 'whitespace' }, `msg\n${status}`.trimEnd()],
    ['I: verbatim', `msg\n${status}`, editor, { cleanup: 'verbatim' }, `msg\n${status}`],
    ['J: scissors', `msg\n# kept kit-wanted\n${scissors()}${status}`, editor, { cleanup: 'scissors' }, 'msg\n# kept kit-wanted'],
    ['a comment string a pattern would read', `msg\n* note\n${scissors('*')}kit-wanted\n`, editor, { comment: '*' }, 'msg'],
  ]) {
    assert.equal(kept(message, env, cfg).trimEnd(), want.trimEnd(), name);
  }
  assert.equal(namesTask(kept(`the cache\n\n${status}${scissors()}diff --git a/kit-wanted b/kit-wanted\n`, editor), 'gulnya/kit-wanted', inGulnya), false);
});

test('the accepted tasks of a repo are its task folders holding a done.json that says its task (accept-shared-repo AC-8)', async () => {
  const { weather, hub } = await makeWorkspace();
  assert.deepEqual(doneTasks(weather), []);
  assert.deepEqual(doneTasks(join(hub, 'nowhere')), []);
  writeFileSync(join(weather, 'kirunak', 'tasks', 'offline-forecast', 'done.json'), JSON.stringify({ task: 'weather/offline-forecast' }));
  for (const [slug, text] of [['broken', '{'], ['unsaid', '{}'], ['wrong', JSON.stringify({ task: 'not an id' })]]) {
    mkdirSync(join(weather, 'kirunak', 'tasks', slug));
    writeFileSync(join(weather, 'kirunak', 'tasks', slug, 'done.json'), text);
  }
  assert.deepEqual(doneTasks(weather), ['weather/offline-forecast']);
});

test('commitsIn lists a range\'s commits newest first, each with its whole message and its own paths', async () => {
  const { weather } = await makeWorkspace();
  const base = sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim();
  mkdirSync(join(weather, 'src'), { recursive: true });
  writeFileSync(join(weather, 'src', 'a b.ts'), 'a\n');
  sh(weather, 'git', ['add', '-A']);
  sh(weather, 'git', ['commit', '-q', '-m', 'first\n\nits body\n\nTask: weather/x']);
  sh(weather, 'git', ['mv', 'src/a b.ts', 'src/c.ts']);
  sh(weather, 'git', ['commit', '-q', '-m', 'a rename']);
  sh(weather, 'git', ['commit', '-q', '--allow-empty', '-m', 'empty']);
  const got = commitsIn(weather, `${base}..HEAD`);
  assert.deepEqual(got.map((c) => [c.message.trim(), c.paths]), [
    ['empty', []],
    ['a rename', ['src/a b.ts', 'src/c.ts']],
    ['first\n\nits body\n\nTask: weather/x', ['src/a b.ts']],
  ]);
  assert.equal(got[0].sha, sh(weather, 'git', ['rev-parse', '--short', 'HEAD']).trim());
});

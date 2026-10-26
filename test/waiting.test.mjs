import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve } from '../lib/approval.mjs';
import { amendmentName, decline, newAmendment } from '../lib/amend.mjs';
import { generate } from '../lib/checklist.mjs';
import { newDraft } from '../lib/drafts.mjs';
import { draftsLine, stoppedFor, stoppedText } from '../lib/waiting.mjs';
import { gitCommitAll, k, makeWorkspace, reviewsRan, sh } from './helpers.mjs';

// What k waiting gives the mod's pick lists (kirunak-phone S-4): the amendments waiting, the tasks k hold and k start
// take, and each accept row's checklist.

for (const key of Object.keys(process.env)) if (key.startsWith('KIRUNAK_') && key !== 'KIRUNAK_HOME') delete process.env[key];

const ID = 'weather/offline-forecast';
const TITLE = 'The last forecast stays readable offline';
const NOV5 = new Date(2026, 10, 5, 9, 12, 0);
const NOV6 = new Date(2026, 10, 6, 10, 0, 0);
const dirOf = (weather, slug = 'offline-forecast') => join(weather, 'kirunak', 'tasks', slug);
const headOf = (repo) => sh(repo, 'git', ['rev-parse', '--short', 'HEAD']).trim();
const run = (home, args) => k(home, args, { CLAUDE_CODE_SESSION_ID: '' });
const waiting = (home) => JSON.parse(run(home, ['waiting', '--json']).stdout);

// The next amendment, written the way the model fills one.
function amendment(ws, why, changes, title = 'A change') {
  const a = newAmendment({ ws, id: ID, title, by: 'session s1', now: NOV6 });
  writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('## Why\n', `## Why\n${why}\n`).replace('## Changes\n', `## Changes\n${changes.join('\n')}\n`));
  return a.n;
}

test('k waiting lists the amendments neither applied nor declined, each by its name and with what k approve would refuse, one line each', async () => {
  const { ws, weather, home } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const src = '[research docs/offline.md §2]';
  amendment(ws, `Hourly data. ${src}`, [`- replace D-1: Keep the last three days, hourly for the first. ${src}`]);
  await approve({ ws, id: ID, amendment: 'A-1', now: NOV6 });
  amendment(ws, `A week. ${src}`, [`- replace D-1: Keep a week of forecasts. ${src}`]);
  decline({ ws, id: ID, amendment: 'A-2', why: 'three days is enough', now: NOV6 });
  amendment(ws, `The age line needs its words. The old one was a time alone. ${src}`, [
    `- replace E-1: A forecast older than a day says "yesterday" or "2 days ago". ${src}`,
    `- replace D-1: Keep the last three days, the first one hourly. ${src}`,
  ], 'Words for the age line');
  // Its result names a line it removes, which only k approve's check of the result finds.
  amendment(ws, `E-1 is covered by AC-1. ${src}`, ['- remove E-1'], 'Drop E-1');
  // One from before titles (kirunak-phone A-8): named by the lines it changes, and refused until it has a title.
  const a5 = amendment(ws, `Clearer words. ${src}`, [
    `- replace AC-2: The age line says how old the forecast is. ${src}`,
    `- replace AC-3: A restart keeps the last forecast. ${src}`,
    `- add AC-4: The age line is read aloud. ${src}`,
    '- remove O-1',
  ]);
  const a5File = join(dirOf(weather), 'amendments', `A-${a5}.md`);
  writeFileSync(a5File, readFileSync(a5File, 'utf8').replace('title: A change\n', ''));
  const task = readFileSync(join(dirOf(weather), 'task.md'));
  const head = headOf(weather);

  const w = waiting(home);
  assert.deepEqual(w.amendments.map((x) => x.amendment), ['A-3', 'A-4', 'A-5']);
  assert.deepEqual(w.amendments[0], {
    id: ID, amendment: 'A-3', title: TITLE, name: 'Words for the age line', proposed: '2026-11-06', by: 'session s1', why: 'The age line needs its words.', lines: 2, refuse: null,
    file: join(realpathSync(dirOf(weather)), 'amendments', 'A-3.md'),
  });
  // The mod reads the file whole for `/k-amendments <n>`, from wherever its session runs.
  assert.match(readFileSync(w.amendments[0].file, 'utf8'), /^## Why\nThe age line needs its words\. The old one was a time alone\./m);
  const refused = w.amendments[1];
  assert.deepEqual([refused.why, refused.lines], ['E-1 is covered by AC-1.', 1]);
  assert.match(refused.refuse, new RegExp(`^${ID} with A-4 applied fails k check: line \\d+: aspect offline: .*E-1`));
  assert.doesNotMatch(refused.refuse, /\n/);
  const untitled = w.amendments[2];
  assert.deepEqual([untitled.title, untitled.name, untitled.lines], [TITLE, 'replaces AC-2, AC-3; adds AC-4; removes O-1', 4]);
  assert.equal(untitled.refuse, `${ID} A-5 does not apply: line 1: front matter has no title: add \`title: <a few words>\` to its front matter, the name it goes by in every list`);

  // k approve --dry-run says the same, and neither writes anything.
  const dry = run(home, ['approve', ID, '--amendment', 'A-4', '--dry-run']);
  assert.deepEqual([dry.status, dry.stderr], [1, `would refuse ${ID}:\n  ${refused.refuse}\n`]);
  assert.equal(run(home, ['approve', ID, '--amendment', 'A-3', '--dry-run']).stdout, `would approve ${ID} with A-3\n`);
  assert.deepEqual([readFileSync(join(dirOf(weather), 'task.md')), headOf(weather)], [task, head]);
  assert.doesNotMatch(readFileSync(join(dirOf(weather), 'amendments', 'A-3.md'), 'utf8'), /applied:/);

  const text = run(home, ['waiting']).stdout;
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['nothing to approve', 'amendments to approve:', `  ${ID} A-3: Words for the age line  2 lines, can approve`]);
  assert.match(lines[3], new RegExp(`^ {2}${ID} A-4: Drop E-1 {2}1 line, not yet: with A-4 applied fails k check: .+…$`));
  assert.match(lines[4], new RegExp(`^ {2}${ID} A-5: replaces AC-2, AC-3; adds AC-4; removes O-1 {2}4 lines, not yet: does not apply: .+…$`));
  assert.deepEqual(lines.slice(5), ['nothing to accept', "no draft waits for the owner's intake", '']);
  // At most about 60 characters after the task id, besides the name.
  w.amendments.forEach((x, i) => assert.ok(lines[i + 2].length - `: ${x.name}`.length - `  ${ID}`.length <= 60, lines[i + 2]));

});

test("an amendment's name is its title, else the lines it changes by verb, each id once, else that it changes nothing yet (kirunak-phone A-8)", () => {
  const front = (title) => `---\ntask: ${ID}\nproposed: 2026-11-06\n${title}by: s\n---\n\n## Why\nx\n\n## Changes\n`;
  const ops = '- remove E-1\n- replace AC-5: a [owner 2026-11-06 Q-1]\n- add AC-17: b [owner 2026-11-06 Q-1]\n- replace AC-5: c [owner 2026-11-06 Q-1]\n';
  assert.equal(amendmentName(front('title: Short lists\n') + ops), 'Short lists');
  assert.equal(amendmentName(front('') + ops), 'replaces AC-5; adds AC-17; removes E-1');
  assert.equal(amendmentName(front('title: \n') + '- replace offline: in (AC-1) [owner 2026-11-06 Q-1]\n'), 'replaces offline');
  assert.equal(amendmentName(front('')), 'changes nothing yet');
});

test('k waiting offers k hold and k start the tasks k list shows, never a done or held one; k hold --dry-run checks', async () => {
  const { ws, weather, home } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  const copy = (slug, files = {}) => {
    cpSync(dirOf(weather), dirOf(weather, slug), { recursive: true });
    const t = join(dirOf(weather, slug), 'task.md');
    writeFileSync(t, readFileSync(t, 'utf8').replace(`id: ${ID}`, `id: weather/${slug}`));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dirOf(weather, slug), name), text);
  };
  copy('done-task', { 'done.json': JSON.stringify({ task: 'weather/done-task', accepted: '2026-11-01', by: 'owner' }) });
  copy('held-task', { 'hold.md': '# On hold: weather/held-task\n\nHeld 2026-11-02: later\n' });
  copy('hourly-chart');
  gitCommitAll(weather, 'more tasks');

  const w = waiting(home);
  const listed = JSON.parse(run(home, ['list', '--json']).stdout).rows.map(({ id, title, state }) => ({ id, title, state }));
  assert.deepEqual(listed.map((x) => x.id), [ID, 'weather/hourly-chart']);
  assert.equal(listed[0].state, 'queued');
  assert.deepEqual(w.hold, listed);
  assert.deepEqual(w.start, listed);

  assert.deepEqual([run(home, ['hold', 'weather/done-task', '--dry-run']).stderr, run(home, ['hold', 'weather/held-task', '--dry-run']).stderr], [
    'k: weather/done-task is done\n', 'k: weather/held-task is already on hold\n',
  ]);
  assert.equal(run(home, ['hold', 'weather/hourly-chart', '--dry-run']).stdout, 'would hold weather/hourly-chart\n');
  assert.equal(existsSync(join(dirOf(weather, 'hourly-chart'), 'hold.md')), false);
});

// A review at the given head: AC-3 for a device and E-1 for the owner, so the checklist has two items.
const REVIEW = (head) => `---
task: ${ID}
head: ${head}
---

| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | file docs/offline.md:1 |
| AC-2 | met | file docs/offline.md:1 |
| AC-3 | needs device | On a phone: restart offline |
| E-1 | needs owner | Read: the age line |

verdict: needs owner (AC-3, E-1)
`;

test('an accept row counts its open checklist items, and onlyChecklist says when they are all k accept refuses', async () => {
  const { ws, weather, home } = await makeWorkspace();
  await approve({ ws, id: ID, now: NOV5 });
  writeFileSync(join(dirOf(weather), 'review.md'), REVIEW(headOf(weather)));
  reviewsRan(dirOf(weather));
  generate(ws, ID);
  gitCommitAll(weather, 'review and checklist');
  const row = () => {
    const [r] = waiting(home).accept;
    return [r.why?.split('\n')[0] ?? null, r.checklistOpen, r.onlyChecklist];
  };
  assert.deepEqual(row(), [`${ID}: checklist.md has 2 unticked item(s):`, 2, true]);

  // The task's own work after the review is a second block: the items are still counted, but they are not all that
  // stops it.
  writeFileSync(join(weather, 'fix.ts'), 'export {};\n');
  gitCommitAll(weather, `a fix after the review (${ID})`);
  const [why, open, only] = row();
  assert.match(why, /its work changed after review\.md's head .*, in 1 file\(s\) the review never saw/);
  assert.deepEqual([open, only], [2, false]);

  // A new review over the fix, its checklist ticked.
  writeFileSync(join(dirOf(weather), 'review-2.md'), REVIEW(headOf(weather)));
  reviewsRan(dirOf(weather), ['review.md', 'review-2.md']);
  generate(ws, ID);
  const file = join(dirOf(weather), 'checklist.md');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('- [ ]', '- [x]'));
  gitCommitAll(weather, 'the second review, the checklist ticked');
  assert.deepEqual(row(), [null, 0, false]);
});

test("k waiting says in one line how many drafts wait for the owner's intake and names /k-drafts; --json gains drafts, every other field kept (kirunak-drafts AC-8)", async () => {
  const { ws, home } = await makeWorkspace();
  const keys = ['approve', 'accept', 'amendments', 'hold', 'start', 'drafts', 'stopped'];
  let w = waiting(home);
  assert.deepEqual(Object.keys(w), keys);
  assert.deepEqual(w.drafts, { count: 0, ids: [] });
  assert.deepEqual(run(home, ['waiting']).stdout.split('\n').slice(-3), ['nothing to accept', "no draft waits for the owner's intake", '']);

  newDraft({ ws, id: 'weather/wind-alerts', title: 'Wind alerts for cyclists', now: NOV5 });
  newDraft({ ws, id: 'hub/new-queue', title: 'A new queue', now: NOV6 });
  w = waiting(home);
  assert.deepEqual(Object.keys(w), keys);
  assert.deepEqual(w.drafts, { count: 2, ids: ['weather/wind-alerts', 'hub/new-queue'] });
  const text = run(home, ['waiting']).stdout.split('\n');
  assert.deepEqual(text.slice(-3), ['nothing to accept', "2 drafts wait for the owner's intake: /k-drafts", '']);
  assert.equal(draftsLine({ count: 1 }), "1 draft waits for the owner's intake: /k-drafts");
});

test('k waiting\'s group Stopped for you: per stopped step of a task not done, its notice indented two spaces, each line within 80 characters, the title and id first (design/orchestrator.md §2, E-15)', () => {
  const stop = { step: 'S-4', kind: 'escalated', what: 'stopped, failed on every rung', why: 'missing outputs: steps/S-4/report.md', dir: 'kirunak/tasks/offline-forecast/steps/S-4/', reports: ['steps/S-4/failure-1.md', 'steps/S-4/failure-2.md', 'steps/S-4/failure-3.md', 'steps/S-4/failure-4.md'] };
  const rows = [
    { id: 'weather/offline-forecast', title: 'The last forecast stays readable offline', state: 'in progress', stops: [stop] },
    { id: 'weather/old', title: 'Old', state: 'done', stops: [stop] },
    { id: 'weather/fine', title: 'Fine', state: 'queued', stops: [] },
  ];
  const stopped = stoppedFor(rows);
  assert.deepEqual(stopped.map((x) => [x.id, x.step, x.kind]), [['weather/offline-forecast', 'S-4', 'escalated']]);
  const text = stoppedText(stopped).split('\n');
  assert.deepEqual(text, [
    'stopped for you:',
    '  The last forecast stays readable offline (weather/offline-forecast)',
    '  S-4 stopped, failed on every rung: missing outputs: steps/S-4/report.md',
    '  read kirunak/tasks/offline-forecast/steps/S-4/ (failure-1.md … failure-4.md)',
  ]);
  assert.ok(text.every((l) => l.length <= 80));
  assert.ok(stopped[0].one.length <= 200);
});

test("k waiting's line for a question of a step started by hand sends the owner to the session that started it, not to k run (design/orchestrator.md §2, AC-23)", () => {
  const stop = { step: 'S-2', kind: 'owner', what: 'waits for your answer', why: 'Three days or a week?', dir: 'kirunak/tasks/offline-forecast/steps/S-2/', reports: [], byHand: true };
  const text = stoppedText(stoppedFor([{ id: 'weather/offline-forecast', title: 'The last forecast stays readable offline', state: 'in progress', stops: [stop] }])).split('\n');
  assert.deepEqual(text, [
    'stopped for you:',
    '  The last forecast stays readable offline (weather/offline-forecast)',
    '  S-2 waits for your answer: Three days or a week?',
    '  answer in the session that started it, or in notes.md',
  ]);
  assert.ok(text.every((l) => l.length <= 80));
});

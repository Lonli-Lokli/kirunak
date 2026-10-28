// k usage (gulnya/k-usage S-1): the limit week from the workspace's usage.weekStart, every file the weekly review
// reads written from invented transcripts (never this machine's), a transcript cut short or unreadable skipped and
// counted (E-1), and the review's own checks moved from gulnya's quality.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { k, makeWorkspace } from './helpers.mjs';
import { loadWorkspace } from '../lib/workspace.mjs';
import { DEFAULT_USAGE, lastWeek, weekTo, windowOf, zoned } from '../lib/usage/week.mjs';
import { scanCalls } from '../lib/usage/calls.mjs';
import { findingsOf, isFix, rootsOf } from '../lib/usage/tasks.mjs';
import { summarise } from '../lib/usage/compactlog.mjs';
import { baselineLabel } from '../lib/usage/quality.mjs';

const LONDON = { day: 'sunday', time: '15:00', zone: 'Europe/London' };
const HOUR = 3_600_000;
const hours = ({ from, to }) => (Date.parse(to) - Date.parse(from)) / HOUR;

test('the limit week across the London clock change: Sunday 15:00 BST to Sunday 15:00 GMT, 169 hours', () => {
  const w = windowOf(LONDON, {}, Date.parse('2026-10-28T12:00:00Z'));
  assert.deepEqual(w, { from: '2026-10-18T14:00:00.000Z', to: '2026-10-25T15:00:00.000Z' });
  assert.equal(hours(w), 169);
  // --to alone is the week ending then; both given are taken as they are, in any ISO form.
  assert.deepEqual(windowOf(LONDON, { to: '2026-10-25T15:00:00Z' }), w);
  assert.deepEqual(windowOf(LONDON, { from: '2026-10-18T14:00:00Z', to: '2026-10-25T16:00:00+01:00' }), w);
  // The spring change takes an hour away.
  assert.equal(hours(windowOf(LONDON, { to: '2027-03-28T14:00:00Z' })), 167);
  assert.equal(zoned('2026-10-25', '01:30', 'Europe/London'), Date.parse('2026-10-25T00:30:00Z'), 'a time passed twice is the first');
});

test('the default week is the last one finished at now, its start the workspace\'s', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.deepEqual(windowOf(DEFAULT_USAGE.weekStart, {}, now), { from: '2026-10-18T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' });
  // At the reset itself the week that ends then is finished; a minute before, the week before is the last.
  assert.equal(lastWeek(LONDON, Date.parse('2026-10-25T15:00:00Z')).to, '2026-10-25T15:00:00.000Z');
  assert.equal(lastWeek(LONDON, Date.parse('2026-10-25T14:59:00Z')).to, '2026-10-18T14:00:00.000Z');
  assert.equal(weekTo({ day: 'monday', time: '09:30', zone: 'UTC' }, '2026-10-26T09:30:00Z'), '2026-10-19T09:30:00.000Z');
  // --from alone runs to the last week start.
  assert.deepEqual(windowOf(LONDON, { from: '2026-10-20T00:00:00Z' }, now), { from: '2026-10-20T00:00:00.000Z', to: '2026-10-25T15:00:00.000Z' });
  assert.throws(() => windowOf(LONDON, { from: 'last week' }), /--from must be an instant/);
  assert.throws(() => windowOf(LONDON, { from: '2026-10-25T15:00:00Z', to: '2026-10-25T15:00:00Z' }), /is not before/);
});

// A workspace module beside the fixture's own, with a usage block (or none) and bugs.limitsLog.
async function withUsage(t, usage, bugs) {
  const w = await makeWorkspace();
  const module = join(w.hub, 'kirunak', 'workspace-usage.mjs');
  writeFileSync(module, `export default {
  repos: [{ name: 'weather', root: '../../weather' }, { name: 'hub', root: '..' }],
  queue: './queue.md',
  plugins: ['./plugins/checklist.mjs'],
${usage === undefined ? '' : `  usage: ${JSON.stringify(usage)},\n`}${bugs === undefined ? '' : `  bugs: ${JSON.stringify(bugs)},\n`}};
`);
  writeFileSync(join(w.home, 'workspace'), `${module}\n`);
  return { ...w, module };
}

test('the workspace\'s usage block: kirunak\'s defaults, the limits log from bugs.limitsLog, a bad week start refused', async (t) => {
  const w = await withUsage(t);
  const ws = await loadWorkspace(join(w.home, 'workspace'));
  assert.deepEqual(ws.usage, {
    weekStart: { day: 'sunday', time: '00:00', zone: 'UTC' }, reviews: null, baseline: null,
    limitsLog: join(w.home, 'rate-limits.log'), stale: { minutes: 60, context: 150000 },
  });
  const w2 = await withUsage(t, { weekStart: { time: '15:00', zone: 'Europe/London' }, reviews: './reviews', stale: { minutes: 30 } }, { limitsLog: './limits.log' });
  const ws2 = await loadWorkspace(join(w2.home, 'workspace'));
  assert.deepEqual(ws2.usage.weekStart, LONDON);
  assert.deepEqual(ws2.usage.stale, { minutes: 30, context: 150000 });
  assert.equal(ws2.usage.reviews, join(w2.hub, 'kirunak', 'reviews'));
  assert.equal(ws2.usage.limitsLog, join(w2.hub, 'kirunak', 'limits.log'));
  const w3 = await withUsage(t, { limitsLog: '/x/own.log' }, { limitsLog: './limits.log' });
  assert.equal((await loadWorkspace(join(w3.home, 'workspace'))).usage.limitsLog, '/x/own.log');
  const w4 = await withUsage(t, { weekStart: { day: 'Sun', zone: 'Mars/Olympus' } });
  await assert.rejects(loadWorkspace(join(w4.home, 'workspace')), (e) => /usage\.weekStart\.day must be one of/.test(e.message) && /usage\.weekStart\.zone/.test(e.message));
});

// Invented transcripts: a main session and its agent in the weather repo's project folder, one cut short, one whose
// first line is not JSON, one that is a folder, and (when this user cannot read past it) one nobody may read.
test('findings: a task review\'s verdicts and Findings bullets, a Fable review\'s B, S and N', () => {
  const text = ['| id | verdict | evidence |', '| AC-1 | met | x |', '| AC-2 | not met | y |', '| E-3 | needs owner | z |',
    '## Findings', '- AC-2: one', '- E-3: two', '## Notes for later', '- not a finding',
    '## Blocker', '**B-1.** a', '### S-2 should fix', '**N-3.** a note', 'see **B-1.** inside a line'].join('\n');
  assert.deepEqual(findingsOf(text), { notMet: 1, needsOwner: 1, findings: 2, B: 1, S: 1, N: 1 });
});

test('a fix commit names the task and changes more than its records', () => {
  const t = { id: 'gulnya/kit-wanted', slug: 'kit-wanted', root: 'gulnya' };
  const c = (subject, files, root = 'gulnya') => ({ subject, files, root });
  assert.equal(isFix(t, c('music: the drone (kit-wanted S-18)', ['music/a.kt'])), true);
  assert.equal(isFix(t, c('music: the drone (kit-wanted S-18)', ['music/a.kt'], 'katyafm')), false);
  assert.equal(isFix(t, c('tools: x (gulnya/kit-wanted S-2)', ['tools/x.mjs'], 'kirunak')), true);
  assert.equal(isFix(t, c('kirunak: gulnya/kit-wanted S-3 done', ['kirunak/tasks/kit-wanted/progress.md', 'kirunak/queue.md'])), false);
  assert.equal(isFix(t, c('x (gulnya/kit-wanted-two S-1)', ['x'])), false);
  assert.equal(isFix(t, c('Merge gulnya/kit-wanted', [])), false);
});

test('compact.log: lets through per why, blocks, agents, the user\'s window, held spells and missed boundaries', () => {
  const m = (min) => new Date(Date.UTC(2026, 9, 26, 10, min)).toISOString(), at = (min) => Date.parse(m(min));
  // The handover's repos: one checkout, gulnya, and its worktrees beside it (gulnya-themes).
  const roots = rootsOf({ repos: [{ name: 'gulnya', root: '/home/me/src/gulnya' }], compact: { alsoIn: [] } });
  const repo = '/home/me/src/gulnya-themes', A = 'aaaaaaaa-0000-0000-0000-000000000000';
  assert.equal(roots.inRoots(repo), true);
  assert.equal(roots.inRoots('/private/tmp/x'), false);
  const lines = [
    { ts: m(1), session: A, cwd: repo, decision: 'block', row: 'R4.8', why: 'running' },
    { ts: m(2), session: A, cwd: repo, decision: 'allow', row: 'R4.5', why: 'agent past threshold' },
    { ts: m(3), session: A, cwd: repo, decision: 'block', row: 'R4.8', why: 'running' },
    { ts: m(20), session: A, cwd: repo, decision: 'allow', row: 'R4.9', why: 'boundary' },
    { ts: m(21), event: 'SessionStart', session: A, source: 'compact', put: true, why: 'boundary' },
    { ts: m(22), session: 'b', cwd: '/private/tmp/x', decision: 'allow', row: 'R4.3a', why: "user's window" },
  ];
  // S-1 finishes at minute 5 and S-2 starts at 10: nothing let through in between, so one boundary missed.
  const steps = [{ start: at(0), end: at(6), finished: at(5) }, { start: at(10), end: at(31), finished: at(30) }];
  const out = summarise(lines, (s) => (s === A ? steps : []), roots.inRoots).join('\n');
  assert.match(out, /fires 5: let through 3 \(.*boundary 1.*\); blocked 2 \(running 2\)/);
  assert.match(out, /put down to an agent 1 in 1 sessions/);
  assert.match(out, /user's window 1, inside the handover's repos 0 \(expected 0\); outside the repos 1 fires, blocked 0/);
  assert.match(out, /1 spells in 1 sessions, 2 blocks; ended by boundary 1; boundaries inside them 1, with no compaction before the next step started 1/);
  assert.match(out, /SessionStart compact: put back 1 of 1 \(boundary 1;/);
});

test('the baseline\'s week is read from its header: the Monday on or after its first instant', () => {
  assert.equal(baselineLabel('# generated by weekly.mjs 2026-10-18T14:00:00.000Z 2026-10-25T15:00:00.000Z (x)\ntask\tn\n'), 'week of 2026-10-19');
  assert.equal(baselineLabel('# generated by k usage --from 2026-10-26T00:00:00.000Z --to 2026-11-02T00:00:00.000Z\n'), 'week of 2026-10-26');
  assert.equal(baselineLabel('task\tn\n'), 'baseline');
});

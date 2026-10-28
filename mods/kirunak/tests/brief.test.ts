import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Brief } from '../hooks/picks'
import type { KirunakRow } from '../types'

import type { DraftRow } from '../hooks/drafts'
import { BRIEF, briefOf, bugCardOf, cardOf, DRAFTS, draftCardOf, ID, NO_FIX, READY, ROWS, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
const BRIDGE: PromptOrigin = { kind: 'bridge' }
const json = (brief: Brief) => ({ exitCode: 0, stdout: JSON.stringify(brief), stderr: '' })
const row = (id: string): KirunakRow => ROWS.find(r => r.id === id) as KirunakRow
// k's arguments after `node <k>`.
const args = (argv: string[][]) => argv.map(a => a.slice(2))

// BRIEF's lines as the chat answer draws them: each its own line, a blank line between the groups.
const CHAT = [
  'Made at 2026-11-07 12:00.',
  '',
  'Working on now (1)  ',
  `${ID}: in review, queue 1, S-2 done, 1 of 3 met, 1 not met, 1 needs a device`,
  '',
  'Proposed (1)  ',
  'hub/proposed: proposed',
  '',
  'Queued (1)  ',
  'hub/sync-notes: queued, queue 2',
  '',
  'Reviewed (1)  ',
  'weather/was-reviewed: reviewed',
  '',
  'Awaiting owner (1)  ',
  'weather/asks-owner: awaiting owner',
  '',
  'Done this week (1)  ',
  'hub/old: done',
  '',
  'Lock: weather unit tests (session s1, since 2026-11-07 11:50), 1 heavy job waiting, 1 of 2 steps running, no device claims.',
].join('\n')

// Eleven tasks in three groups: five worked on now, four queued, two done this week; each with a card.
const task = (id: string, state: string, queue: number | null): KirunakRow => ({ ...(ROWS[1] as KirunakRow), id, title: `Task ${id}`, state, queue })
const WORKING = [1, 2, 3, 4, 5].map(i => task(`hub/w${i}`, 'in progress', i))
const QUEUED = [1, 2, 3, 4].map(i => task(`hub/q${i}`, 'queued', 5 + i))
const DONE = [1, 2].map(i => task(`hub/d${i}`, 'done', null))
const ELEVEN = [...WORKING, ...QUEUED, ...DONE]
const BRIEF11 = briefOf(
  [
    { name: 'Working on now', lines: WORKING.map(r => `${r.id}: in progress, queue ${r.queue}, S-1 running, 0 of 2 met`) },
    { name: 'Queued', lines: QUEUED.map(r => `${r.id}: queued, queue ${r.queue}, 0 of 2 met`) },
    { name: 'Done this week', lines: DONE.map(r => `${r.id}: done, 2 of 2 met`) },
  ],
  'No lock, no heavy jobs waiting, 2 of 2 steps running, no device claims.',
)
const card11 = (id: string): string => cardOf(ELEVEN.find(r => r.id === id) as KirunakRow).trimEnd()

// The first dialog for the eleven, word for word: each group's count is its choice's line (gulnya/mobile-dialogs AC-23).
const GROUPS11 = {
  header: 'Board',
  question: ['Made at 2026-11-07 12:00.', '', 'No lock, no heavy jobs waiting, 2 of 2 steps running, no device claims.', 'Which group?'].join('\n'),
  labels: ['Working on now', 'Queued', 'Done this week'],
}
const GROUP_LINES11 = { 'Working on now': '5 tasks', Queued: '4 tasks', 'Done this week': '2 tasks' }

// A group's entries of the brief board, each its choice's line by its id, and the one line its dialog asks: the
// group's name and count, then the question (AC-23).
const group = (brief: Brief, name: string): { head: string; lines: Record<string, string> } => {
  const g = brief.groups.find(x => x.name === name) as Brief['groups'][number]
  return { head: `${name} (${g.count})`, lines: Object.fromEntries(g.ids.map(id => [id, (g.lines.find(l => l.startsWith(`${id}: `)) as string).slice(id.length + 2)])) }
}
// The lines of the choices offered, by label, as the dialog gave them.
const pick = (lines: Record<string, string> | undefined, labels: readonly string[]): Record<string, string | undefined> => Object.fromEntries(labels.map(l => [l, lines?.[l]]))
const OWN = { More: 'the next ones', Back: 'the dialog before', Cancel: 'nothing runs' }

describe('/k-board in steps: the groups, then a group\'s tasks (kirunak-phone A-9, AC-5)', () => {
  test('the first dialog says when the board was made, each group with its count and the machine\'s line; its choices are the groups', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: [SKIP] })
    await run($, 'k-board')
    expect(w.asked).toEqual([GROUPS11])
    expect(w.lines).toEqual([GROUP_LINES11])
  })

  test('a group picked shows its tasks, one entry each, its paragraph of the brief board; a task tapped answers with its card, and no verb runs', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: ['Done this week', 'hub/d2'] })
    expect(await run($, 'k-board')).toBe(card11('hub/d2'))
    expect(w.asked).toEqual([
      GROUPS11,
      { header: 'Board', question: 'Done this week (2): Which task\'s card?', labels: ['hub/d1', 'hub/d2', 'Back'] },
    ])
    expect(w.lines[1]).toEqual({ 'hub/d1': 'done, 2 of 2 met', 'hub/d2': 'done, 2 of 2 met', Back: OWN.Back })
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/d2']])
    expect(w.runs).toEqual([])
  })

  test('the group Drafts (kirunak-drafts S-4) asks "Which draft?", every other group for a task\'s card; a draft tapped answers with its card', async ($, on) => {
    const lines = DRAFTS.slice(0, 2).map(d => `${d.id}: ${d.title}, written ${d.written}`)
    const brief = briefOf([{ name: 'Queued', lines: ['hub/sync-notes: queued, queue 2'] }, { name: 'Drafts', lines }])
    const w = world(on, { brief: json(brief), taps: ['Drafts', 'hub/offline-maps', 'Queued', SKIP] })
    expect(await run($, 'k-board')).toBe(draftCardOf(DRAFTS[0] as DraftRow).trimEnd())
    await run($, 'k-board')
    expect(w.asked[1]).toEqual({ header: 'Board', question: 'Drafts (2): Which draft?', labels: ['hub/offline-maps', 'weather/rain-alerts', 'Back'] })
    expect(w.lines[1]).toEqual({ ...Object.fromEntries(DRAFTS.slice(0, 2).map(d => [d.id, `${d.title}, written ${d.written}`])), Back: OWN.Back })
    expect(w.lines[0]).toEqual({ Queued: '1 task', Drafts: '2 drafts' })
    expect(w.asked[3]?.question).toBe('Queued (1): Which task\'s card?')
    expect(w.lines[3]).toEqual({ 'hub/sync-notes': 'queued, queue 2', Back: OWN.Back })
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/offline-maps'], ['board', '--brief', '--json']])
    expect(w.runs).toEqual([])
  })

  test('the group Bugs (kirunak-bugs S-5) asks "Which bug?", never for a task\'s card; a bug tapped answers with its card', async ($, on) => {
    // As k board gives the group: k waiting's line for the bugs first, then a line a bug, its ids the bugs' alone.
    const entries = [`${READY.id}: ${READY.title}, fix ready`, `${NO_FIX.id}: ${NO_FIX.title}, no fix yet`]
    const lines = ['2 bugs, 1 with a fix ready: /k-bugs', ...entries]
    const made = briefOf([{ name: 'Queued', lines: ['hub/sync-notes: queued, queue 2'] }, { name: 'Bugs', lines: entries }])
    const brief = { ...made, groups: made.groups.map(g => (g.name === 'Bugs' ? { ...g, lines } : g)) }
    const w = world(on, { brief: json(brief), taps: ['Bugs', 'hub/stale-tiles'] })
    expect(await run($, 'k-board')).toBe(bugCardOf(READY).trimEnd())
    // k waiting's line names no choice, so it stays above the question; each bug's entry is its choice's line.
    expect(w.asked[1]).toEqual({ header: 'Board', question: `${lines[0]}\nBugs (2): Which bug?`, labels: ['hub/stale-tiles', 'hub/no-fix', 'Back'] })
    expect(w.lines[1]).toEqual({ [READY.id]: `${READY.title}, fix ready`, [NO_FIX.id]: `${NO_FIX.title}, no fix yet`, Back: OWN.Back })
    expect(w.lines[0]).toEqual({ Queued: '1 task', Bugs: '2 bugs' })
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/stale-tiles']])
    expect(w.runs).toEqual([])
  })

  test('Back returns to the groups, from any group (E-5)', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: ['Queued', 'Back', 'Working on now', 'Back', 'Done this week', 'hub/d1'] })
    expect(await run($, 'k-board')).toBe(card11('hub/d1'))
    expect(w.asked.map(a => a.labels)).toEqual([GROUPS11.labels, ['hub/q1', 'hub/q2', 'More', 'Back'], GROUPS11.labels, ['hub/w1', 'hub/w2', 'More', 'Back'], GROUPS11.labels, ['hub/d1', 'hub/d2', 'Back']])
    expect([w.asked[2], w.asked[4]]).toEqual([GROUPS11, GROUPS11])
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/d1']])
  })

  test('a group of more than three tasks pages them beside Back, with More, its text whole above every page; Back shows the page before (E-1, E-5)', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: ['Working on now', 'More', 'Back', 'More', 'hub/w4', 'Queued', 'More', 'hub/q3'] })
    expect(await run($, 'k-board')).toBe(card11('hub/w4'))
    expect(await run($, 'k-board')).toBe(card11('hub/q3'))
    const pages = (name: string, n: number, all: readonly (readonly [string, readonly string[]])[]) =>
      all.map(([range, labels]) => ({ header: 'Board', question: `${group(BRIEF11, name).head}: Which task's card (${range} of ${n})?`, labels }))
    const [w1, w2] = pages('Working on now', 5, [['1 to 2', ['hub/w1', 'hub/w2', 'More', 'Back']], ['3 to 5', ['hub/w3', 'hub/w4', 'hub/w5', 'Back']]])
    const [q1, q2] = pages('Queued', 4, [['1 to 2', ['hub/q1', 'hub/q2', 'More', 'Back']], ['3 to 4', ['hub/q3', 'hub/q4', 'Back']]])
    expect(w.asked).toEqual([GROUPS11, w1, w2, w1, w2, GROUPS11, q1, q2])
    // Each page's tasks have their entries as their lines, page by page.
    const own = { ...group(BRIEF11, 'Working on now').lines, ...group(BRIEF11, 'Queued').lines, ...OWN }
    expect(w.lines).toEqual(w.asked.map((a, i) => (i === 0 || i === 5 ? GROUP_LINES11 : pick(own, a.labels))))
    expect(w.lines[1]?.['hub/w1']).toBe('in progress, queue 1, S-1 running, 0 of 2 met')
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/w4'], ['board', '--brief', '--json'], ['board', '--card', 'hub/q3']])
  })

  test('more than four groups: three and More, the rest under Back; a group on the later page opens as any other', async ($, on) => {
    const w = world(on, { taps: ['More', 'Awaiting owner', 'weather/asks-owner'] })
    expect(await run($, 'k-board')).toBe(cardOf(row('weather/asks-owner')).trimEnd())
    const head = ['Made at 2026-11-07 12:00.', '', BRIEF.machine].join('\n')
    expect(w.asked).toEqual([
      { header: 'Board', question: `${head}\nWhich group (1 to 3 of 6)?`, labels: ['Working on now', 'Proposed', 'Queued', 'More'] },
      { header: 'Board', question: `${head}\nWhich group (4 to 6 of 6)?`, labels: ['Reviewed', 'Awaiting owner', 'Done this week', 'Back'] },
      { header: 'Board', question: 'Awaiting owner (1): Which task\'s card?', labels: ['weather/asks-owner', 'Back'] },
    ])
    expect(w.lines).toEqual([
      { 'Working on now': '1 task', Proposed: '1 task', Queued: '1 task', More: OWN.More },
      { Reviewed: '1 task', 'Awaiting owner': '1 task', 'Done this week': '1 task', Back: OWN.Back },
      { 'weather/asks-owner': 'awaiting owner', Back: OWN.Back },
    ])
  })

  test('Skip, a dismissal and words that are no choice, at every step, each answer with the brief board itself, and read no card', async ($, on) => {
    const ends: (string | null)[][] = [[SKIP], [null], ['Queued?'], ['More', SKIP], ['More', null], ['Queued', SKIP], ['Queued', null], ['Queued', 'hub/sync'], ['More', 'Reviewed', SKIP]]
    const w = world(on, { taps: ends.flat() })
    for (const taps of ends) expect([taps, await run($, 'k-board')]).toEqual([taps, CHAT])
    expect(await run($, 'k-board', '', BRIDGE)).toBe(`${CHAT}\n\n(typed in Remote Control)`)
    expect(w.asked.length).toBe(ends.flat().length + 1)
    expect(args(w.boards).filter(a => a.includes('--card'))).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('an empty group is named and counted, but no choice; one group alone is padded with Cancel, which answers with the brief board', async ($, on) => {
    const brief = briefOf([{ name: 'Working on now', lines: [] }, { name: 'Queued', lines: ['hub/sync-notes: queued, queue 2'] }])
    const w = world(on, { brief: json(brief), taps: ['Cancel', 'Queued', 'hub/sync-notes'] })
    expect(await run($, 'k-board')).toBe('Made at 2026-11-07 12:00.\n\nWorking on now (0)\n\nQueued (1)  \nhub/sync-notes: queued, queue 2\n\nNo lock, no heavy jobs waiting, 0 of 2 steps running, no device claims.')
    expect(await run($, 'k-board')).toBe(cardOf(row('hub/sync-notes')).trimEnd())
    // The empty group, no choice, is counted above the question; Queued's count is its choice's line.
    const first = { header: 'Board', question: 'Made at 2026-11-07 12:00.\n\nWorking on now: 0\n\nNo lock, no heavy jobs waiting, 0 of 2 steps running, no device claims.\nWhich group?', labels: ['Queued', 'Cancel'] }
    expect(w.asked).toEqual([first, first, { header: 'Board', question: 'Queued (1): Which task\'s card?', labels: ['hub/sync-notes', 'Back'] }])
    expect(w.lines).toEqual([{ Queued: '1 task', Cancel: OWN.Cancel }, { Queued: '1 task', Cancel: OWN.Cancel }, { 'hub/sync-notes': 'queued, queue 2', Back: OWN.Back }])
  })

  test('/k-board <id> answers that card at once, with no dialog; an id k does not know answers its refusal; one word only, and never a flag', async ($, on) => {
    const w = world(on)
    expect(await run($, 'k-board', ` ${ID} `)).toBe(cardOf(row(ID)).trimEnd())
    expect(await run($, 'k-board', 'hub/old', BRIDGE)).toBe(`${cardOf(row('hub/old')).trimEnd()}\n\n(typed in Remote Control)`)
    expect(await run($, 'k-board', 'hub/nope')).toBe('/k-board refused:\nk: no task hub/nope')
    expect(await run($, 'k-board', `${ID} now`)).toBe(`/k-board takes one task id or nothing, not ${ID} now.`)
    expect(await run($, 'k-board', '--json')).toBe('/k-board: --json is not a task id.')
    expect(w.asked).toEqual([])
    expect(args(w.boards)).toEqual([['board', '--card', ID], ['board', '--card', 'hub/old'], ['board', '--card', 'hub/nope']])
    expect(w.runs).toEqual([])
  })

  test('a board with no task answers the brief board with no dialog', async ($, on) => {
    const w = world(on, { brief: json(briefOf([{ name: 'Working on now', lines: [] }])) })
    expect(await run($, 'k-board')).toBe('Made at 2026-11-07 12:00.\n\nWorking on now (0)\n\nNo lock, no heavy jobs waiting, 0 of 2 steps running, no device claims.')
    expect(w.asked).toEqual([])
  })

  test('the dialog shows no markdown mark a line carries, and the chat answer escapes it, so each shows as written (S-10)', async ($, on) => {
    const brief = briefOf([{ name: 'Working on now', lines: ['hub/sync-notes: Sync `k list` **now**.'] }])
    const w = world(on, { brief: json(brief), taps: ['Working on now', SKIP] })
    expect(await run($, 'k-board')).toBe('Made at 2026-11-07 12:00.\n\nWorking on now (1)  \nhub/sync-notes: Sync \\`k list\\` \\*\\*now\\*\\*.\n\nNo lock, no heavy jobs waiting, 0 of 2 steps running, no device claims.')
    expect(w.asked[1]?.question).toBe('Working on now (1): Which task\'s card?')
    expect(w.lines[1]?.['hub/sync-notes']).toBe('Sync k list now.')
  })

  test('no dialog or answer of /k-board names kirunak: the engine does, before its first line (AC-12)', async ($, on) => {
    const w = world(on, { taps: ['More', 'Reviewed', SKIP, 'Queued', 'hub/sync-notes'] })
    const answers = [await run($, 'k-board', '', BRIDGE), await run($, 'k-board'), await run($, 'k-board', 'hub/old'), await run($, 'k-board', 'hub/nope')]
    expect(w.asked.length).toBe(5)
    for (const [i, a] of w.asked.entries()) expect([a.header, a.question, ...a.labels, ...Object.values(w.lines[i] ?? {})].join('\n').replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

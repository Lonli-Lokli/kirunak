import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Brief } from '../hooks/picks'
import type { KirunakRow } from '../types'

import { BRIEF, briefOf, cardOf, ID, ROWS, world } from './world'

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

// The first dialog for the eleven, word for word.
const GROUPS11 = {
  header: 'Board',
  question: [
    'Made at 2026-11-07 12:00.',
    '',
    'Working on now: 5',
    'Queued: 4',
    'Done this week: 2',
    '',
    'No lock, no heavy jobs waiting, 2 of 2 steps running, no device claims.',
    'Which group?',
  ].join('\n'),
  labels: ['Working on now', 'Queued', 'Done this week'],
}

// A group's paragraph of the brief board, which its dialog shows above the question.
const paragraph = (brief: Brief, name: string): string => brief.text.split('\n\n').find(p => p.startsWith(`${name} (`)) as string

describe('/k-board in steps: the groups, then a group\'s tasks (kirunak-phone A-9, AC-5)', () => {
  test('the first dialog says when the board was made, each group with its count and the machine\'s line; its choices are the groups', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: [SKIP] })
    await run($, 'k-board')
    expect(w.asked).toEqual([GROUPS11])
  })

  test('a group picked shows its tasks, one entry each, its paragraph of the brief board; a task tapped answers with its card, and no verb runs', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: ['Done this week', 'hub/d2'] })
    expect(await run($, 'k-board')).toBe(card11('hub/d2'))
    expect(w.asked).toEqual([
      GROUPS11,
      { header: 'Board', question: 'Done this week (2)\nhub/d1: done, 2 of 2 met\nhub/d2: done, 2 of 2 met\nWhich task\'s card?', labels: ['hub/d1', 'hub/d2', 'Back'] },
    ])
    expect(w.asked[1]?.question).toBe(`${paragraph(BRIEF11, 'Done this week')}\nWhich task's card?`)
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/d2']])
    expect(w.runs).toEqual([])
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
    expect(w.asked[1]?.question).toBe('Working on now (1)\nhub/sync-notes: Sync k list now.\nWhich task\'s card?')
  })

  test('no dialog or answer of /k-board names kirunak: the engine does, before its first line (AC-12)', async ($, on) => {
    const w = world(on, { taps: ['More', 'Reviewed', SKIP, 'Queued', 'hub/sync-notes'] })
    const answers = [await run($, 'k-board', '', BRIDGE), await run($, 'k-board'), await run($, 'k-board', 'hub/old'), await run($, 'k-board', 'hub/nope')]
    expect(w.asked.length).toBe(5)
    for (const a of w.asked) expect([a.header, a.question, ...a.labels].join('\n').replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

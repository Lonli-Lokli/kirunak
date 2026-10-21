import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Brief } from '../hooks/picks'
import type { KirunakRow } from '../types'

import { BRIEF, cardOf, ID, ROWS, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
const BRIDGE: PromptOrigin = { kind: 'bridge' }
const json = (brief: Brief) => ({ exitCode: 0, stdout: JSON.stringify(brief), stderr: '' })
const row = (id: string): KirunakRow => ROWS.find(r => r.id === id) as KirunakRow
// k's arguments after `node <k>`.
const args = (argv: string[][]) => argv.map(a => a.slice(2))

// BRIEF's lines as the chat answer draws them: each its own line, escaped where it would read as a list.
const CHAT = [
  'Made at 2026-11-07 12:00.  ',
  'Worked on now:  ',
  '1\\. weather/offline-forecast: in review, queue 1. Step: S-2 finished. AC 1 of 2 met, E 0 of 1.  ',
  'Every other task:  ',
  '2\\. hub/sync-notes: queued, queue 2.  ',
  '3\\. weather/was-reviewed: reviewed.  ',
  '4\\. hub/proposed: proposed.  ',
  '5\\. weather/asks-owner: awaiting owner.  ',
  '6\\. hub/old: done.  ',
  'Lock: weather unit tests (session s1), 1 waiting. Steps running: 1 of 2.',
].join('\n')

// Eleven tasks, the brief listing them in order, each with a card.
const ELEVEN: KirunakRow[] = Array.from({ length: 11 }, (_, i) => ({ ...(ROWS[1] as KirunakRow), id: `hub/t${i + 1}`, title: `Task ${i + 1}`, queue: i + 1 }))
const BRIEF11: Brief = {
  made: '2026-11-07 12:00',
  text: ['Made at 2026-11-07 12:00.', ...ELEVEN.map((r, i) => `${i + 1}. ${r.id}: queued, queue ${i + 1}.`), 'No lock, nothing waiting. Steps running: 0 of 2.'].join('\n'),
  ids: ELEVEN.map(r => r.id),
}

describe('/k-board, the brief board (kirunak-phone A-7, AC-5)', () => {
  test('the brief board is the dialog\'s text and the tasks are its choices, three and More; a task tapped answers with its card, and no verb runs', async ($, on) => {
    const w = world(on, { taps: ['hub/sync-notes'] })
    expect(await run($, 'k-board')).toBe(cardOf(row('hub/sync-notes')).trimEnd())
    expect(w.asked).toEqual([{ header: 'Board', question: `${BRIEF.text}\nWhich task's card (1 to 3 of 6)?`, labels: [ID, 'hub/sync-notes', 'weather/was-reviewed', 'More'] }])
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/sync-notes']])
    expect(w.runs).toEqual([])
  })

  test('Skip, a dismissal and words that are no choice each answer with the brief board itself, and read no card', async ($, on) => {
    const w = world(on, { taps: [SKIP, null, 'hub/sync'] })
    expect(await run($, 'k-board')).toBe(CHAT)
    expect(await run($, 'k-board', '', BRIDGE)).toBe(`${CHAT}\n\n(typed in Remote Control)`)
    expect(await run($, 'k-board')).toBe(CHAT)
    expect(w.asked.length).toBe(3)
    expect(args(w.boards).filter(a => a.includes('--card'))).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('one task alone: the dialog pads its one choice with Cancel, which answers with the brief board', async ($, on) => {
    const w = world(on, { brief: json({ ...BRIEF, ids: [ID] }), taps: ['Cancel'] })
    expect(await run($, 'k-board')).toBe(CHAT)
    expect(w.asked).toEqual([{ header: 'Board', question: `${BRIEF.text}\nWhich task's card?`, labels: [ID, 'Cancel'] }])
    expect(args(w.boards)).toEqual([['board', '--brief', '--json']])
  })

  test('More and Back page the choices and keep the whole text above every page; a task picked on a later page answers with its card (E-1, E-5)', async ($, on) => {
    const w = world(on, { rows: ELEVEN, brief: json(BRIEF11), taps: ['More', 'More', 'More', 'More', 'Back', 'Back', 'hub/t7'] })
    expect(await run($, 'k-board')).toBe(cardOf(ELEVEN[6] as KirunakRow).trimEnd())
    const pages = [
      ['1 to 3', ['hub/t1', 'hub/t2', 'hub/t3', 'More']],
      ['4 to 5', ['hub/t4', 'hub/t5', 'Back', 'More']],
      ['6 to 7', ['hub/t6', 'hub/t7', 'Back', 'More']],
      ['8 to 9', ['hub/t8', 'hub/t9', 'Back', 'More']],
      ['10 to 11', ['hub/t10', 'hub/t11', 'Back']],
    ] as const
    expect(w.asked.slice(0, 5)).toEqual(pages.map(([range, labels]) => ({ header: 'Board', question: `${BRIEF11.text}\nWhich task's card (${range} of 11)?`, labels })))
    // Back shows the page before again.
    expect(w.asked.slice(5)).toEqual([w.asked[3], w.asked[2]])
    expect(args(w.boards)).toEqual([['board', '--brief', '--json'], ['board', '--card', 'hub/t7']])
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
    const w = world(on, { brief: json({ made: '2026-11-07 12:00', text: 'Made at 2026-11-07 12:00.\nNo task.\n', ids: [] }) })
    expect(await run($, 'k-board')).toBe('Made at 2026-11-07 12:00.  \nNo task.')
    expect(w.asked).toEqual([])
  })

  test('the dialog shows no markdown mark a title carries, and the chat answer escapes it, so each shows as written (S-10)', async ($, on) => {
    const brief: Brief = { ...BRIEF, text: 'Made at 2026-11-07 12:00.\n## Worked on now:\n1. hub/sync-notes: Sync `k list` **now**.\n  - in review', ids: ['hub/sync-notes'] }
    const w = world(on, { brief: json(brief), taps: [SKIP] })
    expect(await run($, 'k-board')).toBe('Made at 2026-11-07 12:00.  \n\\## Worked on now:  \n1\\. hub/sync-notes: Sync \\`k list\\` \\*\\*now\\*\\*.  \n  \\- in review')
    expect(w.asked[0]?.question).toBe('Made at 2026-11-07 12:00.\nWorked on now:\n1. hub/sync-notes: Sync k list now.\n  - in review\nWhich task\'s card?')
  })

  test('no dialog or answer of /k-board names kirunak: the engine does, before its first line (AC-12)', async ($, on) => {
    const w = world(on, { taps: ['More', 'hub/proposed', SKIP] })
    const answers = [await run($, 'k-board', '', BRIDGE), await run($, 'k-board'), await run($, 'k-board', 'hub/old'), await run($, 'k-board', 'hub/nope')]
    for (const a of w.asked) expect([a.header, a.question, ...a.labels].join('\n').replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

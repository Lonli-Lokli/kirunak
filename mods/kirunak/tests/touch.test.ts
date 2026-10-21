import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { KirunakRow } from '../types'

import { ID, QUEUE, ROWS, WAITING, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

// k's arguments after `node <k>`.
const verbs = (runs: string[][]) => runs.map(argv => argv.slice(2))

const FORECAST = `${ID}: The last forecast stays readable offline.\nState: in review.`

describe('holding and starting by touch', () => {
  test('/k-hold with no id: the tasks k hold takes, then the one picked with its state above Hold, its reason typed in the free-text row, then "Hold <id>", which runs k hold by id (AC-10)', async ($, on) => {
    const w = world(on, { taps: [ID, 'Hold', 'waiting for the phone test', `Hold ${ID}`] })
    expect(await run($, 'k-hold', '', { kind: 'bridge' })).toBe(`${ID}: done\n(typed in Remote Control)`)
    expect(w.asked).toEqual([
      { header: 'Hold', question: `Tasks you can put on hold:\n1. ${ID}: in review\n2. hub/sync-notes: queued\nWhich task?`, labels: [ID, 'hub/sync-notes'] },
      { header: 'Hold', question: `${FORECAST}\nPut it on hold?`, labels: ['Hold', 'Back'] },
      { header: 'Hold', question: `${FORECAST}\nType the reason in the free-text row: why put it on hold?`, labels: ['Back', 'Cancel'] },
      { header: 'Hold', question: `${FORECAST}\nReason: waiting for the phone test\nPut it on hold, for that reason?`, labels: [`Hold ${ID}`, 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['hold', ID, '--why', 'waiting for the phone test', '--via', 'mod']])
  })

  test('/k-hold <id> <why> typed still runs at once, and with an id but no reason runs nothing', async ($, on) => {
    const w = world(on)
    await run($, 'k-hold', `${ID} the owner is away`)
    expect(await run($, 'k-hold', ID)).toBe('/k-hold: why? /k-hold <id> <why>. Nothing ran. Usage: /k-hold [<id> <why>]')
    expect([w.asked, verbs(w.runs)]).toEqual([[], [['hold', ID, '--why', 'the owner is away', '--via', 'mod']]])
  })

  test('/k-start with no id: the tasks k start takes, in pages; the one picked offers "Start <id>", which runs k start for this session, read before the dialog opened, then opens the pane (AC-11, E-1)', async ($, on) => {
    const w = world(on, { taps: ['More', 'hub/proposed', `Start hub/proposed`] })
    expect(await run($, 'k-start')).toBe(`${ID}: done`)
    expect(w.asked[0]).toEqual({
      header: 'Start',
      question: `Tasks this session can work on: (1 to 3 of 5)\n1. ${ID}: in review\n2. hub/sync-notes: queued\n3. weather/was-reviewed: reviewed\nWhich task?`,
      labels: [ID, 'hub/sync-notes', 'weather/was-reviewed', 'More'],
    })
    expect(w.asked[1]?.labels).toEqual(['hub/proposed', 'weather/asks-owner', 'Back'])
    expect(w.asked[2]).toEqual({ header: 'Start', question: 'hub/proposed: Asks for approval.\nState: proposed.\nWork on it in this session?', labels: ['Start hub/proposed', 'Back'] })
    expect(verbs(w.runs)).toEqual([['start', 'hub/proposed', '--via', 'mod', '--session', 'sess-1']])
    expect(w.idRead[0]).toBe(0)
    expect([...w.panes]).toEqual(['kirunak'])
  })

  test('/k-start <id> typed still runs at once; nothing to hold or start answers so with no dialog; a list k could not give is said', async ($, on) => {
    const w = world(on, { waiting: [{ ...WAITING, hold: [], start: [] }, { ...WAITING, hold: [], start: [] }, null] })
    expect(await run($, 'k-hold')).toBe('No task can be put on hold now.')
    expect(await run($, 'k-start')).toBe('No task to start: every task is done or on hold.')
    expect(await run($, 'k-start')).toBe('k waiting did not answer: k: the workspace did not load')
    await run($, 'k-start', ID)
    expect([w.asked, verbs(w.runs)]).toEqual([[], [['start', ID, '--via', 'mod', '--session', 'sess-1']]])
  })

  test('k checks the task again as the verb runs, and its refusal is the answer; a start k refused opens no pane (E-2)', async ($, on) => {
    const w = world(on, { taps: [ID, 'Hold', 'why', `Hold ${ID}`, ID, `Start ${ID}`], verb: { exitCode: 1, stdout: '', stderr: `k: ${ID} is on hold since 2026-11-07\n` } })
    expect(await run($, 'k-hold')).toBe(`/k-hold refused:\nk: ${ID} is on hold since 2026-11-07`)
    expect(await run($, 'k-start')).toBe(`/k-start refused:\nk: ${ID} is on hold since 2026-11-07`)
    expect(verbs(w.runs)).toEqual([['hold', ID, '--why', 'why', '--via', 'mod'], ['start', ID, '--via', 'mod', '--session', 'sess-1']])
    expect([...w.panes]).toEqual([])
  })
})

const SKIP = '[No preference]'
const FOUR = ' 1  hub/next\n 2  weather/offline-forecast\n 3  hub/sync-notes\n 4  hub/later\n'
const LIST = `The queue in order, then the parked tasks: (1 to 3 of 5)\n1. ${ID}: in review, place 1\n2. hub/sync-notes: queued, place 2\n3. hub/next: queued, place 3\nWhich task?`
const NEXT = 'hub/next: Next up.\nQueued, place 3 of 4 in the queue.'

describe('the queue by touch (AC-17)', () => {
  test('/k-queue: the queue in order, then the parked tasks; a queued task picked offers Move and "Park <id>"; Move lists the others and the end, in pages under Back; the one picked is where it goes, by id, and the answer is the queue k left', async ($, on) => {
    const w = world(on, { rows: QUEUE, taps: ['hub/next', 'Move', ID, `Move hub/next before ${ID}`], verb: { exitCode: 0, stdout: FOUR, stderr: '' } })
    expect(await run($, 'k-queue', '', { kind: 'bridge' })).toBe(`The queue now:\n\n1. hub/next\n2. ${ID}\n3. hub/sync-notes\n4. hub/later\n\n(typed in Remote Control)`)
    expect(w.asked).toEqual([
      { header: 'Queue', question: LIST, labels: [ID, 'hub/sync-notes', 'hub/next', 'More'] },
      { header: 'Queue', question: `${NEXT}\nMove it, or park it?`, labels: ['Move', 'Park hub/next', 'Back'] },
      { header: 'Queue', question: `Move hub/next before one of these, or to the end: (1 to 2 of 4)\n1. ${ID}: in review, place 1\n2. hub/sync-notes: queued, place 2\nWhere to?`, labels: [ID, 'hub/sync-notes', 'Back', 'More'] },
      { header: 'Queue', question: `${NEXT}\nTo: before ${ID}, place 1.\nMove it there?`, labels: [`Move hub/next before ${ID}`, 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['queue', 'move', 'hub/next', '--before', ID]])
  })

  test('to the end, "Park <id>" and "Put back <id>" each run their queue verb by id; a task in review offers Move alone, and a place it holds already offers no verb', async ($, on) => {
    const w = world(on, { rows: QUEUE, taps: ['hub/sync-notes', 'Move', 'More', 'End of the queue', 'Move hub/sync-notes to the end', 'hub/next', 'Park hub/next', 'More', 'hub/parked', 'Put back hub/parked', ID, 'Move', 'hub/sync-notes', SKIP] })
    for (let i = 0; i < 3; i++) await run($, 'k-queue')
    expect(w.asked[3]).toEqual({ header: 'Queue', question: 'Move hub/sync-notes before one of these, or to the end: (3 to 4 of 4)\n1. hub/later: queued, place 4\n2. End of the queue\nWhere to?', labels: ['hub/later', 'End of the queue', 'Back'] })
    expect(w.asked[4]).toEqual({ header: 'Queue', question: 'hub/sync-notes: Sync notes.\nQueued, place 2 of 4 in the queue.\nTo: the end of the queue.\nMove it there?', labels: ['Move hub/sync-notes to the end', 'Back'] })
    expect(w.asked[8]).toEqual({ header: 'Queue', question: 'The queue in order, then the parked tasks: (4 to 5 of 5)\n1. hub/later: queued, place 4\n2. hub/parked: parked\nWhich task?', labels: ['hub/later', 'hub/parked', 'Back'] })
    expect(w.asked[9]).toEqual({ header: 'Queue', question: 'hub/parked: Waits outside.\nParked: approved, out of the queue, so no step of it starts.\nPut it back, at the end of the queue?', labels: ['Put back hub/parked', 'Back'] })
    expect(verbs(w.runs)).toEqual([['queue', 'move', 'hub/sync-notes', '--last'], ['queue', 'remove', 'hub/next'], ['queue', 'add', 'hub/parked']])
    expect(await run($, 'k-queue')).toBe('Nothing ran: skipped.')
    expect(w.asked[11]?.labels).toEqual(['Move', 'Back'])
    expect(w.asked[13]).toEqual({ header: 'Queue', question: `${ID}: The last forecast stays readable offline.\nIn review, place 1 of 4 in the queue.\nTo: before hub/sync-notes, place 2.\nIt is there already. Back to the list?`, labels: ['Back', 'Cancel'] })
    expect(w.runs.length).toBe(3)
  })

  test('parked tasks alone are listed under an empty queue', async ($, on) => {
    const w = world(on, { rows: [QUEUE[4] as KirunakRow] })
    expect(await run($, 'k-queue')).toBe('Nothing ran: dismissed.')
    expect(w.asked).toEqual([{ header: 'Queue', question: 'The queue is empty. Parked:\n1. hub/parked: parked\nWhich task?', labels: ['hub/parked', 'Cancel'] }])
  })

  test('nothing queued and nothing parked answers so with no dialog; /k-queue takes nothing after its name', async ($, on) => {
    const w = world(on, { rows: [ROWS[2] as KirunakRow] })
    expect(await run($, 'k-queue')).toBe('The queue is empty, and no task is parked.')
    expect(await run($, 'k-queue', 'now')).toBe('/k-queue takes nothing, not now.')
    expect([w.asked, w.runs]).toEqual([[], []])
  })

  test('k checks the queue again as the verb runs, and its refusal is the answer (E-2)', async ($, on) => {
    const w = world(on, { rows: QUEUE, taps: ['hub/next', 'Park hub/next'], verb: { exitCode: 1, stdout: '', stderr: 'k: hub/next is not in the queue\n' } })
    expect(await run($, 'k-queue')).toBe('/k-queue refused:\nk: hub/next is not in the queue')
    expect(verbs(w.runs)).toEqual([['queue', 'remove', 'hub/next']])
  })
})

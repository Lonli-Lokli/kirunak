import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, WAITING, world } from './world'

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
      { header: 'Hold', question: `Tasks you can put on hold:\n1. ${ID}: The last forecast stays readable offline. In review.\n2. hub/sync-notes: Sync notes. Queued.\nWhich task?`, labels: [ID, 'hub/sync-notes'] },
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
      question: `Tasks this session can work on: (1 to 3 of 5)\n1. ${ID}: The last forecast stays readable offline. In review.\n2. hub/sync-notes: Sync notes. Queued.\n3. weather/was-reviewed: Reviewed and met. Reviewed.\nWhich task?`,
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

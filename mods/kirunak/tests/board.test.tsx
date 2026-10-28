import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PANE_COLORS, paneLines } from '../hooks/board'
import type { KirunakRow } from '../types'
import { ID, ROWS, status, world } from './world'

const SCROLL = { offset: 0, bodyRows: 40 }
const PANE = {
  plugin: 'kirunak',
  component: 'Pane' as const,
  requestId: 'kirunak',
  props: { title: 'kirunak', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: SCROLL, view: {} },
}
const BAND = {
  plugin: 'kirunak',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: SCROLL, view: {} },
}

const start = async ($: Engine, w: ReturnType<typeof world>) => {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

describe('the working view', () => {
  test('the pane draws the session\'s task from k list: its AC and E with verdicts, the step, review, checklist, then the queue and the lock', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect([...w.panes]).toEqual(['kirunak'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toEqual([
        `${ID}  in review, queue place 1`,
        'The last forecast stays readable offline',
        'AC-1 met: The last forecast shows with no network.',
        'AC-2 not met: The age of the forecast is said.',
        'E-1 needs device: On the oldest phone.',
        'step: S-2 finished (review.md)',
        'review: review.md, verdict: needs owner (E-1)',
        'checklist: 1 open, 2 ticked',
        ' ',
        'Queue',
        ` 1  in review  ${ID}`,
        ' 2  queued  hub/sync-notes',
        ' ',
        'lock: weather unit tests (session s1), 1 waiting',
        'running steps: 1 of 2',
        expect.stringMatching(/^read at \d\d:\d\d$/),
      ])
      const props = async (text: string) => (await ui.find({ type: 'Text', text }))?.props
      expect((await props('AC-2 not met'))?.color).toBe('error')
      expect((await props('AC-1 met'))?.color).toBe('success')
      // The five states (gulnya/mobile-dialogs AC-8, O-2): the task in review is running, its line bold as before; a
      // verdict that needs the device waits for the owner, in looks.ts's orange; a queued task is not reached.
      expect(await props(`${ID}  in review`)).toMatchObject({ color: 'warning', bold: true })
      expect((await props('E-1 needs device'))?.color).toBe('#e8710a')
      expect(await props(' 1  in review')).toMatchObject({ color: 'warning', bold: true })
      expect((await props(' 2  queued'))?.color).toBe('inactive')
      expect(await props('step: S-2')).toMatchObject({ color: 'text', dimColor: true })
      await ui.unmount()
    }
  })

  test('each line\'s state takes one of the five colours, as the dialogs map it, and its words stay as they were (gulnya/mobile-dialogs AC-8, O-2)', async () => {
    expect(PANE_COLORS).toEqual({ done: 'success', running: 'warning', na: 'inactive', waits: '#e8710a', failed: 'error' })
    const colors: Record<string, string> = {
      draft: 'inactive', proposed: '#e8710a', queued: 'inactive', parked: '#e8710a', blocked: 'error', 'in progress': 'warning',
      'in review': 'warning', reviewed: '#e8710a', 'awaiting owner': '#e8710a', done: 'success', 'on hold': '#e8710a', stale: 'error',
      'no such state': 'inactive',
    }
    const base = ROWS[0] as KirunakRow
    for (const [state, color] of Object.entries(colors)) {
      const task: KirunakRow = { ...base, state, queue: 1, ac: [{ id: 'AC-1', text: 'A check.', verdict: null }], e: [] }
      const lines = paneLines({ rows: [task], status: status(ID), at: 0, error: null })
      const head = lines.find(l => l.text === `${ID}  ${state}, queue place 1`)
      const queued = lines.find(l => l.text === ` 1  ${state}  ${ID}`)
      expect([head?.tone, head?.state && PANE_COLORS[head.state]]).toEqual(['bold', color])
      expect([queued?.tone, queued?.state && PANE_COLORS[queued.state]]).toEqual(['bold', color])
      const none = lines.find(l => l.text === 'AC-1 no verdict: A check.')
      expect(none?.state && PANE_COLORS[none.state]).toBe('inactive')
    }
    const missing = paneLines({ rows: [], status: status(ID), at: 0, error: 'exit 1' })
    expect(missing.slice(0, 2).map(l => [l.text, l.state && PANE_COLORS[l.state]])).toEqual([
      ['k did not answer: exit 1', 'error'],
      [`${ID}: k list does not have it`, 'error'],
    ])
    for (const l of missing.slice(2)) expect(l.state).toBeUndefined()
  })

  test('the line above the prompt: task, step, lock holder, queue place', async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([
      `kirunak · ${ID} · S-2 finished (review.md) · lock: weather unit tests · queue place 1`,
    ])
  })

  test('with no task in the session: no pane opened unasked, the band left to the engine, the pane says how to name one', async ($, on) => {
    const w = world(on, { task: null })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>the engine's own</Text>
    })
    await start($, w)
    expect([...w.panes]).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await band.findAll({ type: 'Text' })).map(t => t.text)).toEqual(["the engine's own"])
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await pane.findAll({ type: 'Text' }))[0]?.text).toBe('No task in this session: /k-start <id> names one.')
  })

  test('/kirunak opens the pane and closes it again, under the one "kirunak" the engine puts before an answer', async ($, on) => {
    const w = world(on, { task: null })
    await start($, w)
    const presentation = { isFullscreen: true, columns: 160 }
    expect((await $.command.run({ command: 'kirunak', args: '', origin: { kind: 'composer' }, presentation })).text).toBe('The pane is open.')
    expect([...w.panes]).toEqual(['kirunak'])
    expect((await $.command.run({ command: 'kirunak', args: '', origin: { kind: 'composer' }, presentation })).text).toBe('The pane is closed.')
    expect([...w.panes]).toEqual([])
  })
})

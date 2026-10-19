import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, world } from './world'

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
        ' 2  ready  hub/sync-notes',
        ' ',
        'lock: weather unit tests (session s1), 1 waiting',
        'running steps: 1 of 2',
        expect.stringMatching(/^read at \d\d:\d\d$/),
      ])
      expect((await ui.find({ type: 'Text', text: 'AC-2 not met' }))?.props.color).toBe('error')
      expect((await ui.find({ type: 'Text', text: 'AC-1 met' }))?.props.color).toBe('success')
      await ui.unmount()
    }
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

  test('/kirunak opens the pane and closes it again', async ($, on) => {
    const w = world(on, { task: null })
    await start($, w)
    const presentation = { isFullscreen: true, columns: 160 }
    expect((await $.command.run({ command: 'kirunak', args: '', origin: { kind: 'composer' }, presentation })).text).toBe('kirunak: the pane is open.')
    expect([...w.panes]).toEqual(['kirunak'])
    expect((await $.command.run({ command: 'kirunak', args: '', origin: { kind: 'composer' }, presentation })).text).toBe('kirunak: the pane is closed.')
    expect([...w.panes]).toEqual([])
  })
})

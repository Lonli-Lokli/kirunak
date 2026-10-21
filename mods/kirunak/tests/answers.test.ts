import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }): Promise<string> =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

describe('the lists as answers', () => {
  test('/k-list: k list\'s rows for a phone, done and on hold only with all; from the phone it says so under the list', async ($, on) => {
    const w = world(on)
    const open = await run($, 'k-list')
    expect(open.split('\n').slice(0, 3)).toEqual(['5 tasks not done and not on hold, the queue first:', '', '1. in review, queue place 1, **weather/offline-forecast**: The last'])
    expect(open).not.toContain('hub/old')
    expect(await run($, 'k-list', ' all ', { kind: 'bridge' })).toMatch(/^6 tasks, done and on hold among them, the queue first:\n[^]*\n3\. done, \*\*hub\/old\*\*: Done before\.\n[^]*\n\n\(typed in Remote Control\)$/)
    expect(await run($, 'k-list', 'everything')).toBe('/k-list takes all or nothing, not everything.')
    expect(w.reads).toBe(2)
    expect(w.runs).toEqual([])
  })

  test('/k-board: k board --markdown less its heading, so the answer names kirunak only in the engine\'s prefix; k\'s refusal when it fails', async ($, on) => {
    const w = world(on)
    expect(await run($, 'k-board', '', { kind: 'bridge' })).toBe('Made at 2026-11-07 12:00.\n\n## Working on now (1)\n\n### weather/offline-forecast\n\n(typed in Remote Control)')
    expect(w.boards.map(argv => argv.slice(2))).toEqual([['board', '--markdown']])
    expect(await run($, 'k-board', 'now')).toBe('/k-board takes nothing, not now.')
  })

  test('/k-board answers k\'s refusal', async ($, on) => {
    world(on, { board: { exitCode: 1, stdout: '', stderr: 'k: the workspace did not load\n' } })
    expect(await run($, 'k-board')).toBe('/k-board refused:\nk: the workspace did not load')
  })

  const others: PromptOrigin[] = [{ kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'task-notification' }, { kind: 'auto-continuation' }]
  for (const origin of others) {
    test(`from ${origin.kind}: each list is refused with a line, and k never runs`, async ($, on) => {
      const w = world(on)
      for (const [command, args] of [['k-list', 'all'], ['k-board', '']] as const) {
        expect(await run($, command, args, origin)).toMatch(new RegExp(`^/${command} runs only from your own prompt or from Remote Control; this one came from .+, so nothing ran\\.$`))
      }
      expect([w.reads, w.boards.length, w.runs.length]).toEqual([0, 0, 0])
    })
  }

  test('a list whose hook fails says so in the mod\'s own line', async ($, on) => {
    world(on, { broken: true })
    expect(await run($, 'k-board')).toBe('/k-board failed in the mod; the debug log says why.')
  })

  test('no answer of the mod names kirunak: the engine does, before its first line (AC-12)', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    const answers: string[] = []
    const calls: [string, string][] = [
      ['k-list', ''], ['k-list', 'all'], ['k-list', 'x'], ['k-board', ''],
      ['k-approve', ''], ['k-accept', ''], ['k-accept', '9'], ['k-hold', ID], ['k-start', ID], ['kirunak', ''], ['kirunak', ''],
    ]
    for (const [command, args] of calls) for (const kind of ['composer', 'bridge'] as const) answers.push(await run($, command, args, { kind }))
    answers.push(await run($, 'k-list', '', { kind: 'sdk' }))
    // A path or an id may hold the word; the mod's own words never do.
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

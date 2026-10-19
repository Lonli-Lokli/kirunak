import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, world } from './world'

const PRESENTATION = { isFullscreen: false, columns: 120 }

const run = ($: Engine, command: string, args: string, origin: PromptOrigin) =>
  $.command.run({ command, args, origin, presentation: PRESENTATION })

describe('the owner\'s commands', () => {
  test('registers /k-approve, /k-accept, /k-hold, /k-start and /kirunak, and never /k-done; a -p run reads nothing', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
    await w.clock.advance(60_000)
    expect(w.registered).toEqual(['k-approve', 'k-accept', 'k-hold', 'k-start', 'kirunak'])
    expect([w.reads, w.tails.length]).toEqual([0, 0])
  })

  const others: PromptOrigin[] = [
    { kind: 'sdk' },
    { kind: 'plugin', name: 'other' },
    { kind: 'peer' },
    { kind: 'unclassified' },
    { kind: 'peer-send-message' },
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'auto-continuation' },
  ]
  for (const origin of others) {
    test(`from ${origin.kind}: refused with a line, and k never runs`, async ($, on) => {
      const w = world(on)
      for (const command of ['k-approve', 'k-accept', 'k-hold', 'k-start']) {
        const { text } = await run($, command, `${ID} because`, origin)
        expect(text).toMatch(new RegExp(`^/${command} runs only from your own prompt or from Remote Control; this one came from .*${origin.kind === 'plugin' ? 'the plugin other' : origin.kind}, so nothing ran\\.$`))
      }
      expect(w.runs).toEqual([])
    })
  }

  for (const kind of ['composer', 'bridge'] as const) {
    test(`from ${kind}: each verb runs k with --via mod and prints the state line`, async ($, on) => {
      const w = world(on)
      expect((await run($, 'k-accept', ID, { kind })).text).toBe(kind === 'bridge' ? `${ID}: done\n(typed in Remote Control)` : `${ID}: done`)
      await run($, 'k-approve', `${ID} --amendment A-2 --first`, { kind })
      await run($, 'k-hold', `${ID} waiting for the phone test`, { kind })
      await run($, 'k-start', ID, { kind })
      expect(w.runs.map(argv => argv[0])).toEqual(['node', 'node', 'node', 'node'])
      expect(w.runs.every(argv => /\/mods\/kirunak\/\.\.\/\.\.\/bin\/k\.mjs$/.test(argv[1] ?? ''))).toBe(true)
      expect(w.runs.map(argv => argv.slice(2))).toEqual([
        ['accept', ID, '--via', 'mod'],
        ['approve', ID, '--amendment', 'A-2', '--first', '--via', 'mod'],
        ['hold', ID, '--why', 'waiting for the phone test', '--via', 'mod'],
        ['start', ID, '--via', 'mod', '--session', 'sess-1'],
      ])
    })
  }

  test('quoted values reach k whole', async ($, on) => {
    const w = world(on)
    await run($, 'k-accept', `${ID} --checklist-open "checked on the phone"`, { kind: 'bridge' })
    await run($, 'k-hold', `${ID} --why='the owner is away'`, { kind: 'composer' })
    expect(w.runs.map(argv => argv.slice(2))).toEqual([
      ['accept', ID, '--checklist-open', 'checked on the phone', '--via', 'mod'],
      ['hold', ID, '--why', 'the owner is away', '--via', 'mod'],
    ])
  })

  test('a flag of its own, --via, a bad id, an open quote or a hold with no reason: a line, and k never runs', async ($, on) => {
    const w = world(on)
    const cases: [string, string, RegExp][] = [
      ['k-accept', `${ID} --via shell`, /--via is the mod's own\. Nothing ran\./],
      ['k-accept', `${ID} --constructor x`, /\/k-accept takes no --constructor\. Nothing ran\./],
      ['k-approve', `${ID} --toString`, /\/k-approve takes no --toString\. Nothing ran\./],
      ['k-accept', `${ID} --first`, /\/k-accept takes no --first\. Nothing ran\./],
      ['k-approve', `${ID} --amendment`, /--amendment needs a value\. Nothing ran\./],
      ['k-approve', 'not-an-id', /not a task id: not-an-id\. Nothing ran\./],
      ['k-start', '', /which task\? give its id, <repo>\/<slug>\. Nothing ran\./],
      ['k-start', `${ID} extra`, /unexpected extra\. Nothing ran\./],
      ['k-hold', `${ID} "open`, /a quote is left open\. Nothing ran\./],
      ['k-hold', ID, /why\? \/k-hold <id> <why>\. Nothing ran\. Usage: \/k-hold <id> <why>$/],
    ]
    for (const [command, args, want] of cases) {
      expect((await run($, command, args, { kind: 'composer' })).text).toMatch(want)
    }
    expect(w.runs).toEqual([])
  })

  test('a hook that fails answers with the mod\'s own line, and k never runs', async ($, on) => {
    const w = world(on, { broken: true })
    expect((await run($, 'k-accept', ID, { kind: 'composer' })).text).toBe('/k-accept failed in the mod (the debug log says why); if k had started, `k list --all` shows whether it took.')
    expect(w.runs).toEqual([])
  })

  test('k\'s refusal is the output, under the command\'s name', async ($, on) => {
    world(on, { verb: { exitCode: 1, stdout: '', stderr: `k: ${ID}: the latest review is not met (AC-2)\n` } })
    expect((await run($, 'k-accept', ID, { kind: 'composer' })).text).toBe(`/k-accept refused:\nk: ${ID}: the latest review is not met (AC-2)`)
  })
})

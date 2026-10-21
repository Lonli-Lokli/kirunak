import type { PromptAutocompleteInput, PromptAutocompleteResult, PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { byNumber } from '../hooks/waiting'

import { ID, WAITING, world } from './world'

// The kit's Engine type lists the events a plugin may call; the engine's own $ also raises prompt.autocomplete, as the
// prompt box does (2.1.303), so the test reaches it through this cast.
const autocomplete = ($: Engine, e: PromptAutocompleteInput): Promise<PromptAutocompleteResult> =>
  ($.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> }).autocomplete(e)

const run = ($: Engine, command: string, args: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })

describe('picking what waits for the owner', () => {
  test('/k-accept with no id lists what waits, numbered, with what blocks each; from the phone it says so', async ($, on) => {
    const w = world(on)
    expect((await run($, 'k-accept', '', { kind: 'bridge' })).text).toBe([
      'Waiting for you to accept:',
      '  1  weather/was-reviewed  can accept (review.md)',
      `  2  ${ID}  not yet: ${ID}: checklist.md has 1 unticked item(s):`,
      '/k-accept 1 accepts the first. Add --checklist-open "<why>" to accept one with checklist items open.',
      '(typed in Remote Control)',
    ].join('\n'))
    expect((await run($, 'k-approve', '')).text).toBe('Waiting for you to approve:\n  1  hub/proposed  can approve\n/k-approve 1 approves the first.')
    expect(w.runs).toEqual([])
  })

  test('/k-accept <n> takes the n-th of the list last shown, with its flags; a number of no list, or past it, runs nothing', async ($, on) => {
    const w = world(on)
    expect((await run($, 'k-accept', '1')).text).toBe('/k-accept 1: 1 of which list? the command with no id shows it first. Nothing ran.')
    await run($, 'k-accept', '')
    expect((await run($, 'k-accept', '3')).text).toBe('/k-accept 3: the list you were shown has no 3. Nothing ran.')
    expect(w.runs).toEqual([])
    await run($, 'k-accept', '2 --checklist-open "read on the phone"', { kind: 'bridge' })
    await run($, 'k-accept', '1')
    expect(w.runs.map(argv => argv.slice(2))).toEqual([
      ['accept', ID, '--checklist-open', 'read on the phone', '--via', 'mod'],
      ['accept', 'weather/was-reviewed', '--via', 'mod'],
    ])
  })

  test('a number names one id of its own verb\'s list, or nothing', () => {
    const offered = ['a/one', 'a/two']
    const cases: [string, readonly string[] | undefined, ReturnType<typeof byNumber>][] = [
      ['1', offered, { args: 'a/one' }],
      [' 2 --checklist-open x', offered, { args: 'a/two --checklist-open x' }],
      ['1 2', offered, { args: 'a/one 2' }],
      ['3', offered, { problem: 'the list you were shown has no 3' }],
      ['1', undefined, { problem: '1 of which list? the command with no id shows it first' }],
      ['01', offered, null],
      ['1abc', offered, null],
      ['0', offered, null],
      ['a/one', offered, null],
    ]
    for (const [args, list, want] of cases) expect(byNumber(args, list)).toEqual(want)
  })

  test('/clear or a resume forgets the list, as does a list that could not be read; each verb keeps its own', async ($, on) => {
    const w = world(on, { waiting: [WAITING, null] })
    await run($, 'k-accept', '')
    expect((await run($, 'k-approve', '1')).text).toBe('/k-approve 1: 1 of which list? the command with no id shows it first. Nothing ran.')
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect((await run($, 'k-accept', '1')).text).toBe('/k-accept 1: 1 of which list? the command with no id shows it first. Nothing ran.')
    expect((await run($, 'k-accept', '')).text).toBe('k waiting did not answer: k: the workspace did not load')
    expect((await run($, 'k-accept', '1')).text).toBe('/k-accept 1: 1 of which list? the command with no id shows it first. Nothing ran.')
    expect(w.runs).toEqual([])
  })

  test('the lists keep the origin rule: from any other origin nothing is listed or run', async ($, on) => {
    const w = world(on)
    expect((await run($, 'k-accept', '', { kind: 'sdk' })).text).toMatch(/came from sdk, so nothing ran\.$/)
    expect((await run($, 'k-accept', '1', { kind: 'peer' })).text).toMatch(/came from peer, so nothing ran\.$/)
    expect(w.runs).toEqual([])
  })

  test('a mod loaded through a link runs the k of the folder the link names', async ($, on) => {
    const w = world(on, { linkedTo: '/src/kirunak/mods/kirunak' })
    await run($, 'k-accept', ID)
    expect(w.runs[0]?.[1]).toBe('/src/kirunak/mods/kirunak/../../bin/k.mjs')
  })

  test('the typeahead offers the ids each command takes, after the engine\'s own rows', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    const rows = async (text: string) => {
      const start = text.lastIndexOf(' ') + 1
      const { suggestions } = await autocomplete($, { text, cursor: text.length, token: text.slice(start), start })
      return suggestions.map(s => s.text)
    }
    // weather/asks-owner awaits the owner with no review: a question, nothing to accept.
    expect(await rows('/k-accept w')).toEqual(['engine-row', 'weather/was-reviewed'])
    expect(await rows('/k-approve h')).toEqual(['engine-row', 'hub/proposed'])
    expect(await rows('/k-hold w')).toEqual(['engine-row', ID, 'weather/was-reviewed', 'weather/asks-owner'])
    expect(await rows('/k-accept w --checklist-open w')).toEqual(['engine-row'])
    expect(await rows('please w')).toEqual(['engine-row'])
  })
})

import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'

// The model's own AskUserQuestion, as a tool call of its turn.
const modelAsks = ($: Engine, label: string) =>
  $.tool.call({
    tool: 'AskUserQuestion',
    tool_use_id: `toolu_${label.length}`,
    questions: [{ question: `${label}?`, header: 'Approve', multiSelect: false, options: [{ label, description: '' }, { label: 'Back', description: '' }] }],
  })

// The taps from /k-accept's list to its last verb: the task, Accept with open items, the reason, the verb.
const PATH = [ID, 'Accept with open items', 'read on the phone', `Accept ${ID} with open items`]

describe('the owner-only rule (kirunak-phone AC-4)', () => {
  const others: PromptOrigin[] = [{ kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'unclassified' }, { kind: 'task-notification' }]
  for (const origin of others) {
    test(`from ${origin.kind}: /k-approve, /k-accept and /k-amendments are refused before any read or dialog, and k runs nothing`, async ($, on) => {
      const w = world(on, { taps: ['hub/proposed', 'Approve hub/proposed', ...PATH] })
      for (const command of ['k-approve', 'k-accept', 'k-amendments']) expect(await run($, command, '', origin)).toMatch(/, so nothing ran\.$/)
      expect([w.asked, w.waits, w.runs]).toEqual([[], 0, []])
    })
  }

  test('a dialog the model raised, answered "Approve <id>", runs nothing, before and after the owner\'s own dialog', async ($, on) => {
    const w = world(on, { taps: ['Approve hub/proposed', 'hub/proposed', null, 'Approve hub/proposed'] })
    await modelAsks($, 'Approve hub/proposed')
    expect(await run($, 'k-approve')).toMatch(/^Nothing ran: dismissed\.\n/)
    await modelAsks($, 'Approve hub/proposed')
    expect(w.asked.map(a => a.labels[0])).toEqual(['Approve hub/proposed', 'hub/proposed', 'Approve hub/proposed', 'Approve hub/proposed'])
    expect(w.runs).toEqual([])
  })

  test('skipped, dismissed or answered with no choice at any depth, nothing runs and the answer says why (E-3)', async ($, on) => {
    const ends: [string | null, string][] = [[null, 'dismissed'], [SKIP, 'skipped']]
    const cases: [(string | null)[], string][] = [
      ...[0, 1, 2, 3].flatMap(depth => ends.map(([tap, why]): [(string | null)[], string] => [[...PATH.slice(0, depth), tap], why])),
      // A verb's own label, typed in the free-text row of a dialog that does not offer it.
      [[`Accept ${ID} with open items`], 'the answer was none of the choices'],
      [[ID, `Accept ${ID} with open items`], 'the answer was none of the choices'],
      [[ID, 'Accept with open items', '  '], 'no reason was typed'],
      [[ID, 'Accept with open items', 'Cancel'], 'cancelled'],
    ]
    const w = world(on, { taps: cases.flatMap(([taps]) => taps) })
    for (const [, why] of cases) expect((await run($, 'k-accept')).split('\n')[0]).toBe(`Nothing ran: ${why}.`)
    expect(w.runs).toEqual([])
  })

  test('the verb runs only when the last tap is the verb itself; Back from it shows each dialog before again and runs nothing (E-5)', async ($, on) => {
    const w = world(on, { taps: [...PATH.slice(0, 3), 'Back', 'Back', 'Back', SKIP, ...PATH] })
    expect((await run($, 'k-accept')).split('\n')[0]).toBe('Nothing ran: skipped.')
    const [list, item, reason] = w.asked
    expect(w.asked.slice(4, 7)).toEqual([reason, item, list])
    expect(w.runs).toEqual([])
    await run($, 'k-accept')
    expect(w.runs.map(argv => argv.slice(2))).toEqual([['accept', ID, '--checklist-open', 'read on the phone', '--via', 'mod']])
  })
})

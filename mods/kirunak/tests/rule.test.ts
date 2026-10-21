import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, QUEUE, WAITING, world } from './world'

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
// /k-hold's, /k-start's and /k-queue's: to Hold <id>, Start <id>, Move <id> before <id> and Put back <id>.
const HOLD = [ID, 'Hold', 'the owner is away', `Hold ${ID}`]
const START = [ID, `Start ${ID}`]
const MOVE = ['hub/next', 'Move', ID, `Move hub/next before ${ID}`]
const BACK_IN = ['More', 'hub/parked', 'Put back hub/parked']

describe('the owner-only rule (kirunak-phone AC-4)', () => {
  const others: PromptOrigin[] = [{ kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'unclassified' }, { kind: 'task-notification' }]
  for (const origin of others) {
    test(`from ${origin.kind}: /k-approve, /k-accept, /k-amendments, /k-hold, /k-start and /k-queue are refused before any read or dialog, and k runs nothing`, async ($, on) => {
      const w = world(on, { rows: QUEUE, taps: ['hub/proposed', 'Approve hub/proposed', ...PATH, ...HOLD, ...MOVE] })
      for (const command of ['k-approve', 'k-accept', 'k-amendments', 'k-hold', 'k-start', 'k-queue']) expect(await run($, command, '', origin)).toMatch(/, so nothing ran\.$/)
      expect([w.asked, w.waits, w.reads, w.runs]).toEqual([[], 0, 0, []])
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

  test('words typed in the free-text row that equal a choice exactly are that choice, the verb\'s among them: $.ui.ask gives one string for both (finding 4); words a case or a space apart run nothing', async ($, on) => {
    const typed = (verb: string): (string | null)[] => ['hub/proposed', verb]
    const w = world(on, { taps: [...typed('approve hub/proposed'), ...typed('Approve hub/proposed '), ...typed('Approve  hub/proposed'), ...typed('Approve hub/proposed')] })
    for (let i = 0; i < 3; i++) expect((await run($, 'k-approve')).split('\n')[0]).toBe('Nothing ran: the answer was none of the choices.')
    expect(w.runs).toEqual([])
    expect(await run($, 'k-approve')).toBe(`${ID}: done`)
    expect(w.runs.map(argv => argv.slice(2))).toEqual([['approve', 'hub/proposed', '--via', 'mod']])
  })

  test('a reason starting with -- is refused in the dialog with its own line, and k never runs; -- inside a reason is the owner\'s words (finding 8)', async ($, on) => {
    const w = world(on, { taps: [ID, 'Hold', '--dry-run', ID, 'Accept with open items', ' --dry-run', `${ID} A-4`, 'Decline', '--why', ID, 'Hold', 'wait -- see notes', `Hold ${ID}`] })
    const line = 'Nothing ran: the reason started with --, which k takes for a flag.'
    expect(await run($, 'k-hold')).toBe(line)
    expect((await run($, 'k-accept')).split('\n')[0]).toBe(line)
    expect((await run($, 'k-amendments')).split('\n')[0]).toBe(line)
    expect(w.runs).toEqual([])
    await run($, 'k-hold')
    expect(w.runs.map(argv => argv.slice(2))).toEqual([['hold', ID, '--why', 'wait -- see notes', '--via', 'mod']])
  })

  test('a hook that fails mid-dialog answers with the mod\'s own line, and k never runs', async ($, on) => {
    // k waiting giving one id twice: the second page's choices would not be unique, so drawing it fails.
    const approve = ['hub/t1', 'hub/t2', 'hub/t3', 'hub/t4', 'hub/t4'].map(id => ({ id, title: id, why: null }))
    const w = world(on, { waiting: [{ ...WAITING, approve }], taps: ['More', 'hub/t4', 'Approve hub/t4'] })
    expect(await run($, 'k-approve')).toBe('/k-approve failed in the mod (the debug log says why); if k had started, `k list --all` shows whether it took.')
    expect(w.asked.length).toBe(1)
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

  test('a dialog the model raised, answered "Hold <id>", "Start <id>", "Move <id> before <id>", "Park <id>" or "Put back <id>", runs nothing, before and after the owner\'s own dialogs', async ($, on) => {
    const w = world(on, { rows: QUEUE, taps: [`Hold ${ID}`, 'hub/next', null, `Move hub/next before ${ID}`, ID, null, 'Park hub/next', `Start ${ID}`, 'Put back hub/parked'] })
    await modelAsks($, `Hold ${ID}`)
    await run($, 'k-queue')
    await modelAsks($, `Move hub/next before ${ID}`)
    await run($, 'k-hold')
    for (const label of ['Park hub/next', `Start ${ID}`, 'Put back hub/parked']) await modelAsks($, label)
    expect(w.asked.length).toBe(9)
    expect(w.runs).toEqual([])
  })

  test('/k-hold, /k-start and /k-queue skipped, dismissed or answered with no choice at any depth, a blank reason and Cancel: nothing runs and the answer says why (E-3)', async ($, on) => {
    const ends: [string | null, string][] = [[null, 'dismissed'], [SKIP, 'skipped']]
    type Case = [string, (string | null)[], string]
    // Each dialog on the way to the verb, ended there.
    const upTo = (command: string, path: string[]): Case[] => path.flatMap((_, depth) => ends.map(([tap, why]): Case => [command, [...path.slice(0, depth), tap], why]))
    const cases: Case[] = [
      ...upTo('k-hold', HOLD),
      ...upTo('k-start', START),
      ...upTo('k-queue', MOVE),
      ...upTo('k-queue', BACK_IN),
      // A verb's own label, typed in the free-text row of a dialog that does not offer it.
      ['k-hold', [`Hold ${ID}`], 'the answer was none of the choices'],
      ['k-start', [`Start ${ID}`], 'the answer was none of the choices'],
      ['k-queue', ['hub/next', `Move hub/next before ${ID}`], 'the answer was none of the choices'],
      ['k-queue', ['More', 'Put back hub/parked'], 'the answer was none of the choices'],
      ['k-hold', [ID, 'Hold', '  '], 'no reason was typed'],
      ['k-hold', [ID, 'Hold', 'Cancel'], 'cancelled'],
    ]
    const w = world(on, { rows: QUEUE, taps: cases.flatMap(([, taps]) => taps) })
    for (const [command, , why] of cases) expect(await run($, command)).toBe(`Nothing ran: ${why}.`)
    expect(w.runs).toEqual([])
  })

  test('/k-hold, /k-start and /k-queue: Back shows each dialog before again and runs nothing; the verb runs only as the last tap (E-5)', async ($, on) => {
    const w = world(on, { rows: QUEUE, taps: [...HOLD.slice(0, 3), 'Back', 'Back', 'Back', SKIP, ID, 'Back', SKIP, 'hub/next', 'Move', 'More', 'End of the queue', 'Back', 'Back', 'Back', 'Back', SKIP, ...BACK_IN.slice(0, 2), 'Back', 'Back', SKIP] })
    for (const command of ['k-hold', 'k-start', 'k-queue', 'k-queue']) expect(await run($, command)).toBe('Nothing ran: skipped.')
    const a = w.asked
    expect(a.slice(4, 7)).toEqual([a[2], a[1], a[0]])
    expect(a[9]).toEqual(a[7])
    expect(a.slice(15, 19)).toEqual([a[13], a[12], a[11], a[10]])
    expect(a.slice(22, 24)).toEqual([a[20], a[19]])
    expect(a.length).toBe(24)
    expect(w.runs).toEqual([])
  })
})

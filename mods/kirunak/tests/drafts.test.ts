import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { DraftRow } from '../hooks/drafts'

import { DRAFTS, world } from './world'

const run = async ($: Engine, args = '', origin: PromptOrigin = { kind: 'composer' }): Promise<string> =>
  (await $.command.run({ command: 'k-drafts', args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
// k's arguments after `node <k>`.
const verbs = (runs: string[][]) => runs.map(argv => argv.slice(2))

const LIST = 'Drafts, by the date written:\n1. hub/offline-maps: Maps that work offline, written 2026-11-05\n2. weather/rain-alerts: Rain alerts, written 2026-11-06\n3. hub/no-date: no-date, no date written\nWhich draft?'
const LABELS = ['hub/offline-maps', 'weather/rain-alerts', 'hub/no-date']
// The answer's list when nothing ran.
const TEXT = '3 drafts, by the date written:\n\n1. **hub/offline-maps**: Maps that work offline, written 2026-11-05\n2. **weather/rain-alerts**: Rain alerts, written 2026-11-06\n3. **hub/no-date**: no-date, no date written\n\n/k-drafts shows one whole, to start its intake or drop it.'
// The first draft whole, as the dialog draws it: its head, then its file below the front matter, the marks left out.
const WHOLE = 'hub/offline-maps: Maps that work offline.\nWritten 2026-11-05.\n\nWho raised it\n\n> The maps should work offline too.\n\nowner, 2026-11-05, session s1\n\nWhy\n\nThe forecast works offline; the maps do not.\n\nWhat was found\n\n- The tiles load from the network. [file hub/src/Map.kt]\n\nQuestions\n\n1. Which areas are kept?\n2. How old may a tile be?\nStart the intake from it, or drop it?'
const ITEM = ['Start intake', 'Drop', 'Back']

const many = (n: number): DraftRow[] => Array.from({ length: n }, (_, i) => ({ id: `hub/d${i + 1}`, repo: 'hub', slug: `d${i + 1}`, title: `Draft ${i + 1}`, written: `2026-11-0${i + 1}`, path: `/w/hub/kirunak/drafts/d${i + 1}.md` }))

describe('/k-drafts (kirunak-drafts AC-2, AC-7, E-3)', () => {
  test('no drafts says so, with no dialog; anything typed after the command is refused; a k that fails says so', async ($, on) => {
    const w = world(on, { drafts: [[], null] })
    expect(await run($)).toBe('No drafts: no repo holds one.')
    expect(await run($, 'all')).toBe('/k-drafts takes nothing, not all.')
    expect(await run($)).toBe('/k-drafts refused:\nk: the workspace did not load')
    expect([w.asked, w.runs]).toEqual([[], []])
  })

  test('the drafts numbered, one line each (id, title, the date written), the ids as choices; Skip runs nothing and answers with the list', async ($, on) => {
    const w = world(on, { taps: [SKIP] })
    expect(await run($)).toBe(`Nothing ran: skipped.\n\n${TEXT}`)
    expect(w.asked).toEqual([{ header: 'Drafts', question: LIST, labels: LABELS }])
    expect(await run($, '', { kind: 'bridge' })).toBe(`Nothing ran: dismissed.\n\n${TEXT}\n\n(typed in Remote Control)`)
    expect([w.draftReads, w.runs]).toEqual([2, []])
  })

  test('more than fit come in pages of three and More, later pages under Back, numbered as the app numbers them', async ($, on) => {
    const w = world(on, { drafts: [many(5)], taps: ['More', 'Back', SKIP] })
    await run($)
    const [one, two] = [w.asked[0], w.asked[1]]
    expect(one).toEqual({ header: 'Drafts', question: 'Drafts, by the date written: (1 to 3 of 5)\n1. hub/d1: Draft 1, written 2026-11-01\n2. hub/d2: Draft 2, written 2026-11-02\n3. hub/d3: Draft 3, written 2026-11-03\nWhich draft?', labels: ['hub/d1', 'hub/d2', 'hub/d3', 'More'] })
    expect(two).toEqual({ header: 'Drafts', question: 'Drafts, by the date written: (4 to 5 of 5)\n1. hub/d4: Draft 4, written 2026-11-04\n2. hub/d5: Draft 5, written 2026-11-05\nWhich draft?', labels: ['hub/d4', 'hub/d5', 'Back'] })
    expect(w.asked[2]).toEqual(one)
    expect(w.runs).toEqual([])
  })

  test('a draft picked shows whole from its file, with Start intake, Drop and Back; Back shows the list again; one whose file cannot be read says so', async ($, on) => {
    const w = world(on, { taps: ['hub/offline-maps', 'Back', 'hub/no-date', SKIP] })
    expect(await run($)).toBe(`Nothing ran: skipped.\n\n${TEXT}`)
    expect(w.asked[1]).toEqual({ header: 'Drafts', question: WHOLE, labels: ITEM })
    expect(w.asked[2]).toEqual(w.asked[0])
    expect(w.asked[3]).toEqual({ header: 'Drafts', question: 'hub/no-date: no-date.\nNo date written.\nIts file could not be read: /w/hub/kirunak/drafts/no-date.md\nStart the intake from it, or drop it?', labels: ITEM })
    expect(w.runs).toEqual([])
  })

  test('Start intake reads the drafts again and submits a prompt of its own that names the draft, the k-intake skill and k intake start; it runs no verb', async ($, on) => {
    const w = world(on, { taps: ['hub/offline-maps', 'Start intake'] })
    expect(await run($)).toBe('The intake from hub/offline-maps starts next in this session, with the k-intake skill.')
    // Submitted once the command answered: the engine refuses a submit from inside its hook.
    expect(w.submitted).toEqual([])
    await w.clock.advance(10)
    expect(w.toasts).toEqual([])
    expect(w.submitted).toEqual([{
      text: 'The owner tapped Start intake on the draft hub/offline-maps in /k-drafts. Start the intake from it now: first load the k-intake skill with the Skill tool (skill "k-intake"), then follow it from this draft: run `k intake start hub/offline-maps --from kirunak/drafts/offline-maps.md`, that moves the draft to kirunak/tasks/offline-maps/draft.md, read it there (it is at /w/hub/kirunak/drafts/offline-maps.md until then) as background, and ask the owner every line of the task as the skill says, one question at a time.',
      origin: { kind: 'plugin', name: 'kirunak' },
    }])
    expect([w.draftReads, w.runs]).toEqual([2, []])
  })

  test('a draft dropped or taken by an intake between the list and the tap is refused by name, never another; a k that fails then runs nothing either (E-3)', async ($, on) => {
    // Gone since: the list read again holds another draft where it stood.
    const since = [{ ...(DRAFTS[1] as DraftRow) }, { ...(DRAFTS[0] as DraftRow), id: 'hub/offline-maps-2', slug: 'offline-maps-2' }]
    const w = world(on, { drafts: [DRAFTS, since, DRAFTS, null], taps: ['hub/offline-maps', 'Start intake', 'hub/offline-maps', 'Start intake'] })
    expect(await run($)).toBe('Nothing ran: hub/offline-maps is no longer a draft. It was dropped, or its intake started, since the list was shown.')
    expect(await run($)).toBe('Nothing ran: k drafts did not answer, so hub/offline-maps could not be found again: k: the workspace did not load')
    await w.clock.advance(10)
    expect([w.submitted, w.runs]).toEqual([[], []])
  })

  const DROP = ['hub/offline-maps', 'Drop', 'Done in hub/maps', 'Drop hub/offline-maps']

  test('Drop takes the reason typed in the free-text row, then "Drop <id>" under it runs k draft drop by id and answers k\'s line', async ($, on) => {
    const w = world(on, { taps: [...DROP], verb: { exitCode: 0, stdout: 'hub/offline-maps: dropped in 3f2a9c1\n', stderr: '' } })
    expect(await run($)).toBe('hub/offline-maps: dropped in 3f2a9c1')
    expect(w.asked.slice(2)).toEqual([
      { header: 'Drafts', question: 'hub/offline-maps: Maps that work offline.\nWritten 2026-11-05.\nType the reason in the free-text row: why drop it?', labels: ['Cancel', 'Back'] },
      { header: 'Drafts', question: 'hub/offline-maps: Maps that work offline.\nWritten 2026-11-05.\nReason: Done in hub/maps\nDrop it, in a commit that carries that reason?', labels: ['Drop hub/offline-maps', 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['draft', 'drop', 'hub/offline-maps', '--why', 'Done in hub/maps']])
  })

  test('a Drop k refuses (the draft gone since the list was shown) answers k\'s refusal, by the id tapped (E-3)', async ($, on) => {
    const v = world(on, { taps: [...DROP], verb: { exitCode: 1, stdout: '', stderr: 'k: no draft hub/offline-maps: /w/hub/kirunak/drafts/offline-maps.md does not exist\n' } })
    expect(await run($)).toBe('/k-drafts refused:\nk: no draft hub/offline-maps: /w/hub/kirunak/drafts/offline-maps.md does not exist')
    expect(verbs(v.runs)).toEqual([['draft', 'drop', 'hub/offline-maps', '--why', 'Done in hub/maps']])
  })

  test('Drop skipped, dismissed, cancelled, with an empty reason or one starting with --, or skipped under its reason: nothing runs and the answer says why', async ($, on) => {
    const cases: [(string | null)[], string][] = [
      [['hub/offline-maps', 'Drop', SKIP], 'skipped'],
      [['hub/offline-maps', 'Drop', null], 'dismissed'],
      [['hub/offline-maps', 'Drop', 'Cancel'], 'cancelled'],
      [['hub/offline-maps', 'Drop', '   '], 'no reason was typed'],
      [['hub/offline-maps', 'Drop', '--all'], 'the reason started with --, which k takes for a flag'],
      [['hub/offline-maps', 'Drop', 'Done elsewhere', SKIP], 'skipped'],
      [['hub/offline-maps', 'Drop', 'Back', 'Back', SKIP], 'skipped'],
    ]
    const w = world(on, { taps: cases.flatMap(([taps]) => taps) })
    for (const [, why] of cases) expect(await run($)).toBe(`Nothing ran: ${why}.\n\n${TEXT}`)
    expect(w.asked.length).toBe(cases.flatMap(([taps]) => taps).length)
    expect(w.runs).toEqual([])
  })

  test('from any origin but the owner\'s it is refused before k is read; no answer names kirunak, which the engine does', async ($, on) => {
    const w = world(on, { drafts: [DRAFTS, DRAFTS, DRAFTS, DRAFTS, []], taps: ['hub/offline-maps', 'Start intake', SKIP, 'hub/offline-maps', 'Drop', 'Not needed', 'Drop hub/offline-maps'] })
    expect(await run($, '', { kind: 'plugin', name: 'other' })).toBe('/k-drafts runs only from your own prompt or from Remote Control; this one came from the plugin other, so nothing ran.')
    expect([w.draftReads, w.asked]).toEqual([0, []])
    const answers = [await run($), await run($, '', { kind: 'bridge' }), await run($), await run($), await run($, 'x')]
    expect(answers[3]).toBe('No drafts: no repo holds one.')
    // A path or an id may hold the word; the mod's own words never do.
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

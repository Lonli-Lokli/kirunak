import type { CommandRunInput, EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { owners } from '../hooks/owner'
import type { Outcome, PickScreen, Screen, Turn } from '../hooks/owner'

// owners() from outside (S-7 review, test b): a fake body keeps an Outcome from one turn and hands it back in another,
// or keeps a typed one across its own dialog; neither runs. A test's own hooks may make no engine call (the host's
// rule: a test file spells none), so owners() gets a fake engine here: a k that exists, a dialog answering `taps` in
// order, and a k that records each run and never finishes, so nothing past the run is reached.

const ARGV = ['approve', 'hub/proposed', '--via', 'mod']
// One item dialog, its verb choice under the item's words.
const ITEM: Screen = { kind: 'item', header: 'Approve', text: ['hub/proposed: Asks for approval.'], choices: [{ label: 'Approve hub/proposed', verb: ARGV }], question: 'Approve it?' }
const INPUT: CommandRunInput = { command: 'k-probe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

function engine(taps: string[]) {
  const w = { runs: [] as string[][], asked: 0 }
  const $ = {
    plugin: { root: '/m/kirunak' },
    fs: { stat: async () => ({ realPath: '/m/kirunak' }), exists: async () => true },
    ui: {
      ask: async () => {
        w.asked++
        const tap = taps.shift()
        if (tap === undefined) throw new Error('dismissed')
        return tap
      },
    },
    process: {
      run: async (argv: string[]) => {
        w.runs.push(argv.slice(2))
        throw new Error('the fake k never finishes')
      },
    },
  } as unknown as EngineInterface
  return { $, w }
}

const answer = async ($: EngineInterface, body: (turn: Turn) => Promise<string | Outcome>) => (await owners($, INPUT, 'k-probe', body)).text

describe('a turn runs only an Outcome it made (kirunak-phone AC-4, S-7 review)', () => {
  test('a body that hands back another turn\'s Outcome, typed or tapped there, runs nothing; the turn that made it runs it', async () => {
    const { $, w } = engine(['Approve hub/proposed', 'Approve hub/proposed'])
    let kept: Outcome | null = null
    const keep = async (t: Turn, how: 'typed' | 'tapped'): Promise<string> => {
      kept = how === 'typed' ? t.typed(ARGV) : await t.dialog(ITEM)
      return 'kept'
    }
    for (const how of ['typed', 'tapped'] as const) {
      expect(await answer($, t => keep(t, how))).toBe('kept')
      await expect(answer($, async () => kept as Outcome)).rejects.toThrow('/k-probe: a verb this command did not choose')
    }
    expect([w.asked, w.runs]).toEqual([1, []])
    // The control: the same dialog's Outcome, returned by the turn that made it, runs its verb.
    expect(await answer($, t => t.dialog(ITEM))).toMatch(/^\/k-probe: k did not finish \(the fake k never finishes\)/)
    expect(w.runs).toEqual([ARGV])
  })

  test('a typed Outcome returned after the turn opened its dialog runs nothing, whatever the dialog was answered', async () => {
    const { $, w } = engine(['[No preference]', 'Approve hub/proposed'])
    const typedThenAsked = async (t: Turn): Promise<Outcome> => {
      const typed = t.typed(ARGV)
      await t.dialog(ITEM)
      return typed
    }
    for (let i = 0; i < 2; i++) await expect(answer($, typedThenAsked)).rejects.toThrow('/k-probe: a verb this command did not choose')
    // Nor can a turn type a verb once its dialog is open.
    await expect(answer($, async t => {
      await t.dialog(ITEM)
      return t.typed(ARGV)
    })).rejects.toThrow('/k-probe: a typed verb after the dialog')
    expect([w.asked, w.runs]).toEqual([3, []])
  })

  test('a dialog that runs no verb (/k-board\'s) answers the label tapped, null for Skip or a dismissal; no verb is typed after it, and a verb\'s dialog never ends in a pick', async () => {
    const PICK: PickScreen = { kind: 'pick', header: 'Board', text: ['hub/proposed: proposed.'], labels: ['hub/proposed'], question: 'Which task\'s card?' }
    const LIST: Screen = { kind: 'list', header: 'Approve', head: 'Waiting:', question: 'Which task?', rows: [{ item: { lead: '', name: 'hub/proposed', text: '.' }, label: 'hub/proposed', open: () => PICK }] }
    const SKIP = '[No preference]'
    const { $, w } = engine(['hub/proposed', SKIP, 'hub/proposed', SKIP, 'hub/proposed', 'hub/proposed'])
    const picked = async (t: Turn): Promise<string> => (await t.pick(PICK)) ?? 'none'
    expect(await answer($, picked)).toBe('hub/proposed')
    expect(await answer($, picked)).toBe('none')
    await expect(answer($, async t => {
      await t.pick(PICK)
      return t.typed(ARGV)
    })).rejects.toThrow('/k-probe: a typed verb after the dialog')
    await expect(answer($, async t => {
      await t.dialog(ITEM)
      return picked(t)
    })).rejects.toThrow('/k-probe: a second dialog')
    await expect(answer($, t => t.dialog(LIST))).rejects.toThrow('/k-probe: a pick in a verb\'s dialog')
    // No tap left: dismissed.
    expect(await answer($, picked)).toBe('none')
    expect([w.asked, w.runs]).toEqual([7, []])
  })
})

import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DIALOG_ROWS, STATES, treeRows } from '../hooks/looks'

import { bug, READY, world } from './world'
import type { Tap } from './world'

// The mod's look on the phone and the desktop app (gulnya/mobile-dialogs S-1): the bug's dialog drawn as a head, a
// chip and its first lines with the rest behind Show all, the terminal's left as it was, and Quad Damage's started
// line drawn as a row. The engine's own drawing is the test's last hook: it records what it was asked to draw.

const run = async ($: Engine): Promise<string> =>
  (await $.command.run({ command: 'k-bugs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

type Question = { question: string; options: { label: string; description: string }[] }
const engineBelow = (on: On, seen: Question[][]) => {
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e) => {
    seen.push(e.props.questions as Question[])
    return { type: 'engine', ref: 0 } as const
  })
  on('ui.render', { component: 'AssistantMessage' }, async () => ({ type: 'engine', ref: 0 }) as const)
}

const ENGINE = { type: 'engine', ref: 0 }
const ITEM_QUESTION = 'Review and merge its fix, start a task to fix it, or drop it?'
const DESCRIBED = {
  'Review & merge': 'a fresh session reviews, then merges, never pushes',
  'Start fix': 'starts a task to fix it, its intake first',
  Drop: 'asks why, then drops it in a commit',
  Back: 'the dialog before',
}
const PICTURES = /\p{Extended_Pictographic}/u

// What a look drew, read by the test kit.
type Seen = { tree: unknown; texts: string[]; buttons: string[] }
const seenOf = async (ui: { drawn: () => Promise<unknown>; findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }): Promise<Seen> => ({
  tree: await ui.drawn(),
  texts: (await ui.findAll({ type: 'Text' })).map(t => t.text),
  buttons: (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label)),
})

// WCAG 2's contrast ratio of two #rrggbb colours.
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe("the bug's dialog", () => {
  for (const surface of ['mobile', 'desktop'] as const) {
    test(`on the ${surface}: its head, its chip, its first line and Show all above the engine's choices, each with its line`, async ($, on) => {
      const seen: Question[][] = []
      const looked: Seen[] = []
      const look: Tap = async questions => {
        const ui = await $.ui.mount({ plugin: 'kirunak', surface, component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
        looked.push(await seenOf(ui))
        await ui.press({ key: 'kirunak-show-all' })
        looked.push(await seenOf(ui))
        await ui.unmount()
        return 'Drop'
      }
      const w = world(on, { taps: ['hub/stale-tiles', look, null] })
      engineBelow(on, seen)
      await run($)

      const [folded, unfolded] = looked as [Seen, Seen]
      expect(folded.texts.slice(0, 4)).toEqual(['Old tiles stay after an update', 'fix ready', 'hub, written today', 'The tile cache keeps no version.'])
      expect(folded.buttons).toEqual(['Show all'])
      expect(unfolded.texts).toContain('Questions')
      expect(unfolded.texts).toContain('Where it is')
      expect(unfolded.buttons).toEqual(['Show less'])
      for (const l of looked) {
        expect(treeRows(l.tree)).toBeLessThanOrEqual(DIALOG_ROWS)
        expect(JSON.stringify(l.tree)).not.toMatch(PICTURES)
      }
      // The engine asks the last line, each choice with its line; the dialog's own question is the one asked.
      const asked = seen.find(qs => qs[0]?.question === ITEM_QUESTION)?.[0]
      expect(Object.fromEntries((asked?.options ?? []).map(o => [o.label, o.description]))).toEqual(DESCRIBED)
      expect(w.asked[1]?.question.endsWith(`\n${ITEM_QUESTION}`)).toBe(true)
      // The tap answered as a tap does (Drop asks why); Show all answered nothing.
      expect(w.asked.map(a => a.header)).toEqual(['Bugs', 'Bugs', 'Bugs'])
      expect(w.asked[2]?.question).toMatch(/why/i)
      expect(w.runs.filter(r => r.includes('drop'))).toEqual([])
    })
  }

  test("the list on the phone: Bugs, its chip and line, a row a bug with its chip, and no Show all", async ($, on) => {
    let list: Seen | null = null
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'mobile', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      list = await seenOf(ui)
      await ui.unmount()
      return null
    }
    world(on, { taps: [look] })
    engineBelow(on, [])
    await run($)

    const { tree, texts, buttons } = list ?? ({ tree: null, texts: [], buttons: [] } as Seen)
    expect(texts.slice(0, 3)).toEqual(['Bugs', '1 fix ready', '3 bugs in hub, weather, the newest written today'])
    for (const id of ['hub/stale-tiles', 'weather/rain-gap', 'hub/no-fix']) expect(texts).toContain(id)
    expect(buttons).toEqual([])
    expect(treeRows(tree)).toBeLessThanOrEqual(DIALOG_ROWS)
    expect(JSON.stringify(tree)).not.toMatch(PICTURES)
  })

  test('on the terminal: no look, the question whole, each choice with its line', async ($, on) => {
    const seen: Question[][] = []
    let drawn: unknown = null
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'terminal', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      drawn = await ui.drawn()
      await ui.unmount()
      return null
    }
    const w = world(on, { taps: ['hub/stale-tiles', look] })
    engineBelow(on, seen)
    await run($)

    expect(drawn).toEqual(ENGINE)
    const asked = seen[seen.length - 1]?.[0]
    expect(asked?.question).toBe(w.asked[1]?.question)
    expect(Object.fromEntries((asked?.options ?? []).map(o => [o.label, o.description]))).toEqual(DESCRIBED)
  })

  test('a long bug unfolds in parts of at most 48 rows, Next and Back between them, and nothing of it left out', async ($, on) => {
    const long = bug('hub/long-read', { title: 'A bug of many words', written: '2026-10-27' })
    const why = Array.from({ length: 30 }, (_, i) => `- Line ${i + 1} of what was found, long enough to take a second row on a phone held upright.`).join('\n')
    const looked: Seen[] = []
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'mobile', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      await ui.press({ key: 'kirunak-show-all' })
      for (let i = 0; i < 10; i++) {
        const now = await seenOf(ui)
        looked.push(now)
        if (!now.buttons.includes('Next')) break
        await ui.press({ key: 'kirunak-fold-next' })
      }
      await ui.press({ key: 'kirunak-fold-back' })
      looked.push(await seenOf(ui))
      await ui.unmount()
      return null
    }
    const w = world(on, { taps: ['hub/long-read', look], bugs: [[long]] })
    w.files[long.path] = `---\nid: hub/long-read\n---\n\n## What was found\n\n${why}\n`
    engineBelow(on, [])
    await run($)

    const shown = looked.slice(0, -1)
    expect(shown.length).toBeGreaterThan(1)
    expect(shown.map(s => s.texts.find(t => / of \d+$/.test(t)))).toEqual(shown.map((_, i) => `${i + 1} of ${shown.length}`))
    for (const s of looked) {
      expect(s.texts[0]).toBe('A bug of many words')
      expect(treeRows(s.tree)).toBeLessThanOrEqual(DIALOG_ROWS)
    }
    const every = shown.flatMap(s => s.texts).filter(t => t.startsWith('- Line '))
    expect(every.length).toBe(30)
    expect(looked[looked.length - 1]?.texts).toEqual(looked[looked.length - 3]?.texts)
  })

  test('every state reads at 4.5:1 or more on its own ground (WCAG AA)', () => {
    for (const { fill, ink } of Object.values(STATES)) expect(contrast(fill, ink)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("Quad Damage's progress lines", () => {
  test('a started line draws as a row on the phone, the words around it as they were', async ($, on) => {
    world(on)
    engineBelow(on, [])
    const props = { text: 'Quad Damage runs.\n\n12:04 hub/stale-tiles: started\n\nThe next one waits.', isFirstOfReply: true }
    const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'mobile', component: 'AssistantMessage', props })
    const { tree, texts } = await seenOf(ui)
    expect(texts).toEqual(['12:04', 'started', 'hub/stale-tiles:', 'started'])
    expect((await ui.findAll({ type: 'Markdown' })).map(m => m.props.text)).toEqual(['Quad Damage runs.', 'The next one waits.'])
    expect(JSON.stringify(tree)).not.toMatch(PICTURES)
  })

  test('a line of no known form, a summary, and the terminal stay as the engine draws them', async ($, on) => {
    world(on)
    engineBelow(on, [])
    const cases = [
      { surface: 'mobile', props: { text: '12:04 hub/stale-tiles: merged into master', isFirstOfReply: true } },
      { surface: 'mobile', props: { text: '12:04 hub/stale-tiles: started', isFirstOfReply: true, isSummary: true } },
      { surface: 'terminal', props: { text: '12:04 hub/stale-tiles: started', isFirstOfReply: true } },
    ] as const
    for (const c of cases) {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: c.surface, component: 'AssistantMessage', props: c.props })
      expect(await ui.drawn()).toEqual(ENGINE)
      await ui.unmount()
    }
  })
})

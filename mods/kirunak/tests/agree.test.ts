import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DIALOG_ROWS, FREE, rowsOf, treeRows } from '../hooks/looks'

import { world } from './world'
import type { Tap } from './world'

// A draft's proposed answers agreed in one tap (gulnya/mobile-dialogs AC-15, AC-16, AC-21, E-3): Start intake's prompt
// writes the intake's first question whole, every Proposed answer numbered under the draft's head, Agree first and Not
// second, in parts past 48 rows; the model asks it as written in a turn of its own, and the call hook gives that call
// its choices' lines and its look. The world's tool.call hook is the engine, and the model's calls are its own.

const run = async ($: Engine, command = 'k-drafts'): Promise<string> =>
  (await $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const PATH = '/w/hub/kirunak/drafts/offline-maps.md'
const draft = (questions: string): string => `---\nid: hub/offline-maps\ntitle: Maps that work offline\nwritten: 2026-11-05\n---\n\n## Why\n\nThe forecast works offline; the maps do not.\n\n## Questions\n\n${questions}`
// Two proposals, one Proposed that only says what is missing, and one question with none.
const FOUR = "1. Which areas are kept?\n   Proposed: the areas the owner opened in the last month.\n2. How old may a tile be?\n   Proposed: open, the owner's to set.\n3. Are the maps kept on a memory card?\n4. Is a map dropped when the phone runs short of room?\n   Proposed: yes, the oldest first.\n"
// Twenty long proposals, past one dialog's 48 rows.
const TWENTY = Array.from({ length: 20 }, (_, i) => `${i + 1}. Which of the offline map areas is kept on the phone, as question ${i + 1} asks?\n   Proposed: the areas the owner opened in the last month, each kept whole, the oldest dropped first when room runs short.\n`).join('')

// Start intake on the first draft, its file as given, then the dialogs the model raises answered by `taps`.
const started = async ($: Engine, on: On, file: string, taps: (string | null | Tap)[] = []) => {
  const w = world(on, { taps: ['hub/offline-maps', 'Start intake', ...taps] })
  w.files[PATH] = file
  await run($)
  await w.clock.advance(10)
  return { w, text: w.submitted[0]?.text ?? '' }
}

// The questions the prompt gives to ask as written, each between two lines of dashes.
const asksIn = (text: string): string[] => {
  const out: string[] = []
  let at: string[] | null = null
  for (const l of text.split('\n')) {
    if (l !== '---') at?.push(l)
    else if (at === null) at = []
    else {
      out.push(at.join('\n'))
      at = null
    }
  }
  return out
}

// The model's own AskUserQuestion, its choices with lines of its own.
const OWN = 'its own words'
const modelAsks = ($: Engine, question: string, labels: string[]) =>
  $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_model', questions: [{ question, header: 'Draft', multiSelect: false, options: labels.map(label => ({ label, description: OWN })) }] })
const own = (labels: string[]) => Object.fromEntries(labels.map(l => [l, OWN]))

const NOT = 'asks each proposal alone'
const ONE = 'hub/offline-maps: Maps that work offline.\n2 proposed answers:\n\n1. Which areas are kept?\n   Proposed: the areas the owner opened in the last month.\n\n4. Is a map dropped when the phone runs short of room?\n   Proposed: yes, the oldest first.\n\nAgree to all 2, or not?'

describe("a draft's first question (gulnya/mobile-dialogs AC-15, AC-16, AC-21, E-3)", () => {
  test('holds every proposed answer under the draft head, Agree first and Not second, each with its line; the rest are asked alone after it', async ($, on) => {
    const { w, text } = await started($, on, draft(FOUR), ['Agree', 'Agree', 'Agree'])
    expect(text.slice(text.indexOf('\n\n'))).toBe(
      `\n\nAsk first, with AskUserQuestion and the header "Draft", the one question that holds every proposed answer: its text exactly as written between the lines of dashes, its choices in the order given, each with its line as the description. Agree makes every proposal the owner's answer, each sourced [owner <date> Q-n] to that question; Not asks each proposal alone.\n\nIts choices: Agree ("all 2 proposals become your answers"), Not ("${NOT}").\n---\n${ONE}\n---\n\nThen ask each of these alone, after it, as the draft proposes no answer to them:\n2. How old may a tile be?\n3. Are the maps kept on a memory card?`,
    )
    // In other words it is the model's own; as written it gets its lines, its labels as they came (AC-18); once
    // answered, the same words are the model's again.
    await modelAsks($, ONE.replace('all 2', 'both'), ['Agree', 'Not'])
    await modelAsks($, ONE, ['Agree', 'Not'])
    await modelAsks($, ONE, ['Agree', 'Not'])
    expect(w.asked.slice(2).map(a => [a.header, a.labels])).toEqual([['Draft', ['Agree', 'Not']], ['Draft', ['Agree', 'Not']], ['Draft', ['Agree', 'Not']]])
    expect(w.lines.slice(2)).toEqual([own(['Agree', 'Not']), { Agree: 'all 2 proposals become your answers', Not: NOT }, own(['Agree', 'Not'])])
    expect(w.runs).toEqual([])
  })

  test('past 48 rows it comes in parts "n of m", each within a dialog: Next on all but the last, Back on all but the first, Agree on the last alone, Not on every part', async ($, on) => {
    const { text } = await started($, on, draft(TWENTY))
    const parts = asksIn(text)
    const m = parts.length
    expect(m).toBeGreaterThan(1)
    expect(text).toContain(`It comes in ${m} parts, so that no proposal is agreed unseen`)
    parts.forEach((p, i) => {
      const k = i + 1
      const lines = p.split('\n')
      expect(lines.slice(0, 2)).toEqual(['hub/offline-maps: Maps that work offline.', `20 proposed answers, part ${k} of ${m}:`])
      expect(lines.at(-1)).toBe(k === m ? `Agree to all 20, in the ${m} parts, or not?` : `On to part ${k + 1} of ${m}, or not?`)
      expect(lines.reduce((n, l) => n + rowsOf(l), 0) + FREE).toBeLessThanOrEqual(DIALOG_ROWS)
      const choices = [k === m ? 'Agree ("all 20 proposals become your answers")' : `Next ("part ${k + 1} of ${m}")`, `Not ("${NOT}")`, ...(k > 1 ? [`Back ("part ${k - 1} of ${m}")`] : [])]
      expect(text).toContain(`\nPart ${k} of ${m}, its choices: ${choices.join(', ')}.\n---\n${p}\n---`)
    })
    // Every proposal once, in order, none cut.
    expect(parts.flatMap(p => p.split('\n').filter(l => /^\d+\. /.test(l)).map(l => parseInt(l, 10)))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(parts.join('\n').split('\n').filter(l => l.startsWith('   Proposed: '))).toHaveLength(20)
  })

  test('on the desktop its part draws the draft head over the numbered proposals, the terminal the whole text; Next and Back keep the parts, Not takes them away', async ($, on) => {
    const seen: string[] = []
    on('ui.render', { component: 'AskUserQuestion' }, async ($, e) => {
      seen.push((e.props.questions as { question: string }[])[0]?.question ?? '')
      return { type: 'engine', ref: 0 } as const
    })
    let desktop: { tree: unknown; texts: string[]; buttons: string[] } | null = null
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      desktop = { tree: await ui.drawn(), texts: (await ui.findAll({ type: 'Text' })).map(t => t.text), buttons: (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label)) }
      await ui.unmount()
      const terminal = await $.ui.mount({ plugin: 'kirunak', surface: 'terminal', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      await terminal.unmount()
      return 'Next'
    }
    const { w, text } = await started($, on, draft(TWENTY), [look, 'Back', 'Not', 'Agree'])
    const [first, second] = asksIn(text) as [string, string]
    const m = asksIn(text).length
    await modelAsks($, first, ['Next', 'Not'])
    await modelAsks($, second, ['Next', 'Not', 'Back'])
    await modelAsks($, first, ['Next', 'Not'])
    await modelAsks($, second, ['Next', 'Not', 'Back'])

    const drawn = desktop as unknown as { tree: unknown; texts: string[]; buttons: string[] }
    expect(drawn.texts.slice(0, 5)).toEqual(['Maps that work offline', 'draft', `hub/offline-maps, 20 proposed answers, part 1 of ${m}`, '1. Which of the offline map areas is kept on the phone, as question 1 asks?', 'Proposed: the areas the owner opened in the last month, each kept whole, the oldest dropped first when room runs short.'])
    expect(drawn.buttons).toEqual([])
    expect(treeRows(drawn.tree)).toBeLessThanOrEqual(DIALOG_ROWS)
    // The desktop's engine card asks the part's last line, the terminal the whole part.
    expect(seen).toEqual([`On to part 2 of ${m}, or not?`, first])
    expect(w.lines.slice(2)).toEqual([
      { Next: `part 2 of ${m}`, Not: NOT },
      { Next: `part 3 of ${m}`, Not: NOT, Back: `part 1 of ${m}` },
      { Next: `part 2 of ${m}`, Not: NOT },
      own(['Next', 'Not', 'Back']),
    ])
  })

  test("another dialog of the mod's takes the question away: the same words are the model's again", async ($, on) => {
    const { w } = await started($, on, draft(FOUR), [null, 'Agree'])
    expect(await run($)).toMatch(/^Nothing ran/)
    await modelAsks($, ONE, ['Agree', 'Not'])
    expect(w.lines.at(-1)).toEqual(own(['Agree', 'Not']))
  })
})

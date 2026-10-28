import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HELD, ID, QUEUE, world } from './world'
import type { Tap } from './world'

// The call hook (gulnya/mobile-dialogs AC-14, AC-17, AC-23, D-1): every dialog the mod raises reaches the engine as an
// AskUserQuestion call whose every option carries its line, so the terminal, VS Code, the desktop app and the phone
// (which draws no tree, S-2) all show it; a call the model raised reaches it as it came; and every list asks one short
// line, its rows' words in their choices' lines. The world's own tool.call hook is the engine: it records the call as
// the mod's hooks left it.

const run = async ($: Engine, command: string, origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args: '', origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'

type Option = { label: string; description: string }
type Question = { question: string; header: string; multiSelect: boolean; options: Option[] }

// The model's own AskUserQuestion, as a tool call of its turn.
const modelAsks = ($: Engine, question: Question) => $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'toolu_model', questions: [question] })

// The choices the mod adds to a list, not rows of it, and the rows that are no item's.
const OWN = new Set(['More', 'Back', 'Cancel', 'Earlier', 'Later', 'End of the queue', 'Stop Quad Damage'])

// Walks through every command's dialogs: the command, its taps, and which of its dialogs are lists (by their place in
// the walk), each list its first page and a page after it where it has one.
const WALKS: { command: string; taps: string[]; lists: number[] }[] = [
  { command: 'k-approve', taps: ['hub/proposed', SKIP], lists: [0] },
  { command: 'k-accept', taps: [ID, 'Accept with open items', 'why', SKIP], lists: [0] },
  { command: 'k-amendments', taps: [`${ID} A-3`, 'Decline', 'why', SKIP], lists: [0] },
  { command: 'k-hold', taps: [ID, 'Hold', 'why', SKIP], lists: [0] },
  { command: 'k-resume', taps: ['hub/paused', SKIP], lists: [0] },
  { command: 'k-start', taps: ['More', 'hub/proposed', SKIP], lists: [0, 1] },
  { command: 'k-queue', taps: ['hub/next', 'Move', 'More', ID, SKIP], lists: [0, 2, 3] },
  { command: 'k-queue', taps: ['More', 'hub/parked', SKIP], lists: [0, 1] },
  { command: 'k-board', taps: ['Queued', SKIP], lists: [0, 1] },
  { command: 'k-bugs', taps: ['hub/stale-tiles', 'Drop', 'why', SKIP], lists: [0] },
  { command: 'k-drafts', taps: ['hub/offline-maps', 'Drop', 'why', SKIP], lists: [0] },
]

// Every walk in one world: each dialog with its lines, and the walk it was in.
async function walked($: Engine, on: Parameters<typeof world>[0]) {
  const w = world(on, { rows: [...QUEUE, ...HELD], taps: WALKS.flatMap(x => x.taps) })
  const lists: number[] = []
  for (const x of WALKS) {
    const at = w.asked.length
    await run($, x.command)
    lists.push(...x.lists.map(i => at + i))
  }
  return { w, lists }
}

describe('every choice\'s line in the call (gulnya/mobile-dialogs AC-14, AC-17)', () => {
  test('a dialog the mod raised reaches the engine with a line for every option, in every command\'s dialogs: its lists, its items, its reasons and its confirms', async ($, on) => {
    const { w } = await walked($, on)
    expect(w.asked.length).toBe(WALKS.reduce((n, x) => n + x.taps.length, 0))
    w.asked.forEach((a, i) => {
      const lines = w.lines[i] ?? {}
      expect(Object.keys(lines)).toEqual(a.labels)
      for (const label of a.labels) expect([a.question, label, lines[label]?.trim() ?? '']).not.toContain('')
    })
  })

  test('a call raised again through tool.call for the dialog open now, its options bare, reaches the engine with the lines the mod wrote; one of another question is left as it came', async ($, on) => {
    const bare = (q: Question): Question => ({ ...q, options: q.options.map(o => ({ label: o.label, description: '' })) })
    const other: Question = { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: 'the sea' }] }
    const look: Tap = async questions => {
      const [q] = questions as Question[]
      if (q === undefined) return null
      await $.tool.call({ tool: 'AskUserQuestion', questions: [bare(q)] })
      await $.tool.call({ tool: 'AskUserQuestion', questions: [other] })
      return SKIP
    }
    const w = world(on, { taps: [look, null, null] })
    await run($, 'k-approve')
    expect(w.asked.map(a => a.question)).toEqual(['Waiting for you to approve: Which task?', 'Waiting for you to approve: Which task?', 'Which colour?'])
    expect(w.lines).toEqual([
      { 'hub/proposed': 'proposed', Cancel: 'nothing runs' },
      { 'hub/proposed': 'proposed', Cancel: 'nothing runs' },
      { Red: '', Blue: 'the sea' },
    ])
  })

  test('a dialog the model raised reaches the engine exactly as it came, with no mod dialog open and with one open', async ($, on) => {
    const asked: Question = { question: 'hub/proposed\nApprove it?', header: 'Approve', multiSelect: false, options: [{ label: 'hub/proposed', description: '' }, { label: 'Cancel', description: 'its own words' }] }
    const seen: unknown[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
      seen.push(JSON.parse(JSON.stringify(e.questions)))
      return next(e)
    })
    const look: Tap = async () => {
      await modelAsks($, asked)
      return SKIP
    }
    const w = world(on, { taps: [null, look, null] })
    await modelAsks($, asked)
    await run($, 'k-approve')
    // The model's call, before and while the mod's dialog is open, is what the engine got; the mod's has its lines.
    expect(seen).toEqual([[asked], [expect.objectContaining({ question: 'Waiting for you to approve: Which task?' })], [asked]])
    expect([w.asked[0]?.question, w.lines[0], w.asked[2]?.question, w.lines[2]]).toEqual([asked.question, { 'hub/proposed': '', Cancel: 'its own words' }, asked.question, { 'hub/proposed': '', Cancel: 'its own words' }])
  })
})

describe('a list asks one short line (gulnya/mobile-dialogs AC-23)', () => {
  test('every list\'s question ends on one line that holds no row\'s words, and a list with no text above it is that line alone; each row\'s words are its choice\'s line', async ($, on) => {
    const { w, lists } = await walked($, on)
    expect(lists.length).toBe(WALKS.reduce((n, x) => n + x.lists.length, 0))
    // Rows checked, across the lists: Move's first page holds only Earlier, Later and the end.
    let checked = 0
    for (const i of lists) {
      const a = w.asked[i]
      const lines = w.lines[i] ?? {}
      if (a === undefined) throw new Error(`no dialog ${i}`)
      const ask = a.question.split('\n').at(-1) ?? ''
      // One short line that asks: a head where the list has one, its range on a page, then the question.
      expect([ask, ask.length <= 120]).toEqual([expect.stringMatching(/^[^?]+\?$/), true])
      const rows = a.labels.filter(l => !OWN.has(l))
      checked += rows.length
      for (const label of rows) {
        // A row's words: its name, and its line where it says more than a state (a list's head may name a state,
        // "Tasks on hold", which is no row's words).
        expect(a.question).not.toContain(label)
        const line = lines[label] ?? ''
        if (line.split(/\s+/).length > 2) expect(a.question).not.toContain(line)
        expect(a.question.split('\n')).not.toContain(expect.stringMatching(/^\d+\. /))
      }
    }
    expect(checked).toBeGreaterThan(lists.length)
    // The lists with nothing to say above them: the task lists, the amendments, the bugs, the drafts and a group.
    const alone = lists.filter(i => !/^(Made at |hub\/next: |Quad Damage)/.test(w.asked[i]?.question ?? ''))
    expect(alone.length).toBe(lists.length - 3)
    for (const i of alone) expect(w.asked[i]?.question).not.toContain('\n')
  })
})

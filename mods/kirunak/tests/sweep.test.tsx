import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { BugRow, QuadDamageStatus } from '../hooks/bugs'
import { DIALOG_ROWS, treeRows } from '../hooks/looks'

import { BRIEF, briefOf, DRAFTS, FOUND, HELD, ID, NO_FIX, QUEUE, READY, world } from './world'
import type { Tap } from './world'

// Every dialog of the mod in the desktop app (gulnya/mobile-dialogs S-3): each command's dialogs opened from the
// command and every dialog a choice of one opens, walked breadth first, each drawn on the desktop. Each has its head
// (a title, a chip with its icon and its word), a line under every choice, More, Back and Cancel last, no emoji, at
// most 48 rows folded and in every part unfolded, and a list asks one short line that holds no row's words; each
// choice tapped after the look was drawn answers as that choice. The engine's own drawing is the last hook.

const run = async ($: Engine, command: string): Promise<string> =>
  (await $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

type Option = { label: string; description: string }
type Question = { question: string; header: string; options: Option[] }
type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

const engineBelow = (on: On, seen: Question[][]) => {
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e) => {
    seen.push(e.props.questions as Question[])
    return { type: 'engine', ref: 0 } as const
  })
}

const ENGINE = { type: 'engine', ref: 0 }
const PICTURES = /\p{Extended_Pictographic}/u
// The choices a dialog adds after its own; the mod's own choices that are no row of a list.
const LAST = new Set(['More', 'Back', 'Cancel'])
const OWN = new Set([...LAST, 'Earlier', 'Later', 'End of the queue', 'Stop Quad Damage'])
const REASON = 'Type the reason in the free-text row'
// How deep the walk goes: the longest walk of any command (k-queue's Move, a page, a place) is five taps.
const DEEPEST = 8

const textOf = (n: Node): string => (n.children ?? []).filter(c => typeof c === 'string').join('')
const childrenOf = (n: unknown): Node[] => ((n as Node | null)?.children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)

// What is wrong with a dialog as the desktop draws it, in words; empty when nothing is.
function faults(tree: unknown, q: Question, ask: string | undefined, rowKeys: string[]): string[] {
  const out: string[] = []
  const [head] = childrenOf(tree)
  const [title, chip] = childrenOf(head)
  if (!(title?.type === 'Text' && title.props?.size === 'title' && textOf(title).trim())) out.push('no title')
  const [icon, word] = childrenOf(chip)
  if (!(chip?.type === 'Box' && typeof chip.props?.backgroundColor === 'string' && icon?.type === 'Svg' && String(icon.props?.source ?? '').startsWith('<svg') && String(icon.props?.alt ?? '').trim() && word?.type === 'Text' && textOf(word).trim())) out.push('no chip with its icon and its word')
  const labels = q.options.map(o => o.label)
  for (const o of q.options) if (!o.description?.trim()) out.push(`no line under ${o.label}`)
  const last = labels.findIndex(l => LAST.has(l))
  if (last >= 0 && labels.slice(last).some(l => !LAST.has(l))) out.push(`More, Back and Cancel not last: ${labels.join(' | ')}`)
  if (PICTURES.test(JSON.stringify(tree) + JSON.stringify(q))) out.push('an emoji')
  if (ask === undefined || !/^[^\n?]+\?$/.test(ask) || ask.length > 120) out.push(`asks no one short line: ${ask}`)
  // A list: its rows drawn, its question no row's words.
  if (rowKeys.length) {
    for (const o of q.options.filter(x => !OWN.has(x.label))) {
      if (ask?.includes(o.label)) out.push(`asks a row's id: ${o.label}`)
      if (o.description.split(/\s+/).length > 2 && ask?.includes(o.description)) out.push(`asks a row's words: ${o.description}`)
    }
  }
  return out
}

type Options = NonNullable<Parameters<typeof world>[1]>

// Walks every dialog the command opens; returns each dialog checked, with what is wrong with it.
async function sweep($: Engine, on: On, command: string, more: Options = {}) {
  const taps: Tap[] = []
  const seen: Question[][] = []
  world(on, { rows: [...QUEUE, ...HELD], ...more, taps })
  engineBelow(on, seen)
  const shown = new Set<string>()
  const checked: { where: string; faults: string[] }[] = []
  const unanswered: string[] = []
  const paths: string[][] = [[]]
  while (paths.length) {
    const path = paths.shift() as string[]
    const where = [command, ...path].join(' > ')
    let depth = 0
    let next: string[] = []
    const tap: Tap = async questions => {
      const d = depth++
      if (d < path.length) return path[d] ?? null
      if (d > path.length) return null
      const q = (questions as Question[])[0] as Question
      const labels = q.options.map(o => o.label)
      const signature = JSON.stringify([q.header, q.question, labels])
      if (shown.has(signature)) return null
      shown.add(signature)
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      const tree = await ui.drawn()
      const ask = seen.at(-1)?.[0]?.question
      const rowKeys = (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '').filter(k => k.startsWith('row-'))
      const found = faults(tree, q, ask, rowKeys)
      if (treeRows(tree) > DIALOG_ROWS) found.push(`${treeRows(tree)} rows folded`)
      // Unfolded, each part.
      if (await ui.find({ key: 'kirunak-show-all' })) {
        await ui.press({ key: 'kirunak-show-all' })
        for (let part = 1; part <= 20; part++) {
          const now = treeRows(await ui.drawn())
          if (now > DIALOG_ROWS) found.push(`${now} rows in part ${part}`)
          if (!(await ui.find({ key: 'kirunak-fold-next' }))) break
          await ui.press({ key: 'kirunak-fold-next' })
        }
      }
      await ui.unmount()
      checked.push({ where, faults: found })
      next = q.question.includes(REASON) ? ['why'] : labels.filter(l => l !== 'Back' && l !== 'Cancel')
      // The look drawn, the tap answers as a tap does: the first way on.
      return next[0] ?? null
    }
    taps.length = 0
    for (let i = 0; i < DEEPEST + 4; i++) taps.push(tap)
    const text = await run($, command)
    // Every tap of the walk was one of the dialog's choices (or a reason typed), never words it did not take.
    if (/none of the choices|no reason was typed/.test(text)) unanswered.push(`${where}: ${text.split('\n')[0]}`)
    if (path.length < DEEPEST) for (const l of next) paths.push([...path, l])
  }
  return { checked, unanswered }
}

const expectClean = (r: Awaited<ReturnType<typeof sweep>>, least: number) => {
  expect(r.checked.filter(c => c.faults.length)).toEqual([])
  expect(r.unanswered).toEqual([])
  expect(r.checked.length).toBeGreaterThanOrEqual(least)
}

const MARKED: BugRow[] = [{ ...READY, quadDamage: true }, { ...FOUND, quadDamage: true }, NO_FIX]
const LIVE: QuadDamageStatus = { run: { pid: 5150, bug: 'hub/stale-tiles' }, line: 'Quad Damage runs: hub/stale-tiles, fixing (try 1) since 23:41' }
const json = (x: unknown) => ({ exitCode: 0, stdout: JSON.stringify(x), stderr: '' })

// A board of every kind of group: the one stopped for the owner, the bugs with k waiting's line above them, the
// drafts, and the task groups of BRIEF.
const BUG_ENTRIES = [`${READY.id}: ${READY.title}, fix ready`, `${NO_FIX.id}: ${NO_FIX.title}, no fix yet`]
const MADE = briefOf([
  { name: 'Stopped for you', lines: ['weather/asks-owner: awaiting owner, S-2 asked a question'] },
  ...BRIEF.groups.map(g => ({ name: g.name, lines: g.lines })),
  { name: 'Bugs', lines: BUG_ENTRIES },
  { name: 'Drafts', lines: DRAFTS.slice(0, 2).map(d => `${d.id}: ${d.title}, written ${d.written}`) },
])
const EVERY_GROUP = { ...MADE, groups: MADE.groups.map(g => (g.name === 'Bugs' ? { ...g, lines: ['2 bugs, 1 with a fix ready: /k-bugs', ...BUG_ENTRIES] } : g)) }

describe('every dialog on the desktop (gulnya/mobile-dialogs S-3)', () => {
  // The least each walk must reach: its list and an item, and for a verb that asks why its reason and its confirm.
  const WALKS: [string, number][] = [
    ['k-approve', 2],
    ['k-accept', 4],
    ['k-amendments', 4],
    ['k-hold', 4],
    ['k-resume', 3],
    ['k-start', 3],
    ['k-queue', 6],
    ['k-board', 3],
    ['k-bugs', 5],
    ['k-drafts', 4],
  ]
  for (const [command, least] of WALKS) {
    test(`${command}: every dialog it opens has its head, a line under every choice, More, Back and Cancel last, no emoji, at most 48 rows, one short question, and takes its taps`, async ($, on) => {
      expectClean(await sweep($, on, command), least)
    })
  }

  test('k-board with every kind of group: stopped for you, the tasks, the bugs under k waiting\'s line, the drafts', async ($, on) => {
    expectClean(await sweep($, on, 'k-board', { brief: json(EVERY_GROUP) }), 6)
  })

  test('k-bugs with bugs marked for Quad Damage: its row first', async ($, on) => {
    expectClean(await sweep($, on, 'k-bugs', { bugs: [MARKED] }), 5)
  })

  test('k-bugs with Quad Damage running: its stop and its confirm', async ($, on) => {
    expectClean(await sweep($, on, 'k-bugs', { bugs: [MARKED], quadDamage: [LIVE] }), 5)
  })

  test('on the terminal a dialog with a look draws no tree: the engine draws it', async ($, on) => {
    let drawn: unknown = null
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'terminal', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      drawn = await ui.drawn()
      await ui.unmount()
      return null
    }
    world(on, { rows: [...QUEUE, ...HELD], taps: [ID, look] })
    engineBelow(on, [])
    await run($, 'k-accept')
    expect(drawn).toEqual(ENGINE)
  })
})

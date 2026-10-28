import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { QuadDamageStatus } from '../hooks/bugs'
import { DIALOG_ROWS, messageParts, progressOf, runRowOf, stateOf, treeRows } from '../hooks/looks'
import type { ProgressRow, State } from '../hooks/looks'

import { world } from './world'
import type { Tap } from './world'

// Quad Damage's lines as rows (gulnya/mobile-dialogs S-4, AC-11 to AC-13, AC-17, AC-19, E-2): every progress line
// form, the run's summary and /k-bugs' run line, each drawn on the desktop as a row with its stage's chip and its words
// as written; a line of no form, a message of none and the terminal left as the engine draws them. The lines are
// design/task-files.md's forms ("The run's progress", "The run's end") filled in, written out here: the mod's tests
// read no file of the repo. The engine's own drawing is the test's last hook.

const ENGINE = { type: 'engine', ref: 0 }
const PICTURES = /\p{Extended_Pictographic}/u

const engineBelow = (on: On) => {
  on('ui.render', { component: 'AskUserQuestion' }, async () => ({ type: 'engine', ref: 0 }) as const)
  on('ui.render', { component: 'AssistantMessage' }, async () => ({ type: 'engine', ref: 0 }) as const)
}
const run = async ($: Engine): Promise<string> =>
  (await $.command.run({ command: 'k-bugs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

// A tree as the test kit draws it, plain data, walked here; a key is among its props.
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const kids = (n: unknown): Node[] => ((n as Node | null)?.children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)
const every = (n: unknown): Node[] => (typeof n === 'object' && n !== null ? [n as Node, ...kids(n).flatMap(every)] : [])
const textOf = (n: Node): string => (n.children ?? []).filter(c => typeof c === 'string').join('')
// A row as drawn: its Texts in order, and its icon's alt.
const drawnRow = (n: Node) => ({ texts: every(n).filter(x => x.type === 'Text').map(textOf), alt: every(n).find(x => x.type === 'Svg')?.props?.alt })
// The line a row draws, read back: its time, its id with its colon, its words.
const lineOf = (r: ProgressRow): string => [r.time, r.id === null ? null : `${r.id}:`, r.words].filter(x => x !== null).join(' ')

// Every progress line form (task-files.md, "The run's progress"), its stage and that stage's state (AC-8).
const PROGRESS: [string, string, State][] = [
  ['12:04 hub/stale-tiles: started', 'started', 'running'],
  ['12:04 hub/stale-tiles: started, fix ready, to review', 'started', 'running'],
  ["12:04 hub/stale-tiles: started, try 2 from its review's findings", 'started', 'running'],
  ['12:31 hub/stale-tiles: fix committed 3f2a9c1', 'committed', 'running'],
  ['12:05 weather/rain-gap: skipped: the fault is in a library the repo does not own', 'skipped', 'na'],
  ['12:05 weather/rain-gap: failed: the build did not start', 'failed', 'failed'],
  ['12:48 hub/stale-tiles: review clean, merged 3f2a9c1 into hub', 'merged', 'done'],
  ['12:40 hub/stale-tiles: review found something, try 2', 'fixing', 'running'],
  ['13:10 hub/stale-tiles: waits: its review found something twice', 'waits', 'waits'],
  ['13:12 Quad Damage paused for the 5-hour window until 15:01', 'paused', 'waits'],
  ['15:02 Quad Damage goes on', 'started', 'running'],
  ["15:30 Quad Damage stopped: the week's limit is at 98%", 'stopped', 'failed'],
  ['15:30 Quad Damage done: 1 merged, 1 wait, 0 not reached', 'done', 'done'],
]
// The summary (task-files.md, "The run's end"): its head, done or stopped, then a line a bug.
const SUMMARY: [string, string, State][] = [
  ['Quad Damage, 23:40 to 01:15: 1 merged, 1 wait, 1 not reached', 'done', 'done'],
  ["- hub/stale-tiles: merged 3f2a9c1 into hub's master", 'merged', 'done'],
  ['- weather/rain-gap: waits: its review found something twice', 'waits', 'waits'],
  ['- hub/no-fix: not reached', 'not reached', 'na'],
]
const STOPPED_HEAD = 'Quad Damage, 23:40 to 00:10: 0 merged, 1 wait, 2 not reached; stopped: the owner stopped the run'

// Lines near a form that are none: a wrong time, `started` with a suffix k never writes, an id that is no
// <repo>/<slug>, a merge with no sha, a summary line with no head, and prose that mentions Quad Damage.
const NEAR = [
  '1:04 hub/stale-tiles: started',
  '24:04 hub/stale-tiles: started',
  '12:04 hub/stale-tiles: started, fix not ready',
  '12:04 Note: started',
  '12:48 hub/stale-tiles: review clean, merged into hub',
  '- hub/no-fix: not reached',
  'Quad Damage paused for a while, and goes on at three.',
  '12:04 Quad Damage was quick today',
]

describe("Quad Damage's lines as rows (gulnya/mobile-dialogs S-4)", () => {
  test('every progress line form is a row: its time, its stage, its id, its words as written (AC-11, E-2)', () => {
    for (const [line, stage, state] of PROGRESS) {
      const r = progressOf(line)
      expect({ line, stage: r?.chip.stage, word: r?.chip.word, state: stateOf(r?.chip.stage ?? '') }).toEqual({ line, stage, word: stage, state })
      expect(lineOf(r as ProgressRow)).toBe(line)
      expect(r?.id === null).toBe(line.slice(6).startsWith('Quad Damage'))
    }
  })

  test("the summary's head and each bug line under it are rows, the head done or stopped; its kirunak-push line stays text (AC-13)", () => {
    for (const head of [SUMMARY[0]?.[0] as string, STOPPED_HEAD]) {
      const text = [head, ...SUMMARY.slice(1).map(s => s[0]), `kirunak-push: ${head}. hub/stale-tiles merged; weather/rain-gap waits: its review found something twice; hub/no-fix not reached`].join('\n')
      const parts = messageParts(text) ?? []
      const rows = parts.flatMap(p => ('row' in p ? [p.row] : []))
      expect(rows.map(r => r.chip.stage)).toEqual([head === STOPPED_HEAD ? 'stopped' : 'done', 'merged', 'waits', 'not reached'])
      expect(rows.map(r => stateOf(r.chip.stage))).toEqual([head === STOPPED_HEAD ? 'failed' : 'done', 'done', 'waits', 'na'])
      // Each row reads back as its line, the list's dash its bullet; no time on any.
      expect(rows.map(lineOf)).toEqual([head, ...SUMMARY.slice(1).map(s => s[0].slice(2))])
      expect(rows.map(r => r.time)).toEqual([null, null, null, null])
      expect(parts.at(-1)).toEqual({ text: text.split('\n').at(-1) as string })
    }
    // Blank lines between the head and its lines keep them the summary's; prose ends it.
    const spaced = messageParts(`${SUMMARY[0]?.[0]}\n\n${SUMMARY[1]?.[0]}\n\nThat is all.\n${SUMMARY[3]?.[0]}`) ?? []
    expect(spaced.map(p => ('row' in p ? p.row.chip.stage : p.text))).toEqual(['done', 'merged', `That is all.\n${SUMMARY[3]?.[0]}`])
  })

  test('a line near a form stays the text it is, and a message of such lines goes on as it came (E-2)', async ($, on) => {
    world(on)
    engineBelow(on)
    for (const line of NEAR) {
      expect({ line, row: progressOf(line) }).toEqual({ line, row: null })
      expect({ line, parts: messageParts(line) }).toEqual({ line, parts: null })
    }
    // A form's line inside a code fence is the fence's.
    expect(messageParts(`\`\`\`\n${PROGRESS[0]?.[0]}\n\`\`\``)).toBeNull()
    const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AssistantMessage', props: { text: NEAR.join('\n'), isFirstOfReply: true } })
    expect(await ui.drawn()).toEqual(ENGINE)
    await ui.unmount()
  })

  test('a message mixing rows and prose draws on the desktop, the prose kept in order between the rows (AC-11, AC-13)', async ($, on) => {
    world(on)
    engineBelow(on)
    const lines = [...PROGRESS.slice(6, 7), ...PROGRESS.slice(-1)].map(p => p[0])
    const text = ['Two lines from Quad Damage:', '', ...lines, '', 'Its summary:', '', ...SUMMARY.map(s => s[0]), '', 'Nothing was pushed.'].join('\n')
    const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
    const tree = await ui.drawn()
    const drawn = kids(tree).map(n => (n.type === 'Markdown' ? String(n.props?.text) : drawnRow(n)))
    expect(drawn).toEqual([
      'Two lines from Quad Damage:',
      { texts: ['12:48', 'merged', 'hub/stale-tiles:', 'review clean, merged 3f2a9c1 into hub'], alt: 'merged' },
      { texts: ['15:30', 'done', 'Quad Damage done: 1 merged, 1 wait, 0 not reached'], alt: 'done' },
      'Its summary:',
      { texts: ['done', 'Quad Damage, 23:40 to 01:15: 1 merged, 1 wait, 1 not reached'], alt: 'done' },
      { texts: ['merged', 'hub/stale-tiles:', "merged 3f2a9c1 into hub's master"], alt: 'merged' },
      { texts: ['waits', 'weather/rain-gap:', 'waits: its review found something twice'], alt: 'waits' },
      { texts: ['not reached', 'hub/no-fix:', 'not reached'], alt: 'not reached' },
      'Nothing was pushed.',
    ])
    // The id in bold, the time dim, the chip on its state's fill; no emoji anywhere.
    const first = every(tree).filter(n => n.type === 'Text')
    expect(first.find(n => textOf(n) === 'hub/stale-tiles:')?.props?.weight).toBe('bold')
    expect(first.find(n => textOf(n) === '12:48')?.props?.dimColor).toBe(true)
    expect(JSON.stringify(tree)).not.toMatch(PICTURES)
    await ui.unmount()
  })

  test('every form drawn, one row each, its icon its stage; the terminal and VS Code draw no tree (O-2)', async ($, on) => {
    world(on)
    engineBelow(on)
    const text = [...PROGRESS, ...SUMMARY].map(p => p[0]).join('\n')
    const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
    const rows = kids(await ui.drawn())
    expect(rows.map(n => drawnRow(n).alt)).toEqual([...PROGRESS, ...SUMMARY].map(p => p[1]))
    for (const n of rows) expect(drawnRow(n).texts.at(-1)).not.toBe('')
    await ui.unmount()
    for (const surface of ['terminal', 'vscode'] as const) {
      const plain = await $.ui.mount({ plugin: 'kirunak', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
      expect(await plain.drawn()).toEqual(ENGINE)
      await plain.unmount()
    }
  })

  test("/k-bugs with a live run: the run's line a row of the list's head, in each form k prints, the question unchanged, within 48 rows (AC-12, AC-19)", async ($, on) => {
    const at = (run: QuadDamageStatus['run'], line: string): QuadDamageStatus => ({ run, line })
    const lives = [
      [at({ pid: 5150, bug: 'hub/stale-tiles' }, 'Quad Damage runs: hub/stale-tiles, fixing (try 1) since 23:41'), 'fixing'],
      [at({ pid: 5150, bug: 'hub/stale-tiles', phase: 'reviewing' }, 'Quad Damage runs: hub/stale-tiles, reviewing since 23:58'), 'reviewing'],
      [at({ pid: 5150, bug: 'hub/stale-tiles', phase: 'merging' }, 'Quad Damage runs: hub/stale-tiles, merging since 23:59'), 'reviewing'],
      [at({ pid: 5150, bug: null }, 'Quad Damage runs, between bugs, since 23:40'), 'started'],
      [at({ pid: 5150, bug: 'hub/stale-tiles', phase: 'waiting', waitUntil: '2026-11-08T01:15:00+00:00' }, 'Quad Damage waits for the 5-hour window until 01:15'), 'paused'],
    ] as const
    const drawn: unknown[] = []
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      drawn.push(await ui.drawn())
      await ui.unmount()
      return null
    }
    const w = world(on, { quadDamage: lives.map(l => l[0]), taps: lives.map(() => look) })
    engineBelow(on)
    for (let i = 0; i < lives.length; i++) await run($)

    expect(drawn.length).toBe(lives.length)
    lives.forEach(([live, stage], i) => {
      const tree = drawn[i]
      const [head] = kids(tree)
      const row = kids(head).find(n => n.props?.key === 'run')
      expect(row && drawnRow(row)).toEqual({ texts: [stage, live.line], alt: stage })
      // The head's chip paused, orange, while the run waits for the window, as its row is (AC-8); else running.
      const chip = kids(head).find(n => n.props?.key === 'chip')
      expect(chip && drawnRow(chip)).toEqual(stage === 'paused' ? { texts: ['Quad Damage waits'], alt: 'paused' } : { texts: ['Quad Damage runs'], alt: 'started' })
      // The line is the row alone, never again as the first line; the question as k asked it.
      expect(every(tree).filter(n => n.type === 'Text' && textOf(n).startsWith(live.line)).map(textOf)).toEqual([live.line])
      expect(w.asked[i]?.question).toBe(`${live.line}.\nBugs, a fix ready first, then the oldest: Stop Quad Damage, or which bug?`)
      expect(treeRows(tree)).toBeLessThanOrEqual(DIALOG_ROWS)
    })
    expect(runRowOf('Quad Damage is not running')).toBeNull()
  })

  test("/k-bugs with a run line of no form k prints: no row, the line its first line as written (E-2)", async ($, on) => {
    let tree: unknown = null
    const look: Tap = async questions => {
      const ui = await $.ui.mount({ plugin: 'kirunak', surface: 'desktop', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions } })
      tree = await ui.drawn()
      await ui.unmount()
      return null
    }
    const odd = 'Quad Damage runs: hub/stale-tiles, null since 23:41'
    world(on, { quadDamage: [{ run: { pid: 5150, bug: 'hub/stale-tiles' }, line: odd }], taps: [look] })
    engineBelow(on)
    await run($)
    expect(every(tree).some(n => n.props?.key === 'run')).toBe(false)
    expect(every(tree).filter(n => n.type === 'Text').map(textOf)).toContain(`${odd}.`)
    expect(treeRows(tree)).toBeLessThanOrEqual(DIALOG_ROWS)
  })
})

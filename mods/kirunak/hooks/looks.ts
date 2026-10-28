import type { KirunakChip, KirunakLook, KirunakSection } from '../types'

// The parts of the mod's look on the phone and the desktop app (gulnya/mobile-dialogs D-1, D-2), plain data, so the
// render hooks (look.tsx) only lay them out and the tests reach every one without a surface: the five states, each
// stage's state and icon, the rows a tree takes, the date words, a long text's parts, and the progress lines drawn as
// rows.

// The five states (AC-8): a fill and the ink on it. The chip carries its own ground, so the pair reads the same in
// the phone's light and dark themes; each holds 4.5:1 or more (AC-7, AC-20; the test computes WCAG's ratio).
export type State = 'done' | 'running' | 'na' | 'waits' | 'failed'
export const STATES: Record<State, { fill: string; ink: string }> = {
  done: { fill: '#1b7a3a', ink: '#ffffff' },
  running: { fill: '#f2c200', ink: '#1f1f1f' },
  na: { fill: '#6e6e6e', ink: '#ffffff' },
  waits: { fill: '#e8710a', ink: '#1f1f1f' },
  failed: { fill: '#c62828', ink: '#ffffff' },
}

// Each stage's state (AC-8, AC-9): running while it fixes, commits or reviews; done once merged; waits for the owner
// while it waits or is paused; failed when it stopped or failed; n/a when skipped or not reached.
export const STAGES = {
  started: 'running',
  fixing: 'running',
  committed: 'running',
  reviewing: 'running',
  merged: 'done',
  done: 'done',
  waits: 'waits',
  paused: 'waits',
  stopped: 'failed',
  failed: 'failed',
  skipped: 'na',
  'not reached': 'na',
} as const satisfies Record<string, State>
export type Stage = keyof typeof STAGES

export const stateOf = (stage: string): State => (STAGES as Record<string, State>)[stage] ?? 'na'

// A task's state as k names it (lib/state.mjs) as a chip (AC-8): the stage nearest it, the state itself the word.
// Running while a session works on it or reviews it; done once done; waits for the owner while it is proposed,
// reviewed or awaits the owner, and while it is parked or on hold, which the owner lifts; failed when it is blocked or
// stale; not reached while it is a draft or queued, waiting its turn and no one's choice. A state of no known name is
// not reached.
const TASK_STAGES: Readonly<Record<string, Stage>> = {
  draft: 'not reached',
  proposed: 'waits',
  queued: 'not reached',
  parked: 'paused',
  blocked: 'stopped',
  'in progress': 'started',
  'in review': 'reviewing',
  reviewed: 'waits',
  'awaiting owner': 'waits',
  done: 'done',
  'on hold': 'paused',
  stale: 'failed',
}
export const taskChip = (state: string): KirunakChip => ({ stage: TASK_STAGES[state] ?? 'not reached', word: state })

// Each stage's glyph on a 16 by 16 disc, drawn in the ink: lines, and a shape filled where it says so.
const GLYPHS: Record<Stage, string> = {
  started: '<path d="M6.3 4.6v6.8L11.6 8z" fill="INK"/>',
  fixing: '<path d="M4.8 11.2l3.8-3.8"/><circle cx="10" cy="6" r="2"/>',
  committed: '<circle cx="8" cy="8" r="2.3"/><path d="M3.4 8h2.3M10.3 8h2.3"/>',
  reviewing: '<circle cx="7.2" cy="7.2" r="2.7"/><path d="M9.2 9.2l2.4 2.4"/>',
  merged: '<path d="M5 4.6l3 3.4 3-3.4M8 8v3.8"/>',
  done: '<path d="M4.7 8.3l2.2 2.2 4.4-4.7"/>',
  waits: '<circle cx="8" cy="8" r="3.8"/><path d="M8 5.8V8l1.6 1.2"/>',
  paused: '<path d="M6.4 5v6M9.6 5v6"/>',
  stopped: '<rect x="5.3" y="5.3" width="5.4" height="5.4" rx="0.6" fill="INK"/>',
  failed: '<path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"/>',
  skipped: '<path d="M5 4.8v6.4L9.2 8z" fill="INK"/><path d="M11 4.8v6.4"/>',
  'not reached': '<path d="M5 8h6"/>',
}

// A stage's icon (AC-6, AC-9): a disc in its state's fill, its glyph in the ink, as an Svg's source; the word beside
// it carries the stage, so colour is never the only sign. A stage of no known name draws as not reached.
export function iconOf(stage: string): string {
  const { fill, ink } = STATES[stateOf(stage)]
  const glyph = (GLYPHS as Record<string, string>)[stage] ?? GLYPHS['not reached']
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16">' +
    `<circle cx="8" cy="8" r="8" fill="${fill}"/>` +
    `<g fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph.replaceAll('INK', ink)}</g>` +
    '</svg>'
  )
}

// The rows a dialog's tree may take (AC-19): 48 on the phone, the desktop app and VS Code, counted at 40 columns, as
// the engine counts them: a row a line, and one more for each 40 characters of it. Counted the same way here.
export const COLUMNS = 40
export const DIALOG_ROWS = 48
export const rowsOf = (text: string): number => text.split('\n').reduce((n, line) => n + 1 + Math.floor([...line].length / COLUMNS), 0)

// The rows a tree as drawn takes (the test kit's plain data): a Text's words, a Button's label, an Svg's alt, a
// Markdown's text, each by rowsOf, and a Box's gap a row for each of its children, in a row or a column: the test kit
// counts a gap too (measured 2026-10-28: 48 lines fit alone, 23 with gap={1} between them), and in a row it is
// counted as if a column, which may be more than the engine counts, never less. The engine's own node is the engine's.
export function treeRows(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0
  const { type, props = {}, children = [] } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  if (type === 'Text') return rowsOf(children.filter(c => typeof c === 'string').join(''))
  if (type === 'Button') return rowsOf(String(props.label ?? ''))
  if (type === 'Svg') return rowsOf(String(props.alt ?? ''))
  if (type === 'Markdown') return rowsOf(String(props.text ?? ''))
  const gap = typeof props.gap === 'number' ? props.gap : props.gap === undefined ? 0 : 1
  return children.reduce<number>((n, c) => n + treeRows(c), gap * children.length)
}

// A date as the head says it (AC-1): "today", "yesterday", "Oct 27", with its year when it is not this year's;
// `date` as k writes one (2026-10-27, or a time after it), the day as written; `now` this machine's clock. Null for
// no date, the date itself for one it cannot read.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dateWord(date: string | null, now: number): string | null {
  if (date === null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return date
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const today = new Date(now)
  const days = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, mo - 1, d)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${MONTHS[mo - 1] ?? mo} ${d}${y === today.getFullYear() ? '' : `, ${y}`}`
}

// A text as a look's first lines say it (AC-3, AC-10): whole up to `most` characters, else cut at the last sentence's
// end before them, or at `most`, and " ..." after it; Show all shows it whole.
export function clipped(text: string, most = 400): string {
  if (text.length <= most) return text
  const end = text.slice(0, most).search(/[.!?](?=[^.!?]*$)/)
  return end > 0 ? `${text.slice(0, end + 1)} ...` : `${text.slice(0, most)} ...`
}

// A confirm's look after a reason was typed (AC-1): the item's head, then the reason under its heading, as the question
// asked under it says "for that reason"; a long one cut, whole behind Show all, after `fold`, what else the confirm says.
export function reasonLook(head: KirunakLook, why: string, fold: readonly KirunakSection[] = []): KirunakLook {
  const short = clipped(why)
  const rest = [...(short !== why ? [{ heading: 'Reason', lines: [why] }] : []), ...fold]
  return { ...head, first: [{ heading: 'Reason', lines: [short] }], rows: [], fold: rest.length ? rest : null }
}

// A line of an unfolded text as drawn: a heading, a line of its words, or the blank line between two sections.
export type FoldLine = { text: string; heading: boolean }

// Sections as the lines of an unfolded text, a blank line between two (AC-4).
export function foldLines(sections: readonly KirunakSection[]): FoldLine[] {
  const out: FoldLine[] = []
  for (const s of sections) {
    if (out.length) out.push({ text: '', heading: false })
    if (s.heading !== null) out.push({ text: s.heading, heading: true })
    for (const line of s.lines) out.push({ text: line, heading: false })
  }
  return out
}

// A long unfolded text in parts of at most `budget` rows each (E-1), in order, so nothing is cut and no part goes
// over: a line longer than a part alone goes in pieces at a word where one is near; a part starts on no blank line,
// and a heading last in a part goes on to the next.
export function parts(lines: readonly FoldLine[], budget: number): FoldLine[][] {
  const most = Math.max(1, budget) * COLUMNS - 1
  const pieces: FoldLine[] = []
  for (const l of lines) {
    let rest = l.text
    while ([...rest].length > most) {
      const cut = [...rest].slice(0, most).join('')
      const at = cut.lastIndexOf(' ')
      const end = at > most / 2 ? at : cut.length
      pieces.push({ text: rest.slice(0, end), heading: l.heading })
      rest = rest.slice(end).trimStart()
    }
    pieces.push({ text: rest, heading: l.heading })
  }
  const out: FoldLine[][] = [[]]
  let used = 0
  for (const p of pieces) {
    let part = out[out.length - 1] as FoldLine[]
    const rows = rowsOf(p.text)
    if (used + rows > budget && part.length) {
      const carried = part[part.length - 1]?.heading ? [part.pop() as FoldLine] : []
      part = [...carried]
      out.push(part)
      used = carried.reduce((n, c) => n + rowsOf(c.text), 0)
    }
    if (!p.text && !part.length) continue
    part.push(p)
    used += rows
  }
  return out.filter(p => p.length)
}

// A Quad Damage progress line drawn as a row (gulnya/quad-damage AC-16, this task's AC-11): `HH:MM <id>: started`, as
// k writes it once a bug's first session passes the limits, with `, fix ready, to review` or `, try N from its
// review's findings` (design/task-files.md). Its words stay as written; its stage gives its chip. S-1 reads this one
// form (D-3's spike); the others come in S-2, and a line of none stays as the text it is (E-2).
export type ProgressRow = { time: string; id: string; words: string; chip: KirunakChip }
const STARTED = /^(\d\d:\d\d) (\S+): (started(?:, fix ready, to review|, try \d+ from its review's findings)?)$/

export function progressOf(line: string): ProgressRow | null {
  const m = STARTED.exec(line.trim())
  return m ? { time: m[1] as string, id: m[2] as string, words: m[3] as string, chip: { stage: 'started', word: 'started' } } : null
}

// A message's text as rows and the text between them, in order; null when no line of it is a progress line, so the
// message draws as it is.
export type MessagePart = { row: ProgressRow } | { text: string }
export function messageParts(text: string): MessagePart[] | null {
  const out: MessagePart[] = []
  let between: string[] = []
  const flush = () => {
    const t = between.join('\n').trim()
    if (t) out.push({ text: t })
    between = []
  }
  for (const line of text.split('\n')) {
    const row = progressOf(line)
    if (row === null) between.push(line)
    else {
      flush()
      out.push({ row })
    }
  }
  flush()
  return out.some(p => 'row' in p) ? out : null
}

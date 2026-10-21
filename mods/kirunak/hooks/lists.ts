import type { KirunakRow } from '../types'
import { stepOf } from './board'
import type { AmendmentRow } from './waiting'

// The lists the mod's commands answer with, which the phone draws as markdown (AC-1, AC-2): numbered, no table, one
// line per entry, never broken inside it (the phone wraps a line itself; a line the mod broke at 70 characters landed
// mid-sentence there, S-10), and text from the task files escaped so it shows as written. A list is built in two
// halves: what a row says, as an Item of plain words (taskItem, amendmentItem), and how rows are drawn (`numbered` for
// an answer; `plainLines` and the labels for a choice dialog, whose question shows plain lines and whose choices are
// short names, kirunak-phone S-6).

// A row as plain words: `lead`, then `name` (the row's id, bold in an answer), then `text`.
export type Item = { lead: string; name: string; text: string }

// lib/board-md.mjs's escape and line starts, so an answer reads as the board does.
const md = (s: string): string => s.replace(/[\\`*_<>[\]]/g, '\\$&')
const lead = (w: string): string => (/^\d{1,9}[.)]$/.test(w) ? `${w.slice(0, -1)}\\${w.slice(-1)}` : /^[-=+#]+$/.test(w) ? `\\${w}` : w)

// Markdown text as one line, after `first` ('- ', '1. ' or ''), its spaces made single; a first word that would start
// the line as a list marker, a heading or a rule shows as itself.
export function entry(text: string, first = ''): string {
  const [head, ...rest] = text.split(/\s+/).filter(Boolean)
  return head === undefined ? first.trimEnd() : [first + lead(head), ...rest].join(' ')
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)

// The rows as a numbered markdown list, each row's name in bold.
export function numbered(items: readonly Item[], from = 1): string[] {
  return items.map((x, i) => entry(`${md(x.lead)}**${md(x.name)}**${md(x.text)}`, `${from + i}. `))
}

// The rows as numbered plain lines, one each, for a dialog's question, which draws no markdown.
export const plainLines = (items: readonly Item[], from = 1): string[] => items.map((x, i) => `${from + i}. ${x.lead}${x.name}${x.text}`)

// A dialog's question with the markdown marks left out: the dialog draws no markdown, so a mark shows as typed (the
// owner's phone at S-1 and S-10: the backticks around `/k-queue` in /k-amendments). Backticks and ** go wherever they
// are, * around words, and a heading's leading #; a lone * stays, as it is no mark.
export const unmarked = (text: string): string =>
  text
    .split('\n')
    .map(l => l.replace(/^(\s*)#{1,6}(?:\s+|$)/, '$1').replace(/`|\*\*/g, '').replace(/(^|[^\p{L}\p{N}*])\*(?=[^\s*])([^*]*?[^\s*])?\*(?![\p{L}\p{N}*])/gu, '$1$2'))
    .join('\n')

// A task as k list shows it (AC-1): state and queue place, id, title, and the step as the pane shortens it.
export type ListRow = Pick<KirunakRow, 'id' | 'title' | 'state' | 'queue' | 'step'>

export function taskItem(r: ListRow): Item {
  const step = stepOf(r.step)
  const title = r.title.replace(/\s+/g, ' ').trim()
  return {
    lead: `${r.state}${r.queue !== null ? `, queue place ${r.queue}` : ''}, `,
    name: r.id,
    text: `${title ? `: ${sentence(title)}` : '.'}${step !== null ? ` Step: ${sentence(step)}` : ''}`,
  }
}

// A dialog's choice for a task: its id, unique in the list; one starting with a digit (repo "2048") shows after the
// app's own number, which is cosmetic (S-1).
export const taskLabel = (r: { id: string }): string => r.id

// `/k-list [all]`: every task k list gives, in its order (the queue first).
export function listText(rows: readonly ListRow[], all: boolean): string {
  if (!rows.length) return all ? 'No task in the workspace.' : 'No open task: every task is done or on hold. /k-list all shows them.'
  const head = all ? `${plural(rows.length, 'task')}, done and on hold among them, the queue first:` : `${plural(rows.length, 'task')} not done and not on hold, the queue first:`
  return [head, '', ...numbered(rows.map(taskItem)), ...(all ? [] : ['', '/k-list all adds the done and on hold.'])].join('\n')
}

// What a queue verb printed (`k queue show`'s lines, " 1  <id>"), as a numbered list; anything else as k said it.
export function queueNow(stdout: string): string {
  const ids = stdout.trim().split('\n').map(l => /^\s*\d+\s+(\S+)\s*$/.exec(l)?.[1])
  if (ids.some(id => id === undefined)) return stdout.trim()
  return ['The queue now:', '', ...ids.map((id, i) => `${i + 1}. ${md(id as string)}`)].join('\n')
}

// `k board --markdown` less its first heading, which names kirunak as the engine's prefix to the answer already does
// (AC-12), and the blank line under it.
export const boardText = (markdown: string): string => markdown.replace(/^# .*\n(?:[ \t]*\n)?/, '').trimEnd()

// What k approve would refuse, less the id and A-n it starts with, as k waiting's own line shortens it.
function refuseOf(x: AmendmentRow): string | null {
  if (x.refuse === null) return null
  const own = x.refuse.startsWith(x.id) ? x.refuse.slice(x.id.length).replace(/^:?\s+/, '') : x.refuse
  return own.startsWith(`${x.amendment} `) ? own.slice(x.amendment.length + 1) : own
}

// An amendment waiting for approval (AC-2): task id and A-n, date proposed, the first sentence of its Why, the lines
// it changes, and what `k approve --amendment` would refuse.
export function amendmentItem(x: AmendmentRow): Item {
  const refuse = refuseOf(x)
  return {
    lead: '',
    name: `${x.id} ${x.amendment}`,
    text: `, proposed ${x.proposed ?? 'on no date'}: ${x.why ?? 'no Why.'} Changes ${plural(x.lines, 'line')}.${refuse !== null ? ` Not yet: ${refuse}` : ''}`,
  }
}

// A dialog's choice for an amendment: its id and A-n.
export const amendmentLabel = (x: AmendmentRow): string => `${x.id} ${x.amendment}`

// `/k-amendments`: the amendments waiting, numbered as `/k-amendments <n>` and `/k-approve-amendment <n>` take them.
export function amendmentsText(rows: readonly AmendmentRow[]): string {
  if (!rows.length) return 'No amendment waits for your approval.'
  const head = `${plural(rows.length, 'amendment')} ${rows.length === 1 ? 'waits' : 'wait'} for your approval:`
  return [head, '', ...numbered(rows.map(amendmentItem)), '', '/k-amendments 1 shows the first in full; /k-approve-amendment 1 approves it.'].join('\n')
}

// An amendment file's front matter and its Why and Changes, the lines as written.
export function amendmentParts(text: string): { front: Record<string, string>; why: string[]; changes: string[] } {
  const lines = text.replace(/\r/g, '').split('\n')
  const front: Record<string, string> = {}
  let i = 0
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i] as string)
      if (m) front[m[1] as string] = (m[2] as string).trim()
    }
    i++
  }
  const why: string[] = []
  const changes: string[] = []
  let section: string[] | null = null
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) section = h[1] === 'Why' ? why : h[1] === 'Changes' ? changes : null
    else section?.push(line)
  }
  return { front, why, changes }
}

// `/k-amendments <n>`: the amendment's Why and Changes in full, from its file, and what the list said k would refuse;
// one applied or declined since the list was shown says so.
export function amendmentText(n: number, x: AmendmentRow, file: string): string {
  const { front, why, changes } = amendmentParts(file)
  const paragraphs = why.join('\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const ops = changes.map(l => l.trim()).filter(Boolean)
  const by = front.by ?? x.by
  const refuse = refuseOf(x)
  const stamp = front.applied ? `Applied on ${front.applied} since the list was shown.` : front.declined ? `Declined since the list was shown: ${front.declined}` : null
  return [
    entry(md(`${x.id} ${x.amendment}, proposed ${front.proposed ?? x.proposed ?? 'on no date'}${by ? ` by ${by}` : ''}, changes ${plural(ops.length, 'line')}.`)),
    '',
    'Why:',
    '',
    ...(paragraphs.length ? paragraphs.flatMap((p, i) => [...(i ? [''] : []), entry(md(p))]) : ['(empty)']),
    '',
    'Changes:',
    '',
    ...(ops.length ? ops.map(op => (op.startsWith('- ') ? entry(md(op.slice(2)), '- ') : entry(md(op)))) : ['(none)']),
    '',
    entry(stamp !== null ? md(stamp) : refuse !== null ? `Not yet: ${md(refuse)}` : `/k-approve-amendment ${n} approves it.`),
  ].join('\n')
}

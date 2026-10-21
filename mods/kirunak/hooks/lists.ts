import type { KirunakRow } from '../types'
import { stepOf } from './board'

// The lists the mod's commands answer with, which the phone draws as markdown (AC-1, AC-2): numbered, no table, no
// line longer than WIDTH characters but one holding a single word too long to break (an id), and text from the task
// files escaped so it shows as written. A list is built in two halves: what a row says, as an Item of plain words
// (taskItem), and how rows are drawn (`numbered` for an answer; `plainLines` and the labels for a
// choice dialog, whose question shows plain lines and whose choices are short names, kirunak-phone S-6).

export const WIDTH = 70

// A row as plain words: `lead`, then `name` (the row's id, bold in an answer), then `text`.
export type Item = { lead: string; name: string; text: string }

// lib/board-md.mjs's escape and line starts, so an answer reads as the board does.
const md = (s: string): string => s.replace(/[\\`*_<>[\]]/g, '\\$&')
const lead = (w: string): string => (/^\d{1,9}[.)]$/.test(w) ? `${w.slice(0, -1)}\\${w.slice(-1)}` : /^[-=+#]+$/.test(w) ? `\\${w}` : w)

// Markdown text in lines of at most `width`, the first after `first` ('- ', '1. ' or ''), the rest indented under it;
// a word that would start a line as a list marker, a heading or a rule shows as itself.
export function wrap(text: string, first = '', width = WIDTH): string[] {
  const rest = ' '.repeat(first.length)
  const out: string[] = []
  let line: string | null = null
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === null) line = first + lead(word)
    else if (line.length + 1 + word.length > width) {
      out.push(line)
      line = rest + lead(word)
    } else line += ` ${word}`
  }
  out.push(line ?? first.trimEnd())
  return out
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)

// The rows as a numbered markdown list, each row's name in bold.
export function numbered(items: readonly Item[], from = 1): string[] {
  return items.flatMap((x, i) => wrap(`${md(x.lead)}**${md(x.name)}**${md(x.text)}`, `${from + i}. `))
}

// The rows as numbered plain lines, one each, for a dialog's question, which draws no markdown.
export const plainLines = (items: readonly Item[], from = 1): string[] => items.map((x, i) => `${from + i}. ${x.lead}${x.name}${x.text}`)

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

// A dialog's choice for a task: its short name, unique in the list and never starting with a number (the app numbers
// the choices).
export const taskLabel = (r: { id: string }): string => r.id

// `/k-list [all]`: every task k list gives, in its order (the queue first).
export function listText(rows: readonly ListRow[], all: boolean): string {
  if (!rows.length) return all ? 'No task in the workspace.' : 'No open task: every task is done or on hold. /k-list all shows them.'
  const head = all ? `${plural(rows.length, 'task')}, done and on hold among them, the queue first:` : `${plural(rows.length, 'task')} not done and not on hold, the queue first:`
  return [head, '', ...numbered(rows.map(taskItem)), ...(all ? [] : ['', '/k-list all adds the done and on hold.'])].join('\n')
}

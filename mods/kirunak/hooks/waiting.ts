import type { PromptAutocompleteSuggestion } from 'claude-code'

import type { KirunakRow } from '../types'

// What waits for the owner, as `k waiting --json` gives it: why is what the verb would refuse, null when it would not;
// an accept row's onlyChecklist says open checklist items are all that stops it (`--checklist-open` would run).
export type WaitingRow = { id: string; title: string; state?: string; why: string | null; review?: { file: string; verdict: string | null } | null; checklistOpen?: number; onlyChecklist?: boolean }
// An amendment neither applied nor declined (kirunak-phone S-4): refuse is what k approve --amendment would refuse, one
// line, null when it would not; file the amendment's absolute path; title is the task's, name the amendment's own few
// words, or the criteria it changes when it has none ("replaces AC-5", kirunak-phone A-8).
export type AmendmentRow = {
  id: string
  amendment: string
  title: string
  name: string
  proposed: string | null
  by: string | null
  why: string | null
  lines: number
  refuse: string | null
  file: string
}
// A task k hold or k start would take, with its state as k list says it.
export type TaskRow = { id: string; title: string; state: string }
export type Waiting = { approve: WaitingRow[]; accept: WaitingRow[]; amendments: AmendmentRow[]; hold: TaskRow[]; start: TaskRow[] }

// `/k-approve` or `/k-accept` with no id: the tasks waiting for that verb, numbered as `/k-accept <n>` takes them.
export function offerText(verb: 'approve' | 'accept', rows: readonly WaitingRow[]): string {
  if (!rows.length) return `Nothing waits for you to ${verb}.`
  // k waiting's own words: the verb's, never a task's state (kirunak-phone AC-15).
  const state = (r: WaitingRow) => (r.why === null ? `can ${verb}${r.review ? ` (${r.review.file})` : ''}` : `not yet: ${r.why.split('\n')[0]}`)
  const how = verb === 'accept'
    ? '/k-accept 1 accepts the first. Add --checklist-open "<why>" to accept one with checklist items open.'
    : '/k-approve 1 approves the first.'
  return [`Waiting for you to ${verb}:`, ...rows.map((r, i) => `${String(i + 1).padStart(3)}  ${r.id}  ${state(r)}`), how].join('\n')
}

// The row a line's leading number names in the list the owner was last shown in this session (`shownBy` shows it),
// and the rest of the line, so a list that changed since cannot move the number onto another row (E-2). Null when the
// line does not start with a number.
export function nth<T>(args: string, offered: readonly T[] | undefined, shownBy = 'the command with no id'): { n: number; row: T; rest: string } | { problem: string } | null {
  const m = /^\s*([1-9]\d*)(?=\s|$)/.exec(args)
  if (!m) return null
  const n = Number(m[1])
  if (offered === undefined) return { problem: `${n} of which list? ${shownBy} shows it first` }
  const row = offered[n - 1]
  if (row === undefined) return { problem: `the list you were shown has no ${n}` }
  return { n, row, rest: args.slice(m[0].length) }
}

// `2 --checklist-open "..."` as `<the second id offered> --checklist-open "..."`.
export function byNumber(args: string, offered: readonly string[] | undefined): { args: string } | { problem: string } | null {
  const picked = nth(args, offered)
  return picked === null || 'problem' in picked ? picked : { args: picked.row + picked.rest }
}

// Which tasks each command's typeahead offers, by state (lib/state.mjs); one awaiting the owner with no review asked a
// question in progress, and is nothing to accept (review G26).
const FITS: Record<string, (r: KirunakRow) => boolean> = {
  'k-approve': r => r.state === 'proposed',
  'k-accept': r => (r.state === 'reviewed' || r.state === 'awaiting owner') && r.review !== null,
  'k-hold': r => r.state !== 'done' && r.state !== 'on hold',
  'k-start': r => r.state !== 'done' && r.state !== 'on hold',
}

// The typeahead's rows while the person types a command's task id, from the last read's rows.
export function idSuggestions(text: string, start: number, token: string, rows: readonly KirunakRow[]): PromptAutocompleteSuggestion[] {
  const m = /^\/(k-approve|k-accept|k-hold|k-start) +$/.exec(text.slice(0, start))
  const fits = m ? FITS[m[1] as string] : undefined
  if (fits === undefined) return []
  return rows.filter(r => fits(r) && r.id.startsWith(token)).map(r => ({ text: r.id, description: `${r.state}: ${r.title}` }))
}

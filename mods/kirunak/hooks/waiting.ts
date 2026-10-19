import type { PromptAutocompleteSuggestion } from 'claude-code'

import type { KirunakRow } from '../types'

// What waits for the owner, as `k waiting --json` gives it: why is what the verb would refuse, null when it would not.
export type WaitingRow = { id: string; title: string; why: string | null; review?: { file: string; verdict: string | null } | null }
export type Waiting = { approve: WaitingRow[]; accept: WaitingRow[] }

// `/k-approve` or `/k-accept` with no id: the tasks waiting for that verb, numbered as `/k-accept <n>` takes them.
export function offerText(verb: 'approve' | 'accept', rows: readonly WaitingRow[]): string {
  if (!rows.length) return `Nothing waits for you to ${verb}.`
  const state = (r: WaitingRow) => (r.why === null ? `ready${r.review ? ` (${r.review.file})` : ''}` : `not yet: ${r.why.split('\n')[0]}`)
  const how = verb === 'accept'
    ? '/k-accept 1 accepts the first. Add --checklist-open "<why>" to accept one with checklist items open.'
    : '/k-approve 1 approves the first.'
  return [`Waiting for you to ${verb}:`, ...rows.map((r, i) => `${String(i + 1).padStart(3)}  ${r.id}  ${state(r)}`), how].join('\n')
}

// `2 --checklist-open "..."` as `<the second id offered> --checklist-open "..."`, from the list the owner was last
// shown in this session, so a list that changed since cannot move the number onto another task. Null when the line
// does not start with a number.
export function byNumber(args: string, offered: readonly string[] | undefined): { args: string } | { problem: string } | null {
  const m = /^\s*([1-9]\d*)(?=\s|$)/.exec(args)
  if (!m) return null
  const n = Number(m[1])
  if (offered === undefined) return { problem: `${n} of which list? the command with no id shows it first` }
  const id = offered[n - 1]
  if (id === undefined) return { problem: `the list you were shown has no ${n}` }
  return { args: id + args.slice(m[0].length) }
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

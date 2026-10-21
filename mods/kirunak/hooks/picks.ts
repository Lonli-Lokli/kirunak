import { amendmentItem, amendmentLabel, taskLabel } from './lists'
import type { Item } from './lists'
import type { Choice, Screen } from './owner'
import type { AmendmentRow, WaitingRow } from './waiting'

// The dialogs of /k-approve, /k-accept and /k-amendments with no number (kirunak-phone AC-3, AC-8, AC-9, E-4): the
// list of what waits, then the one picked, in its own words, with the verb k would take now and none it would refuse.
// Each verb runs by id, so a list that changed since ends in k's refusal, never on another row (E-2).

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)
const titleOf = (r: { title: string }): string => r.title.replace(/\s+/g, ' ').trim()

// What k would refuse, line by line, less the id its first line starts with.
function refusalLines(id: string, why: string): string[] {
  const lines = why.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.map((l, i) => (i === 0 && l.startsWith(`${id}: `) ? l.slice(id.length + 2) : l))
}

// A task k waiting offers a verb on, as a list row: id, title, and whether k would take the verb now.
export function waitingItem(verb: 'approve' | 'accept', r: WaitingRow): Item {
  const first = r.why === null ? null : refusalLines(r.id, r.why)[0]
  return { lead: '', name: r.id, text: `: ${sentence(titleOf(r))} ${first == null ? `Can ${verb}.` : `Not yet: ${sentence(first.replace(/:$/, ''))}`}` }
}

// The task picked, in full: id and title, its review, and what k would refuse, every line of it.
function taskText(verb: 'approve' | 'accept', r: WaitingRow): string[] {
  return [
    `${r.id}: ${sentence(titleOf(r))}`,
    ...(r.review ? [`Review: ${r.review.file}${r.review.verdict ? `, ${r.review.verdict}` : ''}.`] : []),
    ...(r.why === null ? [`k would ${verb} it now.`] : ['Not yet:', ...refusalLines(r.id, r.why)]),
  ]
}

const REFUSED = 'k would refuse it now. Back to the list?'

export function approveScreen(rows: readonly WaitingRow[]): Screen {
  const item = (r: WaitingRow): Screen => ({
    kind: 'item',
    header: 'Approve',
    text: taskText('approve', r),
    choices: r.why === null ? [{ label: `Approve ${r.id}`, verb: ['approve', r.id, '--via', 'mod'] }] : [],
    question: r.why === null ? 'Approve it?' : REFUSED,
  })
  return { kind: 'list', header: 'Approve', head: 'Waiting for you to approve:', question: 'Which task?', rows: rows.map(r => ({ item: waitingItem('approve', r), label: taskLabel(r), open: () => item(r) })) }
}

// A task blocked only by open checklist items offers "Accept with open items" (AC-9): the reason typed in the
// free-text row, then the verb under it.
export function acceptScreen(rows: readonly WaitingRow[]): Screen {
  const confirm = (r: WaitingRow, why: string): Screen => ({
    kind: 'item',
    header: 'Accept',
    text: [...taskText('accept', r), `Reason: ${why}`],
    choices: [{ label: `Accept ${r.id} with open items`, verb: ['accept', r.id, '--checklist-open', why, '--via', 'mod'] }],
    question: 'Accept it with these items open, for that reason?',
  })
  const reason = (r: WaitingRow): Screen => ({
    kind: 'reason',
    header: 'Accept',
    text: taskText('accept', r),
    question: 'Type the reason in the free-text row: why accept it with these items open?',
    given: why => confirm(r, why),
  })
  const item = (r: WaitingRow): Screen => {
    const choices: Choice[] = []
    if (r.why === null) choices.push({ label: `Accept ${r.id}`, verb: ['accept', r.id, '--via', 'mod'] })
    else if (r.onlyChecklist) choices.push({ label: 'Accept with open items', open: () => reason(r) })
    const question = r.why === null ? 'Accept it as done?' : r.onlyChecklist ? 'Only open checklist items stop it. Accept it with them open?' : REFUSED
    return { kind: 'item', header: 'Accept', text: taskText('accept', r), choices, question }
  }
  return { kind: 'list', header: 'Accept', head: 'Waiting for you to accept:', question: 'Which task?', rows: rows.map(r => ({ item: waitingItem('accept', r), label: taskLabel(r), open: () => item(r) })) }
}

// An amendment picked offers "Approve <id> A-n" when k would take it, and "Decline", which takes a reason (AC-8).
export function amendmentsScreen(rows: readonly AmendmentRow[]): Screen {
  const textOf = (x: AmendmentRow): string[] => {
    const it = amendmentItem(x)
    return [`${it.lead}${it.name}${it.text}`, `Task: ${sentence(titleOf(x))}`]
  }
  const confirm = (x: AmendmentRow, why: string): Screen => ({
    kind: 'item',
    header: 'Amendments',
    text: [...textOf(x), `Reason: ${why}`],
    choices: [{ label: `Decline ${x.id} ${x.amendment}`, verb: ['amend', 'decline', x.id, x.amendment, '--why', why] }],
    question: 'Decline it, for that reason?',
  })
  const reason = (x: AmendmentRow): Screen => ({
    kind: 'reason',
    header: 'Amendments',
    text: textOf(x),
    question: 'Type the reason in the free-text row: why decline it?',
    given: why => confirm(x, why),
  })
  const item = (x: AmendmentRow): Screen => ({
    kind: 'item',
    header: 'Amendments',
    text: textOf(x),
    choices: [
      ...(x.refuse === null ? [{ label: `Approve ${x.id} ${x.amendment}`, verb: ['approve', x.id, '--amendment', x.amendment, '--via', 'mod'] }] : []),
      { label: 'Decline', open: () => reason(x) },
    ],
    question: x.refuse === null ? 'Approve it, or decline it?' : 'k would refuse its approval now. Decline it?',
  })
  return { kind: 'list', header: 'Amendments', head: 'Waiting for your approval:', question: 'Which amendment?', rows: rows.map(x => ({ item: amendmentItem(x), label: amendmentLabel(x), open: () => item(x) })) }
}

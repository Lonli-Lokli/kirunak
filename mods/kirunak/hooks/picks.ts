import { amendmentItem, amendmentLabel, taskLabel } from './lists'
import type { Item } from './lists'
import type { Choice, Screen } from './owner'
import type { AmendmentRow, TaskRow, WaitingRow } from './waiting'

// The dialogs of /k-approve, /k-accept, /k-amendments, /k-hold and /k-start with no number (kirunak-phone AC-3, AC-8 to
// AC-11, E-4): the list of what waits, then the one picked, in its own words, with the verb k would take now and none
// it would refuse. Each verb runs by id, so a list that changed since ends in k's refusal, never on another row (E-2).

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

// A task as the hold, start and queue lists show it: id, title, and its state as k list says it, with its queue place.
const capital = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`

export function stateItem(r: TaskRow, place: number | null = null): Item {
  return { lead: '', name: r.id, text: `: ${sentence(titleOf(r))} ${capital(r.state)}${place !== null ? `, place ${place}` : ''}.` }
}

const stateText = (r: TaskRow): string[] => [`${r.id}: ${sentence(titleOf(r))}`, `State: ${r.state}.`]

// /k-hold with no id (AC-10): the tasks k hold would take; the one picked offers Hold, which takes the reason typed in
// the free-text row, shown above "Hold <id>".
export function holdScreen(rows: readonly TaskRow[]): Screen {
  const confirm = (r: TaskRow, why: string): Screen => ({
    kind: 'item',
    header: 'Hold',
    text: [...stateText(r), `Reason: ${why}`],
    choices: [{ label: `Hold ${r.id}`, verb: ['hold', r.id, '--why', why, '--via', 'mod'] }],
    question: 'Put it on hold, for that reason?',
  })
  const reason = (r: TaskRow): Screen => ({
    kind: 'reason',
    header: 'Hold',
    text: stateText(r),
    question: 'Type the reason in the free-text row: why put it on hold?',
    given: why => confirm(r, why),
  })
  const item = (r: TaskRow): Screen => ({ kind: 'item', header: 'Hold', text: stateText(r), choices: [{ label: 'Hold', open: () => reason(r) }], question: 'Put it on hold?' })
  return { kind: 'list', header: 'Hold', head: 'Tasks you can put on hold:', question: 'Which task?', rows: rows.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => item(r) })) }
}

// /k-start with no id (AC-11): the tasks k start would take; "Start <id>" names it this session's (`session`, read
// before the dialog opens), and `after` is told whether k took it.
export function startScreen(rows: readonly TaskRow[], session: string, after: (ok: boolean) => void): Screen {
  const item = (r: TaskRow): Screen => ({
    kind: 'item',
    header: 'Start',
    text: stateText(r),
    choices: [{ label: `Start ${r.id}`, verb: ['start', r.id, '--via', 'mod', '--session', session], after }],
    question: 'Work on it in this session?',
  })
  return { kind: 'list', header: 'Start', head: 'Tasks this session can work on:', question: 'Which task?', rows: rows.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => item(r) })) }
}

// A task as `k list --json --all` gives it, enough for the queue's dialogs.
export type QueueRow = TaskRow & { queue: number | null }

const END = 'End of the queue'

// /k-queue (AC-17): the queue in order, then the parked tasks; null when there is neither. A task in the queue offers
// Move when there is another, and "Park <id>" when its state is queued (parking another state would leave it in neither
// list); Move lists the other tasks of the queue and, last, its end, and the one picked is where it goes, by id. A
// parked task offers "Put back <id>", to the end. The queue verbs take no --via: k records no one for them.
export function queueScreen(rows: readonly QueueRow[]): Screen | null {
  const queued = rows.filter(r => r.queue !== null).sort((a, b) => (a.queue as number) - (b.queue as number))
  const parked = rows.filter(r => r.queue === null && r.state === 'parked')
  if (!queued.length && !parked.length) return null
  const placed = (r: QueueRow): string[] => [`${r.id}: ${sentence(titleOf(r))}`, `${capital(r.state)}, place ${r.queue} of ${queued.length} in the queue.`]
  const there = (r: QueueRow, y: QueueRow | null): Screen => {
    const next = queued[queued.indexOf(r) + 1] ?? null
    const choice: Choice = y === null ? { label: `Move ${r.id} to the end`, verb: ['queue', 'move', r.id, '--last'] } : { label: `Move ${r.id} before ${y.id}`, verb: ['queue', 'move', r.id, '--before', y.id] }
    return {
      kind: 'item',
      header: 'Queue',
      text: [...placed(r), y === null ? 'To: the end of the queue.' : `To: before ${y.id}, place ${y.queue}.`],
      choices: y === next ? [] : [choice],
      question: y === next ? 'It is there already. Back to the list?' : 'Move it there?',
    }
  }
  const where = (r: QueueRow): Screen => ({
    kind: 'list',
    header: 'Queue',
    head: `Move ${r.id} before one of these, or to the end:`,
    question: 'Where to?',
    rows: [
      ...queued.filter(y => y !== r).map(y => ({ item: stateItem(y, y.queue), label: taskLabel(y), open: () => there(r, y) })),
      { item: { lead: '', name: END, text: '.' }, label: END, open: () => there(r, null) },
    ],
  })
  const inQueue = (r: QueueRow): Screen => {
    const choices: Choice[] = []
    if (queued.length > 1) choices.push({ label: 'Move', open: () => where(r) })
    if (r.state === 'queued') choices.push({ label: `Park ${r.id}`, verb: ['queue', 'remove', r.id] })
    const question = choices.length === 2 ? 'Move it, or park it?' : queued.length > 1 ? 'Move it?' : r.state === 'queued' ? 'Park it?' : 'It is alone in the queue. Back to the list?'
    return { kind: 'item', header: 'Queue', text: placed(r), choices, question }
  }
  const out = (r: QueueRow): Screen => ({
    kind: 'item',
    header: 'Queue',
    text: [`${r.id}: ${sentence(titleOf(r))}`, 'Parked: approved, out of the queue, so no step of it starts.'],
    choices: [{ label: `Put back ${r.id}`, verb: ['queue', 'add', r.id] }],
    question: 'Put it back, at the end of the queue?',
  })
  return {
    kind: 'list',
    header: 'Queue',
    head: !parked.length ? 'The queue in order:' : queued.length ? 'The queue in order, then the parked tasks:' : 'The queue is empty. Parked:',
    question: 'Which task?',
    rows: [
      ...queued.map(r => ({ item: stateItem(r, r.queue), label: taskLabel(r), open: () => inQueue(r) })),
      ...parked.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => out(r) })),
    ],
  }
}

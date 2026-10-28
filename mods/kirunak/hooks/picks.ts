import type { KirunakChip, KirunakLookRow, KirunakSection } from '../types'
import { amendmentItem, amendmentLabel, amendmentLines, amendmentParts, taskLabel, whole } from './lists'
import type { Item } from './lists'
import { clipped, dateWord, reasonLook, taskChip } from './looks'
import type { Choice, Look, PickScreen, Row, Screen } from './owner'
import { blockingLines, capBlocking } from './waiting'
import type { AmendmentRow, TaskRow, WaitingRow } from './waiting'

// The dialogs of /k-approve, /k-accept, /k-amendments, /k-hold, /k-resume and /k-start with no number (kirunak-phone
// AC-3, AC-8 to AC-11, AC-18, E-4): the list of what waits, each row named and nothing more (a task's id and state, in
// /k-queue its title too, A-10; an amendment's task id, A-n and name, A-8), then the one picked, in its own words, with
// the verb k would take now and none it would refuse. Each verb runs by id, so a list that changed since ends in k's
// refusal, never on another row (E-2).
// /k-approve's, /k-accept's and /k-amendments' lists are the ones a typed number takes (`/k-accept 4`), so they are
// `typed`: a page after the first gives each line that number too (Q-33). /k-hold, /k-resume, /k-start and /k-queue
// take an id or nothing typed, never a number, so their lines keep the app's numbers alone.

const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)
const titleOf = (r: { title: string }): string => r.title.replace(/\s+/g, ' ').trim()

// What k would refuse, line by line, less the id its first line starts with; at most ten blocking lines (capBlocking).
function refusalLines(id: string, why: string): string[] {
  const lines = why.split('\n').map(l => l.trim()).filter(Boolean)
  return capBlocking(lines.map((l, i) => (i === 0 && l.startsWith(`${id}: `) ? l.slice(id.length + 2) : l)))
}

// A waiting task's state as k waiting gives it; from an older k without it, what k approve and k accept take: proposed
// tasks, and reviewed ones, which read "awaiting owner" while their checklist has an unticked item (lib/state.mjs).
const waitingState = (verb: 'approve' | 'accept', r: WaitingRow): string => r.state ?? (verb === 'approve' ? 'proposed' : r.checklistOpen ? 'awaiting owner' : 'reviewed')

// A task k waiting offers a verb on, as a list row: its id and state; whether k would take the verb shows once picked.
// Under a task its blocking files refuse, each file, its commit and its task (kirunak-accept-shared-repo E-2).
export const waitingItem = (verb: 'approve' | 'accept', r: WaitingRow): Item => ({ lead: '', name: r.id, text: `: ${waitingState(verb, r)}`, under: blockingLines(r) })

// The task picked, in full: id and title, its state, its review, and what k would refuse, every line of it.
function taskText(verb: 'approve' | 'accept', r: WaitingRow): string[] {
  return [
    `${r.id}: ${sentence(titleOf(r))}`,
    `State: ${waitingState(verb, r)}.`,
    ...(r.review ? [`Review: ${r.review.file}${r.review.verdict ? `, ${r.review.verdict}` : ''}.`] : []),
    ...(r.why === null ? [`k would ${verb} it now.`] : ['Not yet:', ...refusalLines(r.id, r.why)]),
  ]
}

const REFUSED = 'k would refuse it now. Back to the list?'

// The looks of these dialogs on the phone and the desktop app (gulnya/mobile-dialogs AC-1 to AC-4, AC-8), as /k-bugs'
// are: a head (the title large, a chip in its state's colour with its icon and word, a dim line with the repo and
// the date in words), plain words under it, then what Show all unfolds: the ids, files and refusals, under their
// headings. A list draws a row a choice, its chip, its id and its words. A task's chip is its state's (taskChip).
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const repoOf = (id: string): string => id.split('/')[0] ?? id
const reposOf = (ids: readonly string[]): string => [...new Set(ids.map(repoOf))].join(', ')

function listLook(title: string, chip: KirunakChip, ids: readonly string[], rows: KirunakLookRow[], line = `${plural(ids.length, 'task')} in ${reposOf(ids)}`): Look {
  return { title, chip, line, first: [], rows, fold: null }
}

// A task's look: its title, its state's chip, its repo; `first`, the plain words under it; `fold`, what Show all
// unfolds before where it is (its id).
function taskLook(r: { id: string; title: string }, state: string, first: readonly string[] = [], fold: readonly KirunakSection[] = []): Look {
  return {
    title: titleOf(r) || r.id,
    chip: taskChip(state),
    line: repoOf(r.id),
    first: first.length ? [{ heading: null, lines: [...first] }] : [],
    rows: [],
    fold: [...fold, { heading: 'Where it is', lines: [`Id: ${r.id}`] }],
  }
}
const headOnly = (look: Look): Look => ({ ...look, first: [], fold: null })

// A waiting task's look: its review's verdict and whether k would take the verb, in words; its refusal, its review's
// file and its blocking files behind Show all.
function waitingLook(verb: 'approve' | 'accept', r: WaitingRow): Look {
  const said = r.why === null ? `k would ${verb} it now.` : verb === 'accept' && r.onlyChecklist ? 'Only open checklist items stop it.' : 'Not yet: k would refuse it now.'
  const blocking = blockingLines(r)
  return taskLook(r, waitingState(verb, r), [...(r.review?.verdict ? [`Its review: ${r.review.verdict}.`] : []), said], [
    ...(r.why !== null ? [{ heading: 'Not yet', lines: refusalLines(r.id, r.why) }] : []),
    ...(blocking.length && r.why === null ? [{ heading: 'Blocking files', lines: blocking }] : []),
    ...(r.review ? [{ heading: 'Review', lines: [`File: ${r.review.file}`] }] : []),
  ])
}
const waitingRows = (verb: 'approve' | 'accept', rows: readonly WaitingRow[]): KirunakLookRow[] => rows.map(r => ({ chip: taskChip(waitingState(verb, r)), id: taskLabel(r), words: titleOf(r) }))
const waits = (n: number): KirunakChip => ({ stage: 'waits', word: `${n} ${n === 1 ? 'waits' : 'wait'} for you` })

export function approveScreen(rows: readonly WaitingRow[]): Screen {
  const item = (r: WaitingRow): Screen => ({
    kind: 'item',
    header: 'Approve',
    text: taskText('approve', r),
    choices: r.why === null ? [{ label: `Approve ${r.id}`, description: 'approves it, so its steps can start', verb: ['approve', r.id, '--via', 'mod'] }] : [],
    question: r.why === null ? 'Approve it?' : REFUSED,
    look: waitingLook('approve', r),
  })
  return { kind: 'list', header: 'Approve', head: 'Waiting for you to approve:', question: 'Which task?', typed: true, rows: rows.map(r => ({ item: waitingItem('approve', r), label: taskLabel(r), open: () => item(r) })), look: listLook('Approve', waits(rows.length), rows.map(r => r.id), waitingRows('approve', rows)) }
}

// A task blocked only by open checklist items offers "Accept with open items" (AC-9): the reason typed in the
// free-text row, then the verb under it.
export function acceptScreen(rows: readonly WaitingRow[]): Screen {
  const confirm = (r: WaitingRow, why: string): Screen => ({
    kind: 'item',
    header: 'Accept',
    text: [...taskText('accept', r), `Reason: ${why}`],
    choices: [{ label: `Accept ${r.id} with open items`, description: 'accepts it as done, for that reason', verb: ['accept', r.id, '--checklist-open', why, '--via', 'mod'] }],
    question: 'Accept it with these items open, for that reason?',
    look: reasonLook(headOnly(waitingLook('accept', r)), why),
  })
  const reason = (r: WaitingRow): Screen => ({
    kind: 'reason',
    header: 'Accept',
    text: taskText('accept', r),
    question: 'Type the reason in the free-text row: why accept it with these items open?',
    given: why => confirm(r, why),
    look: headOnly(waitingLook('accept', r)),
  })
  const item = (r: WaitingRow): Screen => {
    const choices: Choice[] = []
    if (r.why === null) choices.push({ label: `Accept ${r.id}`, description: 'accepts it as done', verb: ['accept', r.id, '--via', 'mod'] })
    else if (r.onlyChecklist) choices.push({ label: 'Accept with open items', description: 'asks why, then accepts it', open: () => reason(r) })
    const question = r.why === null ? 'Accept it as done?' : r.onlyChecklist ? 'Only open checklist items stop it. Accept it with them open?' : REFUSED
    return { kind: 'item', header: 'Accept', text: taskText('accept', r), choices, question, look: waitingLook('accept', r) }
  }
  return { kind: 'list', header: 'Accept', head: 'Waiting for you to accept:', question: 'Which task?', typed: true, rows: rows.map(r => ({ item: waitingItem('accept', r), label: taskLabel(r), open: () => item(r) })), look: listLook('Accept', waits(rows.length), rows.map(r => r.id), waitingRows('accept', rows)) }
}

// An amendment picked shows in full, from its file in `files` (by path; one missing could not be read), and offers
// "Approve <id> A-n" when k would take it, and "Decline", which takes a reason (AC-2, AC-8).
// Its look (gulnya/mobile-dialogs AC-1): an amendment waits for the owner's approval, orange, until k would refuse it
// (red, "refused now"); one applied or declined since the list was read is green or red. Its name large, its repo and
// the date proposed; its Why's first paragraph and whether k would approve it, in words; then its Why whole, its
// Changes, what k would refuse and where it is behind Show all. Dates are said from `now`, this machine's clock.
export function amendmentsScreen(rows: readonly AmendmentRow[], files: ReadonlyMap<string, string>, now = Date.now()): Screen {
  const textOf = (x: AmendmentRow): string[] => amendmentLines(x, files.get(x.file) ?? null)
  const fileOf = (x: AmendmentRow): string | null => files.get(x.file) ?? null
  const proposedOf = (x: AmendmentRow): string | null => {
    const file = fileOf(x)
    return (file === null ? null : amendmentParts(file).front.proposed) ?? x.proposed ?? null
  }
  const chipOf = (x: AmendmentRow): KirunakChip => {
    const { stamp, refuse } = whole(x, fileOf(x))
    if (stamp !== null) return stamp.startsWith('Applied') ? { stage: 'done', word: 'applied' } : { stage: 'stopped', word: 'declined' }
    return refuse !== null ? { stage: 'stopped', word: 'refused now' } : { stage: 'waits', word: 'waits for you' }
  }
  const nameOf = (x: AmendmentRow): string => (x.name ? x.name.replace(/\s+/g, ' ').trim() : '')
  const lookOf = (x: AmendmentRow): Look => {
    const file = fileOf(x)
    const { why, changes, stamp, refuse } = whole(x, file)
    const proposed = proposedOf(x)
    const by = (file === null ? undefined : amendmentParts(file).front.by) ?? x.by
    const said = stamp ?? (refuse !== null ? 'Not yet: k would refuse its approval now.' : 'k would approve it now.')
    return {
      title: nameOf(x) || `${x.amendment} of ${titleOf(x)}`,
      chip: chipOf(x),
      line: `${repoOf(x.id)}, ${proposed ? `proposed ${dateWord(proposed, now)}` : 'proposed on no date'}`,
      first: [{ heading: null, lines: [...(why[0] ? [clipped(why[0])] : []), said] }],
      rows: [],
      fold: [
        { heading: 'Why', lines: why.length ? why : ['(empty)'] },
        file === null ? { heading: 'Changes', lines: ['Its file could not be read, so its Changes are not shown.'] } : { heading: 'Changes', lines: changes.length ? changes : ['(none)'] },
        ...(refuse !== null && stamp === null ? [{ heading: 'Not yet', lines: [refuse] }] : []),
        { heading: 'Where it is', lines: [`Task: ${x.id}, ${titleOf(x)}`, `Amendment: ${x.amendment}`, ...(by ? [`Proposed by ${by}`] : []), `File: ${x.file}`] },
      ],
    }
  }
  const confirm = (x: AmendmentRow, why: string): Screen => ({
    kind: 'item',
    header: 'Amendments',
    text: [...textOf(x), `Reason: ${why}`],
    choices: [{ label: `Decline ${x.id} ${x.amendment}`, description: 'declines it, for that reason', verb: ['amend', 'decline', x.id, x.amendment, '--why', why] }],
    question: 'Decline it, for that reason?',
    look: reasonLook(headOnly(lookOf(x)), why),
  })
  const reason = (x: AmendmentRow): Screen => ({
    kind: 'reason',
    header: 'Amendments',
    text: textOf(x),
    question: 'Type the reason in the free-text row: why decline it?',
    given: why => confirm(x, why),
    look: headOnly(lookOf(x)),
  })
  const item = (x: AmendmentRow): Screen => ({
    kind: 'item',
    header: 'Amendments',
    text: textOf(x),
    choices: [
      ...(x.refuse === null ? [{ label: `Approve ${x.id} ${x.amendment}`, description: 'applies it to the task', verb: ['approve', x.id, '--amendment', x.amendment, '--via', 'mod'] }] : []),
      { label: 'Decline', description: 'asks why, then declines it', open: () => reason(x) },
    ],
    question: x.refuse === null ? 'Approve it, or decline it?' : 'k would refuse its approval now. Decline it?',
    look: lookOf(x),
  })
  const newest = rows.map(proposedOf).filter((d): d is string => d !== null && /^\d{4}-\d{2}-\d{2}/.test(d)).sort().pop() ?? null
  const look: Look = {
    ...listLook('Amendments', waits(rows.length), rows.map(x => x.id), rows.map(x => ({ chip: chipOf(x), id: amendmentLabel(x), words: nameOf(x) || titleOf(x) }))),
    line: `${plural(rows.length, 'amendment')} in ${reposOf(rows.map(x => x.id))}${newest ? `, the newest proposed ${dateWord(newest, now)}` : ''}`,
  }
  return { kind: 'list', header: 'Amendments', head: 'Waiting for your approval:', question: 'Which amendment?', typed: true, rows: rows.map(x => ({ item: amendmentItem(x), label: amendmentLabel(x), open: () => item(x) })), look }
}

// What `k board --brief --json` gives (A-7's and A-9's AC-5): when it was made, the brief board in plain lines, the
// tasks' ids in the order those lines list them, the groups those lines make (each one's name, count, ids and entry
// lines, in the board's order) and the machine's line, the text's last.
export type BriefGroup = { name: string; count: number; ids: string[]; lines: string[] }
export type Brief = { made: string; text: string; ids: string[]; groups: BriefGroup[]; machine: string }

// /k-board with no id (A-9's AC-5), in steps. First the groups: when the board was made, each group's name and count,
// the machine's line, and the groups that hold a task as the choices (k names group by words, never a digit, so the
// app's own numbers stand alone). A group picked: its paragraph of the brief board, its tasks as the choices, and
// Back; the task tapped answers with its card. Both page three and More, as every list does. It runs no verb. The
// group Drafts (kirunak-drafts S-4: the drafts after the tasks, `k board --card` a draft's card too) asks for a draft,
// the group Bugs (gulnya/kirunak-bugs AC-7: the bugs before the drafts, a bug's card too) for a bug.
// Asked in one line (gulnya/mobile-dialogs AC-23): a group's name and count before its question, each entry's words
// after its id the line of its choice, and the lines that name no choice (Bugs' "2 bugs, 1 with a fix ready") above;
// the groups' counts are their choices' lines, and only an empty group, which is no choice, is counted above.
const GROUP_ASKS: Readonly<Record<string, string>> = { Bugs: 'Which bug?', Drafts: 'Which draft?' }
const GROUP_NOUNS: Readonly<Record<string, string>> = { Bugs: 'bug', Drafts: 'draft' }
const counted = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
// Its look (gulnya/mobile-dialogs AC-1, AC-8): each group's chip, its state's: Stopped for you red, Working on now
// yellow, Done this week green, Bugs and Drafts orange (they wait for the owner's choice), every other group the chip
// of the state it names; a task's row its own state's chip where its line starts with one. The groups' chip says
// what stopped, else what waits for the owner, else what runs; its line when the board was made; the machine's line,
// which names sessions, behind Show all.
const GROUP_CHIPS: Readonly<Record<string, KirunakChip['stage']>> = { 'Stopped for you': 'stopped', 'Working on now': 'started', 'Done this week': 'done', Bugs: 'waits', Drafts: 'waits' }
const WAITING_GROUPS = new Set(['Proposed', 'Reviewed', 'Awaiting owner'])
// The groups whose rows keep the group's chip: a stopped task's, a bug's and a draft's line starts with no state.
const OWN_CHIPS = new Set(['Stopped for you', 'Bugs', 'Drafts'])
const groupChip = (g: BriefGroup): KirunakChip => {
  const stage = GROUP_CHIPS[g.name]
  return stage !== undefined ? { stage, word: g.name.toLowerCase() } : taskChip(g.name.toLowerCase())
}
const STATE_WORDS = new Set(['draft', 'proposed', 'queued', 'parked', 'blocked', 'in progress', 'in review', 'reviewed', 'awaiting owner', 'done', 'on hold', 'stale'])
// The brief's "Made at 2026-11-07 12:00" in words: "made today, 12:00".
const madeWord = (made: string, now: number): string => {
  const time = /\d{2}:\d{2}/.exec(made)?.[0]
  return `made ${dateWord(made, now)}${time ? `, ${time}` : ''}`
}
// A group's lines that name no choice show under its head when short, else behind Show all; past this many rows.
const SHORT_ROWS = 6
export function boardScreen(brief: Brief, now = Date.now()): PickScreen {
  const group = (g: BriefGroup): PickScreen => {
    const described: Record<string, string> = {}
    const text: string[] = []
    for (const l of g.lines) {
      const id = g.ids.find(i => l.startsWith(`${i}: `))
      if (id !== undefined && described[id] === undefined) described[id] = l.slice(id.length + 2)
      else text.push(l)
    }
    const chip = groupChip(g)
    const rowChip = (id: string): KirunakChip => {
      const state = described[id]?.split(',')[0]?.trim() ?? ''
      return STATE_WORDS.has(state) && !OWN_CHIPS.has(g.name) ? taskChip(state) : chip
    }
    const short = text.reduce((n, l) => n + 1 + Math.floor(l.length / 40), 0) <= SHORT_ROWS
    const look: Look = {
      title: g.name,
      chip: { ...chip, word: counted(g.count, GROUP_NOUNS[g.name] ?? 'task') },
      line: g.ids.length ? `in ${reposOf(g.ids)}, ${madeWord(brief.made, now)}` : madeWord(brief.made, now),
      first: short && text.length ? [{ heading: null, lines: text }] : [],
      rows: g.ids.map(id => ({ chip: rowChip(id), id, words: described[id] ?? '' })),
      fold: short || !text.length ? null : [{ heading: null, lines: text }],
    }
    return { kind: 'pick', header: 'Board', text, head: `${g.name} (${g.count})`, labels: g.ids, described, question: GROUP_ASKS[g.name] ?? 'Which task\'s card?', look }
  }
  const empty = brief.groups.filter(g => !g.ids.length).map(g => `${g.name}: ${g.count}`)
  const stopped = brief.groups.find(g => g.name === 'Stopped for you')?.count ?? 0
  const waiting = brief.groups.filter(g => WAITING_GROUPS.has(g.name)).reduce((n, g) => n + g.count, 0)
  const working = brief.groups.find(g => g.name === 'Working on now')?.count ?? 0
  const chip: KirunakChip = stopped
    ? { stage: 'stopped', word: `${stopped} stopped for you` }
    : waiting
      ? waits(waiting)
      : working
        ? { stage: 'started', word: `${working} working now` }
        : { stage: 'not reached', word: 'nothing waits' }
  const look: Look = {
    title: 'Board',
    chip,
    line: madeWord(brief.made, now),
    first: empty.length ? [{ heading: null, lines: empty }] : [],
    rows: brief.groups.filter(g => g.ids.length).map(g => ({ chip: groupChip(g), id: g.name, words: counted(g.count, GROUP_NOUNS[g.name] ?? 'task') })),
    fold: [{ heading: 'The machine', lines: [brief.machine] }],
  }
  return {
    look,
    kind: 'pick',
    header: 'Board',
    text: [`Made at ${brief.made}.`, ...(empty.length ? ['', ...empty] : []), '', brief.machine],
    labels: brief.groups.filter(g => g.ids.length).map(g => ({ label: g.name, description: counted(g.count, GROUP_NOUNS[g.name] ?? 'task'), open: () => group(g) })),
    question: 'Which group?',
  }
}

// A task as the hold, resume and start lists show it, and the queue's before its title: its id and state as k list
// says it, with its queue place.
export const stateItem = (r: TaskRow, place: number | null = null): Item => ({ lead: '', name: r.id, text: `: ${r.state}${place !== null ? `, place ${place}` : ''}` })

const capital = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`

const stateText = (r: TaskRow): string[] => [`${r.id}: ${sentence(titleOf(r))}`, `State: ${r.state}.`]

// A task list's look rows: each task's state chip, its id and title.
const stateRows = (rows: readonly TaskRow[]): KirunakLookRow[] => rows.map(r => ({ chip: taskChip(r.state), id: taskLabel(r), words: titleOf(r) }))

// /k-hold with no id (AC-10): the tasks k hold would take; the one picked offers Hold, which takes the reason typed in
// the free-text row, shown above "Hold <id>".
export function holdScreen(rows: readonly TaskRow[]): Screen {
  const confirm = (r: TaskRow, why: string): Screen => ({
    kind: 'item',
    header: 'Hold',
    text: [...stateText(r), `Reason: ${why}`],
    choices: [{ label: `Hold ${r.id}`, description: 'puts it on hold, for that reason', verb: ['hold', r.id, '--why', why, '--via', 'mod'] }],
    question: 'Put it on hold, for that reason?',
    look: reasonLook(headOnly(taskLook(r, r.state)), why),
  })
  const reason = (r: TaskRow): Screen => ({
    kind: 'reason',
    header: 'Hold',
    text: stateText(r),
    question: 'Type the reason in the free-text row: why put it on hold?',
    given: why => confirm(r, why),
    look: headOnly(taskLook(r, r.state)),
  })
  const item = (r: TaskRow): Screen => ({ kind: 'item', header: 'Hold', text: stateText(r), choices: [{ label: 'Hold', description: 'asks why, then puts it on hold', open: () => reason(r) }], question: 'Put it on hold?', look: taskLook(r, r.state) })
  return { kind: 'list', header: 'Hold', head: 'Tasks you can put on hold:', question: 'Which task?', rows: rows.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => item(r) })), look: listLook('Hold', { stage: 'not reached', word: `${rows.length} can be held` }, rows.map(r => r.id), stateRows(rows)) }
}

// /k-resume with no id (A-12's AC-18): the tasks on hold of k list's rows, null when there is none; the one picked
// offers "Resume <id>". k resume takes no --via: it records no one.
export function resumeScreen(rows: readonly TaskRow[]): Screen | null {
  const held = rows.filter(r => r.state === 'on hold')
  if (!held.length) return null
  const item = (r: TaskRow): Screen => ({ kind: 'item', header: 'Resume', text: stateText(r), choices: [{ label: `Resume ${r.id}`, description: 'takes it off hold', verb: ['resume', r.id] }], question: 'Take it off hold?', look: taskLook(r, r.state) })
  return { kind: 'list', header: 'Resume', head: 'Tasks on hold:', question: 'Which task?', rows: held.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => item(r) })), look: listLook('Resume', { stage: 'paused', word: `${held.length} on hold` }, held.map(r => r.id), stateRows(held)) }
}

// /k-start with no id (AC-11): the tasks k start would take; "Start <id>" names it this session's (`session`, read
// before the dialog opens), and `after` is told whether k took it.
export function startScreen(rows: readonly TaskRow[], session: string, after: (ok: boolean) => void): Screen {
  const item = (r: TaskRow): Screen => ({
    kind: 'item',
    header: 'Start',
    text: stateText(r),
    choices: [{ label: `Start ${r.id}`, description: 'names it this session\'s task', verb: ['start', r.id, '--via', 'mod', '--session', session], after }],
    question: 'Work on it in this session?',
    look: taskLook(r, r.state),
  })
  return { kind: 'list', header: 'Start', head: 'Tasks this session can work on:', question: 'Which task?', rows: rows.map(r => ({ item: stateItem(r), label: taskLabel(r), open: () => item(r) })), look: listLook('Start', { stage: 'not reached', word: `${rows.length} can start` }, rows.map(r => r.id), stateRows(rows)) }
}

// A task as `k list --json --all` gives it, enough for the queue's dialogs.
export type QueueRow = TaskRow & { queue: number | null }

// A task as /k-queue's lists show it (A-10's AC-3, AC-17): its id and state, then its title, so the owner knows which
// task to move before which; its line is numbered by its place in the queue (A-11), so the place is not said again.
const queueItem = (r: QueueRow): Item => {
  const item = stateItem(r)
  const title = titleOf(r)
  return title ? { ...item, text: `${item.text}. ${sentence(title)}` } : item
}

const END = 'End of the queue'

// /k-queue (AC-17): the queue in order, then the parked tasks, each line numbered by its place in the queue, a parked
// one's by none (A-11); null when there is neither. A task in the queue offers Move when there is another, and
// "Park <id>" when its state is queued (parking another state would leave it in neither list); Move lists Earlier and
// Later, each a tap that moves it one place (A-11), the first task having no Earlier and the last no Later, then the
// other tasks of the queue and, last, its end, and the one picked is where it goes, by id. A parked task offers
// "Put back <id>", to the end. The queue verbs take no --via: k records no one for them.
export function queueScreen(rows: readonly QueueRow[]): Screen | null {
  const queued = rows.filter(r => r.queue !== null).sort((a, b) => (a.queue as number) - (b.queue as number))
  const parked = rows.filter(r => r.queue === null && r.state === 'parked')
  if (!queued.length && !parked.length) return null
  const placed = (r: QueueRow): string[] => [`${r.id}: ${sentence(titleOf(r))}`, `${capital(r.state)}, place ${r.queue} of ${queued.length} in the queue.`]
  // The looks: a task's head, its place in the queue in words; a list's rows, each place before its title.
  const placeLine = (r: QueueRow): string => (r.queue !== null ? `Place ${r.queue} of ${queued.length} in the queue.` : 'Parked: approved, out of the queue, so no step of it starts.')
  const queueRows = (rs: readonly QueueRow[]): KirunakLookRow[] => rs.map(r => ({ chip: taskChip(r.state), id: taskLabel(r), words: r.queue !== null ? `place ${r.queue}, ${titleOf(r)}` : titleOf(r) }))
  const there = (r: QueueRow, y: QueueRow | null): Screen => {
    const next = queued[queued.indexOf(r) + 1] ?? null
    const choice: Choice = y === null ? { label: `Move ${r.id} to the end`, description: 'moves it after every task', verb: ['queue', 'move', r.id, '--last'] } : { label: `Move ${r.id} before ${y.id}`, description: 'moves it there', verb: ['queue', 'move', r.id, '--before', y.id] }
    return {
      kind: 'item',
      header: 'Queue',
      text: [...placed(r), y === null ? 'To: the end of the queue.' : `To: before ${y.id}, place ${y.queue}.`],
      choices: y === next ? [] : [choice],
      question: y === next ? 'It is there already. Back to the list?' : 'Move it there?',
      look: taskLook(r, r.state, [placeLine(r), y === null ? 'To: the end of the queue.' : `To: place ${y.queue}, before ${titleOf(y) || y.id}.`], y === null ? [] : [{ heading: 'Before', lines: [`Id: ${y.id}`] }]),
    }
  }
  const where = (r: QueueRow): Screen => {
    const before = queued[queued.indexOf(r) - 1] ?? null
    const after = queued[queued.indexOf(r) + 1] ?? null
    const near: Row[] = []
    if (before) near.push({ item: { lead: '', name: 'Earlier', text: `: to place ${before.queue}, before ${before.id}.` }, label: 'Earlier', verb: ['queue', 'move', r.id, '--before', before.id] })
    if (after) near.push({ item: { lead: '', name: 'Later', text: `: to place ${after.queue}, after ${after.id}.` }, label: 'Later', verb: ['queue', 'move', r.id, '--after', after.id] })
    const step = before && after ? 'one place earlier or later' : before ? 'one place earlier' : 'one place later'
    return {
      kind: 'list',
      header: 'Queue',
      text: placed(r),
      head: `Move it ${step}, before one of these, or to the end:`,
      question: 'Where to?',
      places: true,
      look: { ...taskLook(r, r.state, [placeLine(r)]), rows: queueRows(queued.filter(y => y !== r)) },
      rows: [
        ...near,
        ...queued.filter(y => y !== r).map(y => ({ item: queueItem(y), label: taskLabel(y), place: y.queue, open: () => there(r, y) })),
        { item: { lead: '', name: END, text: '' }, label: END, description: 'after every task in it', open: () => there(r, null) },
      ],
    }
  }
  const inQueue = (r: QueueRow): Screen => {
    const choices: Choice[] = []
    if (queued.length > 1) choices.push({ label: 'Move', description: 'lists where it can go', open: () => where(r) })
    if (r.state === 'queued') choices.push({ label: `Park ${r.id}`, description: 'takes it out of the queue', verb: ['queue', 'remove', r.id] })
    const question = choices.length === 2 ? 'Move it, or park it?' : queued.length > 1 ? 'Move it?' : r.state === 'queued' ? 'Park it?' : 'It is alone in the queue. Back to the list?'
    return { kind: 'item', header: 'Queue', text: placed(r), choices, question, look: taskLook(r, r.state, [placeLine(r)]) }
  }
  const out = (r: QueueRow): Screen => ({
    kind: 'item',
    header: 'Queue',
    text: [`${r.id}: ${sentence(titleOf(r))}`, 'Parked: approved, out of the queue, so no step of it starts.'],
    choices: [{ label: `Put back ${r.id}`, description: 'adds it at the end of the queue', verb: ['queue', 'add', r.id] }],
    question: 'Put it back, at the end of the queue?',
    look: taskLook(r, r.state, [placeLine(r)]),
  })
  return {
    kind: 'list',
    header: 'Queue',
    head: !parked.length ? 'The queue in order:' : queued.length ? 'The queue in order, then the parked tasks:' : 'The queue is empty. Parked:',
    question: 'Which task?',
    places: true,
    look: listLook('Queue', { stage: 'not reached', word: `${queued.length} in the queue` }, [...queued, ...parked].map(r => r.id), queueRows([...queued, ...parked]), `${plural(queued.length, 'task')} in the queue${parked.length ? `, ${parked.length} parked` : ''}, in ${reposOf([...queued, ...parked].map(r => r.id))}`),
    rows: [
      ...queued.map(r => ({ item: queueItem(r), label: taskLabel(r), place: r.queue, open: () => inQueue(r) })),
      ...parked.map(r => ({ item: queueItem(r), label: taskLabel(r), open: () => out(r) })),
    ],
  }
}

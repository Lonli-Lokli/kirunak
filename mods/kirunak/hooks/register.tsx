import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { bandLine, PANE_COLORS, paneLines } from './board'
import { bugsScreen, bugsText, fixOf, fixPrompt } from './bugs'
import type { BugRow, QuadDamageStatus } from './bugs'
import { argvFor, firstLine, HINTS, reason, refused } from './commands'
import type { Verb } from './commands'
import { draftsScreen, draftsText, firstQuestion, intakePrompt, questionsOf } from './drafts'
import type { DraftRow } from './drafts'
import { amendmentsText, amendmentText, briefText, listText } from './lists'
import { nothingRan, owners, showIntake } from './owner'
import type { Outcome, Turn } from './owner'
import { acceptScreen, amendmentsScreen, approveScreen, boardScreen, holdScreen, queueScreen, resumeScreen, startScreen } from './picks'
import type { Brief } from './picks'
import { looks } from './look'
import { lastRows, refresh, sessionTask, tick } from './reads'
import { forgetRan, noteAuthors, noteRan, submitLater } from './turns'
import { byNumber, idSuggestions, nth, offerText } from './waiting'
import type { AmendmentRow, Waiting } from './waiting'

// How often the pane and the band read k list and k status when no event asked for a read sooner (boards.md §4).
const EVERY_MS = 30_000

const PANE = 'kirunak'
const FAILED = (name: string): string => `/${name} failed in the mod (the debug log says why); if k had started, \`k list --all\` shows whether it took.`
// A list's: it runs no verb.
const READ_FAILED = (name: string): string => `/${name} failed in the mod; the debug log says why.`
// The read's value, which reads.ts writes; the scan wants the reference written in the file that reads it.
const board = atom({ plugin: 'kirunak', key: 'board' } as const, null)

// The owner's verbs (boards.md §4, approval.md §5): run only on the owner's own gesture, as `node k <verb> <id>
// --via mod`, with no model turn; the state line k prints is the command's output, and a turn of the session's own
// may follow it (turns.ts).
// The lists a number picks from, as last shown in this session: with no id, /k-approve and /k-accept list what waits
// for that verb, and the ids shown, in order, are what `/k-accept <n>` takes; /k-amendments lists the amendments that
// `/k-amendments <n>` and `/k-approve-amendment <n>` take (E-2). The module's own, so a reload asks for the list again,
// and `session.end` forgets it: `/clear` and a resume go on in the same process under another session, whose screen
// shows no such list (review G25).
const offered: Partial<Record<'approve' | 'accept', string[]>> & { amendments?: AmendmentRow[] } = {}

// `/k-approve` or `/k-accept` with no id: what waits for that verb, kept for a number, as the dialog's choices
// (kirunak-phone AC-3); when nothing ran, the answer says why and shows the list as a number takes it.
async function offer($: EngineInterface, turn: Turn, verb: 'approve' | 'accept'): Promise<string | Outcome> {
  const r = await $.process.run(['node', turn.k, 'waiting', '--json'])
  // A list that could not be read leaves none to pick from, never the one before it (review G27).
  delete offered[verb]
  if (r.exitCode !== 0) return `k waiting did not answer: ${firstLine(r)}`
  const rows = (JSON.parse(r.stdout) as Waiting)[verb]
  offered[verb] = rows.map(row => row.id)
  if (!rows.length) return offerText(verb, rows)
  const out = await turn.dialog(verb === 'approve' ? approveScreen(rows) : acceptScreen(rows))
  return out.nothing === null ? out : `${nothingRan(out.nothing)}\n\n${offerText(verb, rows)}`
}

// `/k-hold` or `/k-start` with no id: the tasks k waiting says the verb would take, as the dialog's choices
// (kirunak-phone AC-10, AC-11). k start records this session as the task's, so its id is read before the dialog opens,
// and the pane opens once k took it, as after the typed /k-start.
async function pickTask($: EngineInterface, turn: Turn, verb: 'hold' | 'start'): Promise<string | Outcome> {
  const r = await $.process.run(['node', turn.k, 'waiting', '--json'])
  if (r.exitCode !== 0) return `k waiting did not answer: ${firstLine(r)}`
  const rows = (JSON.parse(r.stdout) as Waiting)[verb] ?? []
  if (!rows.length) return verb === 'hold' ? 'No task can be put on hold now.' : 'No task to start: every task is done or on hold.'
  const first = verb === 'hold'
    ? holdScreen(rows)
    : startScreen(rows, await $.session.id(), ok => {
      if (ok) void $.ui.open({ id: PANE, title: 'kirunak' }).catch(() => undefined)
    })
  const out = await turn.dialog(first)
  return out.nothing === null ? out : nothingRan(out.nothing)
}

// `/k-resume` with no id: the tasks on hold, from k list as /k-queue reads it, as the dialog's choices (A-12's AC-18).
async function pickHeld($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  const r = await $.process.run(['node', turn.k, 'list', '--json', '--all'])
  if (r.exitCode !== 0) return refused('k-resume', r)
  const first = resumeScreen(JSON.parse(r.stdout).rows)
  if (first === null) return 'No task is on hold.'
  const out = await turn.dialog(first)
  return out.nothing === null ? out : nothingRan(out.nothing)
}

async function ownerVerb($: EngineInterface, turn: Turn, name: string, verb: Verb): Promise<string | Outcome> {
  let args = turn.args
  if ((verb === 'hold' || verb === 'start') && args.trim() === '') return pickTask($, turn, verb)
  if (verb === 'resume' && args.trim() === '') return pickHeld($, turn)
  if (verb === 'approve' || verb === 'accept') {
    if (args.trim() === '') return offer($, turn, verb)
    const picked = byNumber(args, offered[verb])
    if (picked !== null && 'problem' in picked) return `/${name} ${args.trim()}: ${picked.problem}. Nothing ran.`
    if (picked !== null) args = picked.args
  }
  const parsed = argvFor(verb, args)
  if ('problem' in parsed) return `/${name}: ${parsed.problem}. Nothing ran. Usage: /${name} ${HINTS[verb]}`
  if (verb !== 'start') return turn.typed(parsed.argv)
  return turn.typed([...parsed.argv, '--session', await $.session.id()], ok => {
    if (ok) void $.ui.open({ id: PANE, title: 'kirunak' }).catch(() => undefined)
  })
}

// `/k-list [all]`: k list's rows for a phone (AC-1).
async function list($: EngineInterface, { k, args }: Turn): Promise<string> {
  const all = args.trim()
  if (all !== '' && all !== 'all') return `/k-list takes all or nothing, not ${all}.`
  const r = await $.process.run(['node', k, 'list', '--json', ...(all ? ['--all'] : [])])
  return r.exitCode !== 0 ? refused('k-list', r) : listText(JSON.parse(r.stdout).rows, all === 'all')
}

// The looks' dates by this machine's clock, else the process's (gulnya/mobile-dialogs AC-1).
async function nowOf($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// `/k-board` (A-9's AC-5): the dialog in steps, the board's groups and then a group's tasks; the task tapped answers
// with its card, and Skip, a dismissal or any other answer, at any step, with the brief board itself. It reads, and
// runs no verb. `/k-board <id>`: that task's card at once, with no dialog.
async function boardAnswer($: EngineInterface, turn: Turn): Promise<string> {
  const id = turn.args.trim()
  if (id) return card($, turn.k, id)
  const r = await $.process.run(['node', turn.k, 'board', '--brief', '--json'])
  if (r.exitCode !== 0) return refused('k-board', r)
  const brief = JSON.parse(r.stdout) as Brief
  const picked = brief.ids.length ? await turn.pick(boardScreen(brief, await nowOf($))) : null
  return picked === null ? briefText(brief.text) : card($, turn.k, picked)
}

// A task's card as `k board --card <id>` prints it, markdown for the chat; an id k does not know answers its refusal.
async function card($: EngineInterface, k: string, id: string): Promise<string> {
  if (/\s/.test(id)) return `/k-board takes one task id or nothing, not ${id}.`
  // k would read it as a flag.
  if (id.startsWith('-')) return `/k-board: ${id} is not a task id.`
  const r = await $.process.run(['node', k, 'board', '--card', id])
  return r.exitCode !== 0 ? refused('k-board', r) : r.stdout.trimEnd()
}

// `/k-amendments`: the amendments waiting (AC-2), kept for a number, as the dialog's choices, where one picked shows in
// full and is approved or declined (AC-3, AC-8); when nothing ran, the answer says why and shows the list as a number takes it.
// `/k-amendments <n>`: that one in full, from the list last shown, read from its file.
async function amendments($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  const { k, args } = turn
  if (args.trim() === '') {
    // A list that could not be read leaves none to pick from, never the one before it (review G27).
    delete offered.amendments
    const r = await $.process.run(['node', k, 'waiting', '--json'])
    if (r.exitCode !== 0) return `k waiting did not answer: ${firstLine(r)}`
    const rows = (offered.amendments = (JSON.parse(r.stdout) as Waiting).amendments)
    if (!rows.length) return amendmentsText(rows)
    // The ones this session wrote: their approval, or its refusal, gets a turn here (turns.ts).
    noteAuthors(rows, await $.session.id().catch(() => ''))
    // Each one's file, read before the dialog opens, for the one picked to show in full; one that cannot be read shows
    // k waiting's words instead.
    const files = new Map<string, string>()
    for (const x of rows) {
      try {
        files.set(x.file, await $.fs.read(x.file))
      } catch {
        // amendmentLines says so.
      }
    }
    const out = await turn.dialog(amendmentsScreen(rows, files, await nowOf($)))
    return out.nothing === null ? out : `${nothingRan(out.nothing)}\n\n${amendmentsText(rows)}`
  }
  const picked = nth(args, offered.amendments, '/k-amendments')
  if (picked === null) return `/k-amendments ${args.trim()}: give an amendment's number from the list. Usage: /k-amendments [<n>]`
  if ('problem' in picked) return `/k-amendments ${args.trim()}: ${picked.problem}.`
  if (picked.rest.trim()) return `/k-amendments ${args.trim()}: unexpected ${picked.rest.trim()}.`
  let text
  try {
    text = await $.fs.read(picked.row.file)
  } catch (err) {
    return `/k-amendments ${picked.n}: ${picked.row.file} could not be read (${reason(err)}).`
  }
  return amendmentText(picked.n, picked.row, text)
}

// `/k-queue`: the queue in order, then the parked tasks, as the dialog's choices, where the one picked is moved, parked
// or put back (AC-17); a queue verb answers with the queue it left.
async function queueDialog($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  if (turn.args.trim()) return `/k-queue takes nothing, not ${turn.args.trim()}.`
  const r = await $.process.run(['node', turn.k, 'list', '--json', '--all'])
  if (r.exitCode !== 0) return refused('k-queue', r)
  const first = queueScreen(JSON.parse(r.stdout).rows)
  if (first === null) return 'The queue is empty, and no task is parked.'
  const out = await turn.dialog(first)
  return out.nothing === null ? out : nothingRan(out.nothing)
}

// `/k-drafts` (A-11's R27, R28; kirunak-drafts AC-2, AC-7, E-3): every draft in every repo, as k drafts gives them, as
// the dialog's choices (drafts.ts); each one's file read before the dialog opens, for the one picked to show whole.
// When nothing ran, the answer says why and shows the list.
async function draftsDialog($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  if (turn.args.trim()) return `/k-drafts takes nothing, not ${turn.args.trim()}.`
  const r = await $.process.run(['node', turn.k, 'drafts', '--json'])
  if (r.exitCode !== 0) return refused('k-drafts', r)
  const rows = JSON.parse(r.stdout) as DraftRow[]
  if (!rows.length) return draftsText(rows)
  const files = new Map<string, string>()
  for (const d of rows) {
    try {
      files.set(d.path, await $.fs.read(d.path))
    } catch {
      // draftLines says so.
    }
  }
  const out = await turn.dialog(draftsScreen(rows, files, await nowOf($)))
  if (out.ended !== undefined) return startIntake($, turn.k, out.ended)
  return out.nothing === null ? out : `${nothingRan(out.nothing)}\n\n${draftsText(rows)}`
}

// Start intake (AC-2, E-3): k drafts read again, and the draft found by its id, so one dropped or taken by an intake
// since the list was shown is refused by name, never another; then a prompt of its own, once this answer shows, that
// starts the intake with the k-intake skill (drafts.ts, intakePrompt). It runs no verb. The engine refuses a submit
// from inside a command.run hook (it would wait on the turn the hook holds: measured under `claude plugin test`), so
// a timer of the clock's submits it once the hook has answered (turns.ts, submitLater); the prompt then waits for the
// session to be idle, and one the engine refuses toasts why. The draft's file is read again for its first question
// (gulnya/mobile-dialogs AC-15, E-3), whose parts are written as dialogs of the mod's before the prompt is submitted,
// so the model's ask of them in its own turn gets their lines and their look (owner.ts's showIntake, look.tsx).
async function startIntake($: EngineInterface, k: string, id: string): Promise<string> {
  const r = await $.process.run(['node', k, 'drafts', '--json'])
  if (r.exitCode !== 0) return `Nothing ran: k drafts did not answer, so ${id} could not be found again: ${firstLine(r)}`
  const d = (JSON.parse(r.stdout) as DraftRow[]).find(x => x.id === id)
  if (d === undefined) return `Nothing ran: ${id} is no longer a draft. It was dropped, or its intake started, since the list was shown.`
  let file: string | null = null
  try {
    file = await $.fs.read(d.path)
  } catch {
    // The prompt goes without the first question's text; the skill says how to write it.
  }
  await showIntake($, firstQuestion(d, file === null ? [] : questionsOf(file)))
  submitLater($, intakePrompt(d, file), `The intake from ${id} did not start`)
  return `The intake from ${id} starts next in this session, with the k-intake skill.`
}

// `/k-bugs` (gulnya/kirunak-bugs AC-6, D-1): every bug in every repo, as k bugs gives them, a fix ready first, then the
// oldest, as the dialog's choices (bugs.ts); each one's file read before the dialog opens, for the one picked to show
// whole. Review & merge and Drop are verbs the dialog runs by id; Start fix ends it. When nothing ran, the answer says
// why and shows the list.
async function bugsDialog($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  if (turn.args.trim()) return `/k-bugs takes nothing, not ${turn.args.trim()}.`
  const r = await $.process.run(['node', turn.k, 'bugs', '--json'])
  if (r.exitCode !== 0) return refused('k-bugs', r)
  const rows = JSON.parse(r.stdout) as BugRow[]
  if (!rows.length) return bugsText(rows)
  const files = new Map<string, string>()
  for (const b of rows) {
    try {
      files.set(b.path, await $.fs.read(b.path))
    } catch {
      // bugLines says so.
    }
  }
  const run = await quadDamageStatus($, turn.k)
  const out = await turn.dialog(bugsScreen(rows, files, run, await nowOf($)))
  if (out.ended !== undefined) return startFix($, turn.k, out.ended)
  return out.nothing === null ? out : `${nothingRan(out.nothing)}\n\n${bugsText(rows, run)}`
}

// Quad Damage's run as `k bugs quad-damage --status --json` gives it (gulnya/quad-damage AC-12); null when k does not
// answer, so the list offers Quad Damage and k refuses a second run by its own reason (E-3).
async function quadDamageStatus($: EngineInterface, k: string): Promise<QuadDamageStatus | null> {
  try {
    const r = await $.process.run(['node', k, 'bugs', 'quad-damage', '--status', '--json'])
    return r.exitCode === 0 ? (JSON.parse(r.stdout) as QuadDamageStatus) : null
  } catch {
    return null
  }
}

// Start fix (AC-6, AC-8): k bugs read again, and the bug found by its id, so one dropped, merged or taken by an intake
// since the list was shown is refused by name, never another, and one whose Review & merge started since, or that Quad
// Damage is on, waits for it (k intake start would refuse it, E-4); then a prompt of its own, once this answer shows,
// as Start intake's, that starts the intake from the bug with the k-intake skill (bugs.ts, fixPrompt). It runs no verb.
async function startFix($: EngineInterface, k: string, id: string): Promise<string> {
  const r = await $.process.run(['node', k, 'bugs', '--json'])
  if (r.exitCode !== 0) return `Nothing ran: k bugs did not answer, so ${id} could not be found again: ${firstLine(r)}`
  const b = (JSON.parse(r.stdout) as BugRow[]).find(x => x.id === id)
  if (b === undefined) return `Nothing ran: ${id} is no longer a bug. It was dropped, merged, or its intake started, since the list was shown.`
  if (b.quadDamageRun) return `Nothing ran: ${fixOf(b).replace(/^Quad Damage is on it/, `Quad Damage is on ${id}`)}; its fix can be started once the run moves on.`
  if (b.reviewing) return `Nothing ran: ${id} is ${fixOf(b)}; its fix can be started once that review ends.`
  submitLater($, fixPrompt(b), `The intake from ${id} did not start`)
  return `The intake from ${id} starts next in this session, with the k-intake skill.`
}

// `/k-approve-amendment <n>`: `k approve <id> --amendment A-n` for the n-th of the list /k-amendments last showed; k
// checks it again as it runs (E-2).
async function approveAmendment($: EngineInterface, turn: Turn): Promise<string | Outcome> {
  const name = 'k-approve-amendment'
  const { args } = turn
  const picked = nth(args, offered.amendments, '/k-amendments')
  if (picked === null) return `/${name}${args.trim() ? ` ${args.trim()}` : ''}: which one? give its number from /k-amendments. Nothing ran.`
  if ('problem' in picked) return `/${name} ${args.trim()}: ${picked.problem}. Nothing ran.`
  if (picked.rest.trim()) return `/${name} ${args.trim()}: unexpected ${picked.rest.trim()}. Nothing ran.`
  return turn.typed(['approve', picked.row.id, '--amendment', picked.row.amendment, '--via', 'mod'])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Literal names, so `claude plugin validate` sees each hook answer its own command. /k-done stays the skill: it
    // needs the model (review.md §4).
    await $.command.register({ name: 'k-approve', description: 'Approve a kirunak task: k approve, as your own command', argumentHint: HINTS.approve })
    await $.command.register({ name: 'k-accept', description: 'Accept a reviewed kirunak task as done: k accept, as your own command', argumentHint: HINTS.accept })
    await $.command.register({ name: 'k-hold', description: 'Put a kirunak task on hold: k hold, as your own command', argumentHint: HINTS.hold })
    await $.command.register({ name: 'k-resume', description: 'Take a kirunak task off hold: k resume, as your own command', argumentHint: HINTS.resume })
    await $.command.register({ name: 'k-start', description: 'Name the kirunak task this session works on: k start', argumentHint: HINTS.start })
    await $.command.register({ name: 'k-list', description: 'The kirunak tasks k list shows, as a list for a phone', argumentHint: '[all]' })
    await $.command.register({ name: 'k-board', description: 'The kirunak board in brief: its groups in a dialog, then a group\'s tasks; a task tapped, or its id typed, shows its card', argumentHint: '[<id>]' })
    await $.command.register({ name: 'k-amendments', description: 'The amendments waiting for your approval, to approve or decline by touch; with a number, that one in full', argumentHint: '[<n>]' })
    await $.command.register({ name: 'k-approve-amendment', description: 'Approve an amendment /k-amendments listed: k approve --amendment, as your own command', argumentHint: '<n>' })
    await $.command.register({ name: 'k-queue', description: 'Show the kirunak queue and move, park or put back a task by touch' })
    await $.command.register({ name: 'k-drafts', description: 'The kirunak drafts, intakes prepared ahead: one shown whole, to start its intake or drop it by touch' })
    await $.command.register({ name: 'k-bugs', description: 'The kirunak bugs, a fix ready first: one shown whole, to review and merge its fix, start a fix or drop it by touch' })
    await $.command.register({ name: 'kirunak', description: 'Show or hide kirunak\'s pane: this session\'s task, the queue and the lock' })
    // A `claude -p` run draws nothing: it gets the commands, which refuse its origin, and no reads.
    if (e.isInteractive) {
      // A session that already has a task (resumed) gets its pane unasked, which the engine seats from 144 columns.
      void tick($).then(() => {
        if (sessionTask()) void $.ui.open({ id: PANE, title: 'kirunak' }).catch(() => undefined)
      })
      $.clock.every(EVERY_MS, () => {
        void tick($)
      })
    }

    return next(e)
  })

  // The engine puts the plugin's name before the first line of every answer (measured on the phone, kirunak-phone
  // AC-12), so no answer of the mod starts with it or names it again.
  // A hook that fails answers with the mod's own line instead of the engine's (review G22). The engine runs nothing
  // for a registered command whose hook failed either way; a failure after k started cannot be ruled out, so the line
  // says where to look.
  on('command.run', { command: 'k-approve' }, ($, e) => owners($, e, 'k-approve', t => ownerVerb($, t, 'k-approve', 'approve'))).catch(() => ({ text: FAILED('k-approve') }))
  on('command.run', { command: 'k-accept' }, ($, e) => owners($, e, 'k-accept', t => ownerVerb($, t, 'k-accept', 'accept'))).catch(() => ({ text: FAILED('k-accept') }))
  on('command.run', { command: 'k-hold' }, ($, e) => owners($, e, 'k-hold', t => ownerVerb($, t, 'k-hold', 'hold'))).catch(() => ({ text: FAILED('k-hold') }))
  on('command.run', { command: 'k-resume' }, ($, e) => owners($, e, 'k-resume', t => ownerVerb($, t, 'k-resume', 'resume'))).catch(() => ({ text: FAILED('k-resume') }))
  on('command.run', { command: 'k-start' }, ($, e) => owners($, e, 'k-start', t => ownerVerb($, t, 'k-start', 'start'))).catch(() => ({ text: FAILED('k-start') }))
  on('command.run', { command: 'k-list' }, ($, e) => owners($, e, 'k-list', t => list($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-list') }))
  on('command.run', { command: 'k-board' }, ($, e) => owners($, e, 'k-board', t => boardAnswer($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-board') }))
  on('command.run', { command: 'k-amendments' }, ($, e) => owners($, e, 'k-amendments', t => amendments($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-amendments') }))
  on('command.run', { command: 'k-approve-amendment' }, ($, e) => owners($, e, 'k-approve-amendment', t => approveAmendment($, t))).catch(() => ({ text: FAILED('k-approve-amendment') }))

  on('command.run', { command: 'k-queue' }, ($, e) => owners($, e, 'k-queue', t => queueDialog($, t), '\n\n')).catch(() => ({ text: FAILED('k-queue') }))
  on('command.run', { command: 'k-drafts' }, ($, e) => owners($, e, 'k-drafts', t => draftsDialog($, t), '\n\n')).catch(() => ({ text: FAILED('k-drafts') }))
  on('command.run', { command: 'k-bugs' }, ($, e) => owners($, e, 'k-bugs', t => bugsDialog($, t), '\n\n')).catch(() => ({ text: FAILED('k-bugs') }))

  on('session.end', ($, e, next) => {
    delete offered.approve
    delete offered.accept
    delete offered.amendments
    forgetRan()
    return next(e)
  })

  // The intakes and amendments this session runs itself, for the turns after the owner's verbs (turns.ts): the call
  // goes on as it came, and one that failed or was refused notes nothing. It never refuses: its catch replays what
  // the call settled to.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.deny === undefined && !r.isError) noteRan(e.command)
    } catch {
      // Nothing noted: the call's result stands.
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'kirunak' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'The pane is closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'kirunak' })
    void refresh($)
    return { text: opened.isPlaced ? 'The pane is open.' : `The pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'The pane could not be opened or closed; the debug log says why.' }))

  // At the terminal, the tasks a command can take come up in the typeahead as its id is typed.
  on('prompt.autocomplete', async ($, e, next) => {
    const mine = idSuggestions(e.text, e.start, e.token, lastRows())
    const theirs = await next(e)
    return mine.length ? { suggestions: [...theirs.suggestions, ...mine] } : theirs
  })

  // The dialogs' look and Quad Damage's rows on the phone and the desktop app (gulnya/mobile-dialogs D-1, look.tsx).
  looks(on)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, board))

    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text dimColor={line.tone === 'dim'} bold={line.tone === 'bold'} color={line.state ? PANE_COLORS[line.state] : 'text'} wrap="truncate-end">
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = e.props.hasSurvey ? null : bandLine(await read($, board))
    if (line === null) return next(e)
    const { Text } = $.ui.resolve(e)

    return (
      <Text dimColor wrap="truncate-end">
        {line}
      </Text>
    )
  })
}

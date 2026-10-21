import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { bandLine, paneLines } from './board'
import type { Tone } from './board'
import { argvFor, firstLine, HINTS, reason, refused } from './commands'
import type { Verb } from './commands'
import { amendmentsText, amendmentText, boardText, listText } from './lists'
import { nothingRan, owners } from './owner'
import type { Outcome, Turn } from './owner'
import { acceptScreen, amendmentsScreen, approveScreen, holdScreen, startScreen } from './picks'
import { lastRows, refresh, sessionTask, tick } from './reads'
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

const COLORS: Partial<Record<Tone, 'success' | 'error' | 'warning'>> = { success: 'success', error: 'error', warning: 'warning' }

// The owner's verbs (boards.md §4, approval.md §5): run only on the owner's own gesture, as `node k <verb> <id>
// --via mod`, with no model turn; the state line k prints is the command's output.
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

async function ownerVerb($: EngineInterface, turn: Turn, name: string, verb: Verb): Promise<string | Outcome> {
  let args = turn.args
  if ((verb === 'hold' || verb === 'start') && args.trim() === '') return pickTask($, turn, verb)
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

// `/k-board`: the board as lists in the chat (AC-5), as `k board --markdown` prints it.
async function boardAnswer($: EngineInterface, { k, args }: Turn): Promise<string> {
  if (args.trim()) return `/k-board takes nothing, not ${args.trim()}.`
  const r = await $.process.run(['node', k, 'board', '--markdown'])
  return r.exitCode !== 0 ? refused('k-board', r) : boardText(r.stdout)
}

// `/k-amendments`: the amendments waiting (AC-2), kept for a number, as the dialog's choices, where one picked is
// approved or declined (AC-3, AC-8); when nothing ran, the answer says why and shows the list as a number takes it.
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
    const out = await turn.dialog(amendmentsScreen(rows))
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
    await $.command.register({ name: 'k-start', description: 'Name the kirunak task this session works on: k start', argumentHint: HINTS.start })
    await $.command.register({ name: 'k-list', description: 'The kirunak tasks k list shows, as a list for a phone', argumentHint: '[all]' })
    await $.command.register({ name: 'k-board', description: 'The kirunak board as lists: the tasks worked on now, every task by state, the lock and the queue' })
    await $.command.register({ name: 'k-amendments', description: 'The amendments waiting for your approval, to approve or decline by touch; with a number, that one in full', argumentHint: '[<n>]' })
    await $.command.register({ name: 'k-approve-amendment', description: 'Approve an amendment /k-amendments listed: k approve --amendment, as your own command', argumentHint: '<n>' })
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
  on('command.run', { command: 'k-start' }, ($, e) => owners($, e, 'k-start', t => ownerVerb($, t, 'k-start', 'start'))).catch(() => ({ text: FAILED('k-start') }))
  on('command.run', { command: 'k-list' }, ($, e) => owners($, e, 'k-list', t => list($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-list') }))
  on('command.run', { command: 'k-board' }, ($, e) => owners($, e, 'k-board', t => boardAnswer($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-board') }))
  on('command.run', { command: 'k-amendments' }, ($, e) => owners($, e, 'k-amendments', t => amendments($, t), '\n\n')).catch(() => ({ text: READ_FAILED('k-amendments') }))
  on('command.run', { command: 'k-approve-amendment' }, ($, e) => owners($, e, 'k-approve-amendment', t => approveAmendment($, t))).catch(() => ({ text: FAILED('k-approve-amendment') }))

  on('session.end', ($, e, next) => {
    delete offered.approve
    delete offered.accept
    delete offered.amendments
    return next(e)
  })

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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(await read($, board))

    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text dimColor={line.tone === 'dim'} bold={line.tone === 'bold'} color={COLORS[line.tone] ?? 'text'} wrap="truncate-end">
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

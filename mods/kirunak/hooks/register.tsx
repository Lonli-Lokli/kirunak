import { atom, read } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, Register } from 'claude-code'

import { bandLine, paneLines } from './board'
import type { Tone } from './board'
import { argvFor, HINTS, isOwners, refusal } from './commands'
import type { Verb } from './commands'
import { kOf, lastRows, refresh, sessionTask, tick } from './reads'
import { byNumber, idSuggestions, offerText } from './waiting'
import type { Waiting } from './waiting'

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000
// How often the pane and the band read k list and k status when no event asked for a read sooner (boards.md §4).
const EVERY_MS = 30_000

const PANE = 'kirunak'
const FAILED = (name: string): string => `/${name} failed in the mod (the debug log says why); if k had started, \`k list --all\` shows whether it took.`
// The read's value, which reads.ts writes; the scan wants the reference written in the file that reads it.
const board = atom({ plugin: 'kirunak', key: 'board' } as const, null)

const COLORS: Partial<Record<Tone, 'success' | 'error' | 'warning'>> = { success: 'success', error: 'error', warning: 'warning' }

// The owner's verbs (boards.md §4, approval.md §5): run only on the owner's own gesture, as `node k <verb> <id>
// --via mod`, with no model turn; the state line k prints is the command's output.
// With no id, /k-approve and /k-accept list what waits for that verb; the ids shown, in order, are what `/k-accept <n>`
// takes. The module's own, so a reload asks for the list again, and `session.end` forgets it: `/clear` and a resume
// go on in the same process under another session, whose screen shows no such list (review G25).
const offered: Partial<Record<'approve' | 'accept', string[]>> = {}

async function offer($: EngineInterface, k: string, verb: 'approve' | 'accept'): Promise<string> {
  const r = await $.process.run(['node', k, 'waiting', '--json'])
  // A list that could not be read leaves none to pick from, never the one before it (review G27).
  delete offered[verb]
  if (r.exitCode !== 0) return `k waiting did not answer: ${(r.stderr || r.stdout).trim().split('\n')[0]}`
  const rows = (JSON.parse(r.stdout) as Waiting)[verb]
  offered[verb] = rows.map(row => row.id)
  return offerText(verb, rows)
}

async function ownerVerb($: EngineInterface, e: CommandRunInput, name: string, verb: Verb): Promise<CommandRunResult> {
  if (!isOwners(e.origin)) return { text: refusal(name, e.origin) }
  // What came from the phone says so, since the transcript does not keep where a command came from.
  const said = (text: string): CommandRunResult => ({ text: e.origin.kind === 'bridge' ? `${text}\n(typed in Remote Control)` : text })
  const k = await kOf($)
  if (!(await $.fs.exists(k))) return said(`/${name}: there is no k at ${k}, so nothing ran.`)
  let args = e.args
  if (verb === 'approve' || verb === 'accept') {
    if (args.trim() === '') return said(await offer($, k, verb))
    const picked = byNumber(args, offered[verb])
    if (picked !== null && 'problem' in picked) return said(`/${name} ${args.trim()}: ${picked.problem}. Nothing ran.`)
    if (picked !== null) args = picked.args
  }
  const parsed = argvFor(verb, args)
  if ('problem' in parsed) return said(`/${name}: ${parsed.problem}. Nothing ran. Usage: /${name} ${HINTS[verb]}`)
  const argv = verb === 'start' ? [...parsed.argv, '--session', await $.session.id()] : parsed.argv
  let r
  try {
    r = await $.process.run(['node', k, ...argv], { timeoutMs: COMMIT_MS })
  } catch (err) {
    return said(`/${name}: k did not finish (${err instanceof Error ? err.message : String(err)}); \`k list --all\` says whether it took.`)
  }
  void refresh($)
  if (r.exitCode !== 0) return said(`/${name} refused:\n${(r.stderr || r.stdout).trim()}`)
  if (verb === 'start') void $.ui.open({ id: PANE, title: 'kirunak' }).catch(() => undefined)
  return said(r.stdout.trim())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Literal names, so `claude plugin validate` sees each hook answer its own command. /k-done stays the skill: it
    // needs the model (review.md §4).
    await $.command.register({ name: 'k-approve', description: 'Approve a kirunak task: k approve, as your own command', argumentHint: HINTS.approve })
    await $.command.register({ name: 'k-accept', description: 'Accept a reviewed kirunak task as done: k accept, as your own command', argumentHint: HINTS.accept })
    await $.command.register({ name: 'k-hold', description: 'Put a kirunak task on hold: k hold, as your own command', argumentHint: HINTS.hold })
    await $.command.register({ name: 'k-start', description: 'Name the kirunak task this session works on: k start', argumentHint: HINTS.start })
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

  // A hook that fails answers with the mod's own line instead of the engine's (review G22). The engine runs nothing
  // for a registered command whose hook failed either way; a failure after k started cannot be ruled out, so the line
  // says where to look.
  on('command.run', { command: 'k-approve' }, ($, e) => ownerVerb($, e, 'k-approve', 'approve')).catch(() => ({ text: FAILED('k-approve') }))
  on('command.run', { command: 'k-accept' }, ($, e) => ownerVerb($, e, 'k-accept', 'accept')).catch(() => ({ text: FAILED('k-accept') }))
  on('command.run', { command: 'k-hold' }, ($, e) => ownerVerb($, e, 'k-hold', 'hold')).catch(() => ({ text: FAILED('k-hold') }))
  on('command.run', { command: 'k-start' }, ($, e) => ownerVerb($, e, 'k-start', 'start')).catch(() => ({ text: FAILED('k-start') }))

  on('session.end', ($, e, next) => {
    delete offered.approve
    delete offered.accept
    return next(e)
  })

  on('command.run', { command: 'kirunak' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'kirunak: the pane is closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'kirunak' })
    void refresh($)
    return { text: opened.isPlaced ? 'kirunak: the pane is open.' : `kirunak: the pane waits: ${opened.reason}` }
  }).catch(() => ({ text: 'kirunak: the pane could not be opened or closed; the debug log says why.' }))

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

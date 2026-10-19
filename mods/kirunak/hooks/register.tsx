import { atom, read } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface, Register } from 'claude-code'

import { bandLine, paneLines } from './board'
import type { Tone } from './board'
import { argvFor, HINTS, isOwners, refusal } from './commands'
import type { Verb } from './commands'
import { kOf, refresh, sessionTask, tick } from './reads'

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000
// How often the pane and the band read k list and k status when no event asked for a read sooner (boards.md §4).
const EVERY_MS = 30_000

const PANE = 'kirunak'
// The read's value, which reads.ts writes; the scan wants the reference written in the file that reads it.
const board = atom({ plugin: 'kirunak', key: 'board' } as const, null)

const COLORS: Partial<Record<Tone, 'success' | 'error' | 'warning'>> = { success: 'success', error: 'error', warning: 'warning' }

// The owner's verbs (boards.md §4, approval.md §5): run only on the owner's own gesture, as `node k <verb> <id>
// --via mod`, with no model turn; the state line k prints is the command's output.
async function ownerVerb($: EngineInterface, e: CommandRunInput, name: string, verb: Verb): Promise<CommandRunResult> {
  if (!isOwners(e.origin)) return { text: refusal(name, e.origin) }
  const parsed = argvFor(verb, e.args)
  if ('problem' in parsed) return { text: `/${name}: ${parsed.problem}. Nothing ran. Usage: /${name} ${HINTS[verb]}` }
  const k = kOf($)
  if (!(await $.fs.exists(k))) return { text: `/${name}: there is no k at ${k}, so nothing ran.` }
  const argv = verb === 'start' ? [...parsed.argv, '--session', await $.session.id()] : parsed.argv
  let r
  try {
    r = await $.process.run(['node', k, ...argv], { timeoutMs: COMMIT_MS })
  } catch (err) {
    return { text: `/${name}: k did not finish (${err instanceof Error ? err.message : String(err)}); \`k list --all\` says whether it took.` }
  }
  void refresh($)
  if (r.exitCode !== 0) return { text: `/${name} refused:\n${(r.stderr || r.stdout).trim()}` }
  if (verb === 'start') void $.ui.open({ id: PANE, title: 'kirunak' }).catch(() => undefined)
  return { text: r.stdout.trim() }
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

  on('command.run', { command: 'k-approve' }, ($, e) => ownerVerb($, e, 'k-approve', 'approve'))
  on('command.run', { command: 'k-accept' }, ($, e) => ownerVerb($, e, 'k-accept', 'accept'))
  on('command.run', { command: 'k-hold' }, ($, e) => ownerVerb($, e, 'k-hold', 'hold'))
  on('command.run', { command: 'k-start' }, ($, e) => ownerVerb($, e, 'k-start', 'start'))

  on('command.run', { command: 'kirunak' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'kirunak: the pane is closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'kirunak' })
    void refresh($)
    return { text: opened.isPlaced ? 'kirunak: the pane is open.' : `kirunak: the pane waits: ${opened.reason}` }
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

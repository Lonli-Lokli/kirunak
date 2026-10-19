import type { CommandRunInput, CommandRunResult, EngineInterface, Register } from 'claude-code'

import { argvFor, HINTS, isOwners, refusal } from './commands'
import type { Verb } from './commands'

// kirunak's command line, from the same checkout as this mod: mods/kirunak/../../bin/k.mjs.
const kOf = ($: EngineInterface): string => `${$.plugin.root}/../../bin/k.mjs`

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000

// The owner's verbs (boards.md §4, approval.md §5): run only on the owner's own gesture, as `node k <verb> <id> --via
// mod`, with no model turn; the state line k prints is the command's output.
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
  if (r.exitCode === 0) return { text: r.stdout.trim() }
  return { text: `/${name} refused:\n${(r.stderr || r.stdout).trim()}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Literal names, so `claude plugin validate` sees each hook answer its own command. /k-done stays the skill: it
    // needs the model (review.md §4).
    await $.command.register({ name: 'k-approve', description: 'Approve a kirunak task: k approve, as your own command', argumentHint: HINTS.approve })
    await $.command.register({ name: 'k-accept', description: 'Accept a reviewed kirunak task as done: k accept, as your own command', argumentHint: HINTS.accept })
    await $.command.register({ name: 'k-hold', description: 'Put a kirunak task on hold: k hold, as your own command', argumentHint: HINTS.hold })
    await $.command.register({ name: 'k-start', description: 'Name the kirunak task this session works on: k start', argumentHint: HINTS.start })

    return next(e)
  })

  on('command.run', { command: 'k-approve' }, ($, e) => ownerVerb($, e, 'k-approve', 'approve'))
  on('command.run', { command: 'k-accept' }, ($, e) => ownerVerb($, e, 'k-accept', 'accept'))
  on('command.run', { command: 'k-hold' }, ($, e) => ownerVerb($, e, 'k-hold', 'hold'))
  on('command.run', { command: 'k-start' }, ($, e) => ownerVerb($, e, 'k-start', 'start'))
}

import type { CommandRunInput, CommandRunResult, EngineInterface } from 'claude-code'

import { isOwners, reason, refusal, refused } from './commands'
import { kOf, refresh } from './reads'

// The owner-only rule (kirunak-phone AC-4, D-1; approval.md §5), held by this module's shape:
// - a command's turn (Turn) is made only by owners(), in the command's own command.run hook, after the command's origin passed (composer or
//   bridge), and closes when that hook answers;
// - a verb runs only through runVerb, which this module keeps to itself and calls once, as the hook answers, for an
//   Outcome this same turn made: the verb typed on the command line itself;
// - no other hook, no later command and no dialog the model raised can make such an Outcome or reach runVerb.

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000

// The verbs a turn may run: k's owner verbs, never a read or a session's own command.
const VERBS = /^(?:approve|accept|hold|start|amend decline|queue (?:add|move|remove))$/

// How a command's turn ends: why nothing ran, or (nothing null) the verb chosen in it, which only this module reads.
export type Outcome = { readonly nothing: string | null }

type Chosen = { turn: object; argv: readonly string[]; after: ((ok: boolean) => void) | undefined }
const chosen = new WeakMap<Outcome, Chosen>()

// What a command's own hook is handed once its origin passed: what was typed after the command's name, the checkout's
// k, and the one way to a verb from it. The engine ($) is the hook's own, which the scan follows only into functions
// declared at the top of a file, never into a callback or an object.
export type Turn = {
  readonly args: string
  readonly k: string
  // The verb the owner typed on the command line itself (`/k-accept <id>`, `/k-accept 2`), run as the hook answers;
  // `after` is told whether k took it.
  typed(argv: readonly string[], after?: (ok: boolean) => void): Outcome
}

export const nothingRan = (why: string): string => `Nothing ran: ${why}.`

// An owner's verb as `node k <argv>`, with the time a commit takes; k's state line, or why it did not take.
async function runVerb($: EngineInterface, name: string, k: string, argv: readonly string[]): Promise<{ ok: boolean; text: string }> {
  let r
  try {
    r = await $.process.run(['node', k, ...argv], { timeoutMs: COMMIT_MS })
  } catch (err) {
    return { ok: false, text: `/${name}: k did not finish (${reason(err)}); \`k list --all\` says whether it took.` }
  }
  void refresh($)
  return r.exitCode !== 0 ? { ok: false, text: refused(name, r) } : { ok: true, text: r.stdout.trim() }
}

// The answer of `/<name>`'s own command.run hook: refuses every origin but the owner's with a line, before anything is
// read or asked; says when there is no k; otherwise runs `body` and answers with its text, or runs the verb its turn
// chose. What came from the phone says so, since the transcript does not keep where a command came from; after a
// blank line (`gap`) under a markdown answer, so it is not read as its list's last entry.
export async function owners($: EngineInterface, e: CommandRunInput, name: string, body: (turn: Turn) => Promise<string | Outcome>, gap = '\n'): Promise<CommandRunResult> {
  if (!isOwners(e.origin)) return { text: refusal(name, e.origin) }
  const text = await answer($, name, e.args, body)
  return { text: e.origin.kind === 'bridge' ? `${text}${gap}(typed in Remote Control)` : text }
}

async function answer($: EngineInterface, name: string, args: string, body: (turn: Turn) => Promise<string | Outcome>): Promise<string> {
  const k = await kOf($)
  if (!(await $.fs.exists(k))) return `/${name}: there is no k at ${k}, so nothing ran.`
  const me = {}
  let open = true
  const turn: Turn = {
    args,
    k,
    typed: (argv, after) => {
      if (!open) throw new Error(`/${name}: a verb after the command answered`)
      return choose(me, argv, after)
    },
  }
  let out
  try {
    out = await body(turn)
  } finally {
    open = false
  }
  if (typeof out === 'string') return out
  if (out.nothing !== null) return nothingRan(out.nothing)
  const verb = chosen.get(out)
  chosen.delete(out)
  if (verb === undefined || verb.turn !== me) throw new Error(`/${name}: a verb this command did not choose`)
  const r = await runVerb($, name, k, verb.argv)
  verb.after?.(r.ok)
  return r.text
}

function choose(turn: object, argv: readonly string[], after?: (ok: boolean) => void): Outcome {
  const head = argv.slice(0, argv[0] === 'amend' || argv[0] === 'queue' ? 2 : 1).join(' ')
  if (!VERBS.test(head)) throw new Error(`not an owner's verb: ${head}`)
  const out: Outcome = { nothing: null }
  chosen.set(out, { turn, argv: [...argv], after })
  return out
}

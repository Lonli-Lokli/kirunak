import type { CommandRunInput, CommandRunResult, EngineInterface } from 'claude-code'

import { isOwners, reason, refusal, refused } from './commands'
import { plainLines, queueNow } from './lists'
import type { Item } from './lists'
import { kOf, refresh } from './reads'

// The owner-only rule (kirunak-phone AC-4, D-1; approval.md §5), held by this module's shape:
// - a command's turn (Turn) is made only by owners(), in the command's own command.run hook, after the command's
//   origin passed (composer or bridge), and closes when that hook answers;
// - the dialog ($.ui.ask) is opened only by a turn, at most once, while its hook runs; its answer acts only when it
//   equals a choice it offered, and a verb choice stands only in an item dialog, under the item's own words;
// - a verb runs only through runVerb, which this module keeps to itself and calls once, as the hook answers, for an
//   Outcome this same turn made: the verb typed on the command line itself, or the verb choice that was the dialog's
//   last tap (a turn that opened its dialog can type none);
// - no other hook, no later command and no dialog the model raised can make such an Outcome or reach runVerb: the mod
//   has no hook on AskUserQuestion, and a tap reaches nothing but the dialog's own loop.

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000

// The verbs a turn may run: k's owner verbs, never a read or a session's own command.
const VERBS = /^(?:approve|accept|hold|start|amend decline|queue (?:add|move|remove))$/

// How a command's turn ends: why nothing ran, or (nothing null) the verb chosen in it, which only this module reads.
export type Outcome = { readonly nothing: string | null }

// `tapped`: chosen by the dialog's last tap, not typed.
type Chosen = { turn: object; tapped: boolean; argv: readonly string[]; after: ((ok: boolean) => void) | undefined }
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
  // The command's dialog, from `first`, until a verb choice is tapped (its Outcome) or nothing will run (why).
  dialog(first: Screen): Promise<Outcome>
}

// A list dialog's row: its words (numbered above the choices as the app numbers them), its choice's short name, and
// the dialog that choice opens.
export type Row = { item: Item; label: string; open: () => Screen | Promise<Screen> }
// An item dialog's choice: one that opens another dialog, or a verb, run if it is the last tap; its `after` is told
// whether k took it, as a typed verb's is.
export type Choice = { label: string; open: () => Screen | Promise<Screen> } | { label: string; verb: readonly string[]; after?: (ok: boolean) => void }
// One dialog: `header` is its chip (12 characters at most), `question` its last line, ending in a question mark.
// - list: `head`, then the rows of one page (three and More when there are more than four; one fewer under Back);
// - item: the item's own words (`text`), then its choices, a verb's among them;
// - reason: the item's words; the reason is typed in the free-text row and handed to `given`, choices Back and Cancel.
export type Screen =
  | { kind: 'list'; header: string; head: string; rows: readonly Row[]; question: string }
  | { kind: 'item'; header: string; text: readonly string[]; choices: readonly Choice[]; question: string }
  | { kind: 'reason'; header: string; text: readonly string[]; question: string; given: (why: string) => Screen }

// What the dialog's Skip answers (measured on the phone, kirunak-phone S-1), and the dialog's own choices.
const SKIP = '[No preference]'
const MORE = 'More'
const BACK = 'Back'
const CANCEL = 'Cancel'
// The most choices a dialog has.
const CHOICES = 4

export const nothingRan = (why: string): string => `Nothing ran: ${why}.`

// An owner's verb as `node k <argv>`, with the time a commit takes; k's state line (a queue verb's: the queue it left),
// or why it did not take.
async function runVerb($: EngineInterface, name: string, k: string, argv: readonly string[]): Promise<{ ok: boolean; text: string }> {
  let r
  try {
    r = await $.process.run(['node', k, ...argv], { timeoutMs: COMMIT_MS })
  } catch (err) {
    return { ok: false, text: `/${name}: k did not finish (${reason(err)}); \`k list --all\` says whether it took.` }
  }
  void refresh($)
  if (r.exitCode !== 0) return { ok: false, text: refused(name, r) }
  return { ok: true, text: argv[0] === 'queue' ? queueNow(r.stdout) : r.stdout.trim() }
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
  let asked = false
  const turn: Turn = {
    args,
    k,
    typed: (argv, after) => {
      if (!open) throw new Error(`/${name}: a verb after the command answered`)
      if (asked) throw new Error(`/${name}: a typed verb after the dialog`)
      return choose(me, false, argv, after)
    },
    dialog: first => {
      if (!open) throw new Error(`/${name}: a dialog after the command answered`)
      if (asked) throw new Error(`/${name}: a second dialog`)
      asked = true
      return talk($, me, first)
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
  // A verb this turn did not choose, or a typed one where the dialog was opened, never runs.
  if (verb === undefined || verb.turn !== me || verb.tapped !== asked) throw new Error(`/${name}: a verb this command did not choose`)
  const r = await runVerb($, name, k, verb.argv)
  verb.after?.(r.ok)
  return r.text
}

function choose(turn: object, tapped: boolean, argv: readonly string[], after?: (ok: boolean) => void): Outcome {
  const head = argv.slice(0, argv[0] === 'amend' || argv[0] === 'queue' ? 2 : 1).join(' ')
  if (!VERBS.test(head)) throw new Error(`not an owner's verb: ${head}`)
  const out: Outcome = { nothing: null }
  chosen.set(out, { turn, tapped, argv: [...argv], after })
  return out
}

// What a dialog's choice does.
type Act = { open: () => Screen | Promise<Screen> } | { verb: readonly string[]; after: ((ok: boolean) => void) | undefined } | 'back' | 'more' | 'cancel'
type Drawn = { question: string; choices: { label: string; act: Act }[] }
type Frame = { screen: Screen; start: number }

// The dialog's loop: each answer acts only when it equals a choice offered (or is a reason typed in a reason dialog);
// Skip, a dismissal or any other text ends it with nothing run; Back shows the dialog before again; a verb choice
// ends it with that verb, the turn's.
async function talk($: EngineInterface, turn: object, first: Screen): Promise<Outcome> {
  const stack: Frame[] = [{ screen: first, start: 0 }]
  for (;;) {
    const frame = stack[stack.length - 1] as Frame
    const { question, choices } = draw(frame, stack.length > 1)
    let tap
    try {
      tap = await $.ui.ask(question, { options: choices.map(c => c.label), header: frame.screen.header })
    } catch {
      return { nothing: 'dismissed' }
    }
    if (tap === SKIP) return { nothing: 'skipped' }
    const act = choices.find(c => c.label === tap)?.act
    if (act === undefined) {
      if (frame.screen.kind !== 'reason') return { nothing: 'the answer was none of the choices' }
      const why = tap.trim()
      if (!why) return { nothing: 'no reason was typed' }
      stack.push({ screen: frame.screen.given(why), start: 0 })
    } else if (act === 'back') stack.pop()
    else if (act === 'more') stack.push({ screen: frame.screen, start: frame.start + choices.filter(c => typeof c.act === 'object').length })
    else if (act === 'cancel') return { nothing: 'cancelled' }
    else if ('verb' in act) return choose(turn, true, act.verb, act.after)
    else stack.push({ screen: await act.open(), start: 0 })
  }
}

// A dialog's question and choices: a list's page from `start`; Back on every dialog but the command's first; Cancel
// when there would be one choice alone, which the dialog would pad with Yes and No.
function draw({ screen, start }: Frame, back: boolean): Drawn {
  const choices: Drawn['choices'] = []
  let lines: string[]
  if (screen.kind === 'list') {
    const slots = CHOICES - (back ? 1 : 0)
    const rest = screen.rows.slice(start)
    const page = rest.length <= slots ? rest : rest.slice(0, slots - 1)
    const paged = start > 0 || page.length < rest.length
    lines = [paged ? `${screen.head} (${start + 1} to ${start + page.length} of ${screen.rows.length})` : screen.head, ...plainLines(page.map(r => r.item))]
    choices.push(...page.map(r => ({ label: r.label, act: { open: r.open } })))
    if (back) choices.push({ label: BACK, act: 'back' })
    if (page.length < rest.length) choices.push({ label: MORE, act: 'more' })
  } else {
    if (!screen.text.length) throw new Error('an item dialog shows the item')
    lines = [...screen.text]
    if (screen.kind === 'item') choices.push(...screen.choices.map(c => ({ label: c.label, act: 'verb' in c ? { verb: c.verb, after: c.after } : { open: c.open } })))
    if (back) choices.push({ label: BACK, act: 'back' })
    if (screen.kind === 'reason') choices.push({ label: CANCEL, act: 'cancel' })
  }
  if (choices.length === 1) choices.push({ label: CANCEL, act: 'cancel' })
  const labels = choices.map(c => c.label)
  if (!labels.length || labels.length > CHOICES || new Set(labels).size < labels.length || labels.some(l => !l.trim() || /^\d/.test(l) || l === SKIP)) {
    throw new Error(`a dialog's choices are 1 to ${CHOICES} short names, unique, none starting with a number: ${labels.join(' | ')}`)
  }
  return { question: [...lines, screen.question].join('\n'), choices }
}

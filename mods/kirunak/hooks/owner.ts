import { atom, update } from 'claude-code'
import type { CommandRunInput, CommandRunResult, EngineInterface } from 'claude-code'

import type { KirunakDialog, KirunakLook } from '../types'

import { quadDamageStarted, quadDamageStopping, reviewStarted } from './bugs'
import { isOwners, reason, refusal, refused } from './commands'
import { queueNow, unmarked } from './lists'
import type { Item } from './lists'
import { kOf, refresh } from './reads'
import { told } from './turns'
import { capBlocking } from './waiting'

// The owner-only rule (kirunak-phone AC-4, D-1; approval.md §5), held by this module's shape:
// - a command's turn (Turn) is made only by owners(), in the command's own command.run hook, after the command's
//   origin passed (composer or bridge), and closes when that hook answers;
// - the dialog ($.ui.ask) is opened only by a turn, at most once, while its hook runs; its answer acts only when it
//   equals a choice it offered, and a verb choice stands under the item's own words (an item dialog's, or /k-queue's
//   Move list's Earlier and Later, under the task's lines, kirunak-phone A-11);
// - a verb runs only through runVerb, which this module keeps to itself and calls once, as the hook answers, for an
//   Outcome this same turn made: the verb typed on the command line itself, or the verb choice that was the dialog's
//   last tap (a turn that opened its dialog can type none);
// - no other hook, no later command and no dialog the model raised can make such an Outcome or reach runVerb: the mod's
//   hooks on AskUserQuestion (look.tsx, gulnya/mobile-dialogs D-1) write each choice's line into the call and draw the
//   dialog's look, and never answer it; the look's buttons only fold and unfold it, and a tap reaches nothing but the
//   dialog's own loop;
// - a dialog that runs no verb (`pick`, /k-board's) offers labels alone, no verb choice, and ends on a tap with such a
//   label, which the command reads; a choice of it may open the next step, always another pick dialog (checked as it
//   opens), so no verb choice is ever reached from it; it is the turn's one dialog, so no verb is typed after it;
// - an item's `ends` choice (/k-drafts' Start intake, /k-bugs' Start fix) ends a verb's dialog with nothing run,
//   handing its value to the command, which runs no verb with it (it submits a prompt); the turn's one dialog, so no
//   verb is typed after it;
// - once a verb ran, the session may get a turn of its own (turns.ts, gulnya/kirunak-bugs AC-11 to AC-14): a prompt
//   submitted after the answer, which says what the owner did and runs no verb.

// An owner's verb commits with the repo's git hooks, as `!` does, so it gets the ten minutes $.process.run allows.
const COMMIT_MS = 600_000

// The verbs a turn may run: k's owner verbs, `bug review` among them (Review & merge, gulnya/kirunak-bugs AC-5) and
// `bugs quad-damage` (Quad Damage, gulnya/quad-damage AC-1), and `draft drop` and `bug drop` (no owner's verbs in k,
// A-11's R27, but writes the mod makes only on the owner's tap); never a read or a session's own command.
const VERBS = /^(?:approve|accept|hold|resume|start|amend decline|queue (?:add|move|remove)|draft drop|bug (?:review|drop)|bugs quad-damage)$/

// How a command's turn ends: why nothing ran, or (nothing null) the verb chosen in it, which only this module reads;
// `ended`, with nothing set, is the value of the `ends` choice that ended the dialog (/k-drafts' Start intake, /k-bugs'
// Start fix).
export type Outcome = { readonly nothing: string | null; readonly ended?: string }

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
  // The command's dialog, from `first`, until a verb choice is tapped (its Outcome) or nothing will run (why, and
  // `ended` when an `ends` choice was tapped).
  dialog(first: Screen): Promise<Outcome>
  // A dialog that runs no verb (/k-board), in steps: the label that ended it, or null for Skip, a dismissal, Cancel or
  // any other answer, at any step.
  pick(first: PickScreen): Promise<string | null>
}

// A list dialog's row: its words (numbered above the choices as the app numbers them, or in a list of `places` by its
// own `place`, none when null: /k-queue's, kirunak-phone A-11), its choice's short name, and the dialog that choice
// opens, or the verb it runs, the last tap (A-11's Earlier and Later, the task's text above them).
// `description`: its choice's line, as every choice's below (gulnya/mobile-dialogs AC-14); with none, the line is the
// item's words after its name, as the list's numbered line said them before (AC-23).
export type Row = { item: Item; label: string; place?: number | null; description?: string } & ({ open: () => Screen | Promise<Screen> } | { verb: readonly string[] })
// An item dialog's choice: one that opens another dialog, or a verb, run if it is the last tap; its `after` is told
// whether k took it, as a typed verb's is; or one that `ends` the dialog with nothing run, its value the Outcome's
// `ended`, for the command to read.
// `description`: the one line the dialog shows under its label, in its own words (gulnya/mobile-dialogs AC-14).
export type Choice =
  | { label: string; description?: string; open: () => Screen | Promise<Screen> }
  | { label: string; description?: string; verb: readonly string[]; after?: (ok: boolean) => void }
  | { label: string; description?: string; ends: string }
// One dialog: `header` is its chip (12 characters at most), `question` its last line, ending in a question mark.
// - list: the rows of one page (three and More when there are more than four; one fewer under Back), asked in one
//   line, `head` and the page's range before the question: "Bugs, a fix ready first, then the oldest (1 to 3 of 22):
//   Which bug?" (gulnya/mobile-dialogs AC-23); each row's words are its choice's line, never the question's; with
//   `typed`, the rows are the list a typed number takes (`/k-approve <n>`), in its order, so on a page after the first
//   each line adds that number: "proposed (type 4)" (kirunak-phone Q-33); with `places`, each line starts with the
//   row's place; `text`, when given, above that line on every page (what the list is not: the task being moved);
// - item: the item's own words (`text`), then its choices, a verb's among them, and Cancel with `cancel`;
// - reason: the item's words; the reason is typed in the free-text row and handed to `given`, choices Back and Cancel;
// - pick: `text` whole on every page, then a page of `labels`, paged as a list's rows, the page named in the question
//   ("Which task's card (4 to 5 of 11)?"), `head`, when given, before it on its line, as a list's; `described`, each
//   label's line (a step's its own); a label tapped ends the dialog, a step opens its next pick dialog, with Back
//   (A-9's AC-5: /k-board's groups, then a group's tasks).
// `look`, when given: what the phone and the desktop app draw above the choices (gulnya/mobile-dialogs D-1, look.tsx);
// a list's look rows are those of its page alone. The question asked is the same with it or without.
export type Look = KirunakLook
export type PickStep = { label: string; description?: string; open: () => PickScreen }
export type PickScreen = { kind: 'pick'; header: string; text: readonly string[]; head?: string; labels: readonly (string | PickStep)[]; described?: Readonly<Record<string, string>>; question: string; look?: Look }
export type Screen =
  | { kind: 'list'; header: string; text?: readonly string[]; head: string; rows: readonly Row[]; question: string; typed?: true; places?: true; look?: Look }
  | { kind: 'item'; header: string; text: readonly string[]; choices: readonly Choice[]; question: string; cancel?: true; look?: Look }
  | { kind: 'reason'; header: string; text: readonly string[]; question: string; given: (why: string) => Screen; look?: Look }
  | PickScreen

// What the dialog's Skip answers (measured on the phone, kirunak-phone S-1), and the dialog's own choices.
const SKIP = '[No preference]'
const MORE = 'More'
const BACK = 'Back'
const CANCEL = 'Cancel'
// The most choices a dialog has.
const CHOICES = 4
// The dialog's own choices' lines (gulnya/mobile-dialogs AC-14).
const OWN: Record<string, string> = { [MORE]: 'the next ones', [BACK]: 'the dialog before', [CANCEL]: 'nothing runs' }

// The dialog open now, for the look's hook (look.tsx), which reads it while drawing and never writes it.
const dialogState = atom({ plugin: 'kirunak', key: 'dialog' } as const, null)
// A new id each dialog shown, so a fold left open in one is closed in the next (look.tsx).
let shownId = 0

// The parts of a draft's first question that Start intake wrote, for the model to ask in a turn of its own (drafts.ts,
// gulnya/mobile-dialogs AC-15, E-3); the look's hooks read them as they read the dialog open now.
const intakeState = atom({ plugin: 'kirunak', key: 'intake' } as const, null)

// Every choice's line and the dialog's look, its page's rows, written before it is asked and taken away once it is
// answered or dismissed; a write that fails leaves the dialog unstyled, never unasked (gulnya/mobile-dialogs D-1).
// A dialog of the mod's own takes away a draft's first question too: once another dialog opens, the intake it was for
// has gone on, or was set aside, so the model's ask of it later draws as the engine draws it.
async function showLook($: EngineInterface, look: KirunakDialog | null): Promise<void> {
  try {
    await update($, dialogState, () => look)
    if (look !== null) await update($, intakeState, () => null)
  } catch {
    // The dialog is asked as it is.
  }
}

// A draft's first question, written before Start intake's prompt is submitted (AC-15, E-3): a dialog a part, each with
// its question as the prompt gives it, its choices' lines and its look, until the call of one is answered with
// anything but Next or Back (look.tsx) or another dialog of the mod's opens (showLook). None for a draft that
// proposes nothing; a write that fails leaves the question to be asked as the model writes it.
export async function showIntake($: EngineInterface, asks: readonly { question: string; ask: string; described: Record<string, string>; look: KirunakLook }[]): Promise<void> {
  try {
    await update($, intakeState, () => (asks.length ? asks.map(a => ({ id: ++shownId, question: a.question, ask: a.ask, described: { ...a.described }, look: a.look })) : null))
  } catch {
    // The model asks it as the prompt says.
  }
}

export const nothingRan = (why: string): string => `Nothing ran: ${why}.`

// An owner's verb as `node k <argv>`, with the time a commit takes; k's state line (a queue verb's: the queue it left;
// Review & merge's: what runs now and where its result shows), or why it did not take.
// `said`: what k said, for the turn after it (turns.ts): its state line, or its reason.
async function runVerb($: EngineInterface, name: string, k: string, argv: readonly string[]): Promise<{ ok: boolean; text: string; said: string }> {
  let r
  try {
    r = await $.process.run(['node', k, ...argv], { timeoutMs: COMMIT_MS })
  } catch (err) {
    return { ok: false, text: `/${name}: k did not finish (${reason(err)}); \`k list --all\` says whether it took.`, said: `k did not finish (${reason(err)}); \`k list --all\` says whether it took.` }
  }
  void refresh($)
  const said = r.exitCode !== 0 ? capBlocking((r.stderr || r.stdout).trim().split('\n')).join('\n') : r.stdout.trim()
  if (r.exitCode !== 0) return { ok: false, text: refused(name, r), said }
  if (argv[0] === 'bug' && argv[1] === 'review') return { ok: true, text: reviewStarted(argv[2] ?? '', r.stdout), said }
  if (argv[0] === 'bugs' && argv[1] === 'quad-damage') return { ok: true, text: argv.includes('--stop') ? quadDamageStopping(r.stdout) : quadDamageStarted(r.stdout), said }
  return { ok: true, text: argv[0] === 'queue' ? queueNow(r.stdout) : r.stdout.trim(), said }
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
    dialog: async first => {
      if (!open) throw new Error(`/${name}: a dialog after the command answered`)
      if (asked) throw new Error(`/${name}: a second dialog`)
      asked = true
      const out = await talk($, name, me, first)
      if ('picked' in out) throw new Error(`/${name}: a pick in a verb's dialog`)
      return out
    },
    pick: async first => {
      if (!open) throw new Error(`/${name}: a dialog after the command answered`)
      if (asked) throw new Error(`/${name}: a second dialog`)
      if (first.kind !== 'pick') throw new Error(`/${name}: a pick that opens no pick dialog`)
      asked = true
      const out = await talk($, name, me, first)
      return 'picked' in out ? out.picked : null
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
  // The session's turn after it, when it gets one (turns.ts); it runs no verb.
  await told($, { name, k, argv: verb.argv, tapped: verb.tapped, ok: r.ok, said: r.said })
  return r.text
}

function choose(turn: object, tapped: boolean, argv: readonly string[], after?: (ok: boolean) => void): Outcome {
  const head = argv.slice(0, argv[0] === 'amend' || argv[0] === 'queue' || argv[0] === 'draft' || argv[0] === 'bug' || argv[0] === 'bugs' ? 2 : 1).join(' ')
  if (!VERBS.test(head)) throw new Error(`not an owner's verb: ${head}`)
  const out: Outcome = { nothing: null }
  chosen.set(out, { turn, tapped, argv: [...argv], after })
  return out
}

// What a dialog's choice does.
type Act = { open: () => Screen | Promise<Screen> } | { verb: readonly string[]; after: ((ok: boolean) => void) | undefined } | { pick: string } | 'back' | 'more' | 'cancel'
// `text` and `ask`: the question's lines above it and its last line, as drawn, for the dialog log.
// `described`: each choice's line by its label, the dialog's own choices' among them.
type Drawn = { question: string; text: string[]; ask: string; choices: { label: string; act: Act }[]; described: Record<string, string> }
type Frame = { screen: Screen; start: number }

// The dialog's loop: each answer acts only when it equals a choice offered (or is a reason typed in a reason dialog);
// Skip, a dismissal or any other text ends it with nothing run; Back shows the dialog before again; a verb choice
// ends it with that verb, the turn's. Words typed in the free-text row that equal a choice exactly are that choice:
// $.ui.ask gives one string for a tap and for typed text, and they are the owner's own words, with the id, under the
// item's text, in the owner's own command's dialog (S-7 review, finding 4; approval.md §5).
async function talk($: EngineInterface, name: string, turn: object, first: Screen): Promise<Outcome | { picked: string }> {
  const stack: Frame[] = [{ screen: first, start: 0 }]
  for (;;) {
    const frame = stack[stack.length - 1] as Frame
    const drawn = draw(frame, stack.length > 1)
    const { question, choices } = drawn
    const shown: Logged = { t: await askedAt($), command: name, header: frame.screen.header, drawn }
    const look = frame.screen.look
    const labels = choices.map(c => c.label)
    await showLook($, { id: ++shownId, question, ask: drawn.ask, described: drawn.described, look: look ? { ...look, rows: look.rows.filter(r => labels.includes(r.id)) } : null })
    let tap
    try {
      tap = await $.ui.ask(question, { options: labels, header: frame.screen.header })
    } catch {
      await logDialog($, shown, null, 'dismissed')
      return { nothing: 'dismissed' }
    } finally {
      await showLook($, null)
    }
    const act = tap === SKIP ? undefined : choices.find(c => c.label === tap)?.act
    const ends = tap === SKIP ? 'skipped' : act === undefined ? (frame.screen.kind === 'reason' && tap.trim() && !tap.trim().startsWith('--') ? null : 'typed') : typeof act !== 'object' ? (act === 'cancel' ? 'cancelled' : null) : 'verb' in act ? act.verb.join(' ') : 'pick' in act ? 'picked' : null
    await logDialog($, shown, tap === SKIP ? null : tap, ends)
    if (tap === SKIP) return { nothing: 'skipped' }
    if (act === undefined) {
      if (frame.screen.kind !== 'reason') return { nothing: 'the answer was none of the choices' }
      const why = tap.trim()
      if (!why) return { nothing: 'no reason was typed' }
      // k takes a value starting with -- for a flag and refuses it; the mod says so itself (S-7 review, finding 8).
      if (why.startsWith('--')) return { nothing: 'the reason started with --, which k takes for a flag' }
      stack.push({ screen: frame.screen.given(why), start: 0 })
    } else if (act === 'back') stack.pop()
    else if (act === 'more') stack.push({ screen: frame.screen, start: frame.start + choices.filter(c => typeof c.act === 'object').length })
    else if (act === 'cancel') return { nothing: 'cancelled' }
    else if ('verb' in act) return choose(turn, true, act.verb, act.after)
    else if ('pick' in act) return frame.screen.kind === 'pick' ? { picked: act.pick } : { nothing: `${tap} ended the dialog`, ended: act.pick }
    else {
      const next = await act.open()
      // A pick's step opens a pick dialog alone, so a dialog that runs no verb never reaches a verb choice.
      if (frame.screen.kind === 'pick' && next.kind !== 'pick') throw new Error('a pick dialog opens only pick dialogs')
      stack.push({ screen: next, start: 0 })
    }
  }
}

// One page from `start`: all that are left when they fit beside Back, else one fewer and More; `range` names the page
// when there is more than one ("4 to 5 of 11").
function paging<T>(all: readonly T[], start: number, back: boolean): { page: readonly T[]; more: boolean; range: string | null } {
  const slots = CHOICES - (back ? 1 : 0)
  const rest = all.slice(start)
  const page = rest.length <= slots ? rest : rest.slice(0, slots - 1)
  const more = page.length < rest.length
  return { page, more, range: start > 0 || more ? `${start + 1} to ${start + page.length} of ${all.length}` : null }
}

// A dialog's question and choices: a list's or a pick's page from `start`, More after it; Cancel when there would be
// one choice alone, which the dialog would pad with Yes and No; and Back, on every dialog but the command's first, the
// lowest choice of all (kirunak-phone A-11's E-5).
// A list's question on one line: its head, less the colon it ends in, the page's range, then the question.
const listAsk = (head: string, range: string | null, question: string): string => `${head.replace(/:\s*$/, '')}${range !== null ? ` (${range})` : ''}: ${question}`

// A list row's line under its choice (AC-23): its own, else what its numbered line said after the name: the item's
// words, the number to type on a typed page after the first, and its `under` lines; with places, its place first.
function lineOf(r: Row, typed: number | null, places: boolean): string {
  if (r.description) return r.description
  const words = `${r.item.lead}${r.item.text.replace(/^[:.]?\s*/, '')}`.trim()
  const said = [`${words}${typed !== null ? ` (type ${typed})` : ''}`.trim(), ...(r.item.under ?? []).map(l => l.trim())].filter(Boolean).join('; ')
  return places && r.place != null ? `place ${r.place}${said ? `, ${said}` : ''}` : said
}

function draw({ screen, start }: Frame, back: boolean): Drawn {
  const choices: Drawn['choices'] = []
  const described: Record<string, string> = { ...OWN }
  let lines: string[]
  let question = screen.question
  if (screen.kind === 'list') {
    const { page, more, range } = paging(screen.rows, start, back)
    lines = [...(screen.text ?? [])]
    question = listAsk(screen.head, range, screen.question)
    choices.push(...page.map(r => ({ label: r.label, act: 'verb' in r ? { verb: r.verb, after: undefined } : { open: r.open } })))
    page.forEach((r, i) => {
      described[r.label] = unmarked(lineOf(r, screen.typed && start > 0 ? start + i + 1 : null, screen.places === true))
    })
    if (more) choices.push({ label: MORE, act: 'more' })
  } else if (screen.kind === 'pick') {
    if (!screen.text.length && screen.head === undefined) throw new Error('a pick dialog shows its text or its head')
    const { page, more, range } = paging(screen.labels, start, back)
    lines = [...screen.text]
    if (range !== null) question = question.replace(/\??$/, ` (${range})?`)
    if (screen.head !== undefined) question = listAsk(screen.head, null, question)
    choices.push(...page.map(l => (typeof l === 'string' ? { label: l, act: { pick: l } } : { label: l.label, act: { open: l.open } })))
    for (const l of page) {
      const line = typeof l === 'string' ? screen.described?.[l] : (l.description ?? screen.described?.[l.label])
      if (line) described[typeof l === 'string' ? l : l.label] = unmarked(line)
    }
    if (more) choices.push({ label: MORE, act: 'more' })
  } else {
    if (!screen.text.length) throw new Error('an item dialog shows the item')
    lines = [...screen.text]
    if (screen.kind === 'item') choices.push(...screen.choices.map(c => ({ label: c.label, act: 'verb' in c ? { verb: c.verb, after: c.after } : 'ends' in c ? { pick: c.ends } : { open: c.open } })))
    if (screen.kind === 'item') for (const c of screen.choices) if (c.description) described[c.label] = c.description
    if (screen.kind === 'reason' || (screen.kind === 'item' && screen.cancel)) choices.push({ label: CANCEL, act: 'cancel' })
  }
  if (choices.length + (back ? 1 : 0) === 1) choices.push({ label: CANCEL, act: 'cancel' })
  if (back) choices.push({ label: BACK, act: 'back' })
  const labels = choices.map(c => c.label)
  // A label may start with a digit (a task of the repo "2048"): the app's own number before it is cosmetic (S-1).
  if (!labels.length || labels.length > CHOICES || new Set(labels).size < labels.length || labels.some(l => !l.trim() || l === SKIP)) {
    throw new Error(`a dialog's choices are 1 to ${CHOICES} short names, unique and not blank: ${labels.join(' | ')}`)
  }
  // The lines of this dialog's choices alone, the dialog's own among them.
  const given = Object.fromEntries(labels.filter(l => described[l] !== undefined).map(l => [l, described[l] as string]))
  // Every question's one way out, so no text taken from the task files shows its marks as typed (S-10).
  return { question: unmarked([...lines, question].join('\n')), text: unmarked(lines.join('\n')).split('\n').filter((l, i, all) => all.length > 1 || l), ask: unmarked(question), choices, described: given }
}

// The dialog log (kirunak-docs-promo S-1 §3): one line a dialog shown, appended to <state>/dialogs.jsonl, where the
// state folder is $KIRUNAK_HOME else ~/.kirunak, as k finds it. It records the owner's gestures and nothing else: the
// command, what the dialog drew, the tap (or `typed`, words that were none of the choices) with its time, and `end`,
// how the dialog closed when it closed there (skipped, dismissed, cancelled, picked, typed, or the verb its tap
// chose). It never changes an answer: a log that cannot be written is left unwritten.
type Logged = { t: number | null; command: string; header: string; drawn: Drawn }
async function askedAt($: EngineInterface): Promise<number | null> {
  try {
    return await $.clock.now()
  } catch {
    return null
  }
}
async function logDialog($: EngineInterface, shown: Logged, tap: string | null, end: string | null): Promise<void> {
  try {
    const [state, home, session, tAnswer] = await Promise.all([$.env.get('KIRUNAK_HOME'), $.env.get('HOME'), $.session.id(), $.clock.now()])
    const dir = state || (home ? `${home}/.kirunak` : null)
    if (!dir) return
    const choices = shown.drawn.choices.map(c => c.label)
    const isChoice = tap !== null && choices.includes(tap)
    const line = JSON.stringify({
      t: shown.t, session, command: shown.command, header: shown.header, text: shown.drawn.text, question: shown.drawn.ask, choices,
      tap: isChoice ? tap : null, ...(tap !== null && !isChoice && { typed: tap }), tAnswer, end,
    })
    const path = `${dir}/dialogs.jsonl`
    const before = await $.fs.read(path).then(t => String(t), () => '')
    await $.fs.write(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`)
  } catch {
    // An unwritable state folder: the dialog goes on unrecorded.
  }
}

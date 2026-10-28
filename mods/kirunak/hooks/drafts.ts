import type { KirunakChip } from '../types'
import { bodyOf, firstOf, sectionsOf } from './bugs'
import { numbered } from './lists'
import type { Item } from './lists'
import { dateWord, reasonLook } from './looks'
import type { Look, Screen } from './owner'

// /k-drafts (A-11's R27, R28; kirunak-drafts AC-2, AC-7, E-3): the drafts, prepared intakes for future tasks, as
// `k drafts --json` gives them, every repo's, in the order they wait (k drafts move). The list names each by its id,
// title and the date written; the one picked shows whole, from its file, with Start intake and Drop. Drop takes the
// reason typed in the free-text row, then "Drop <id>" runs `k draft drop <id> --why` by id, so a draft gone since
// ends in k's refusal, never on another. Start intake runs no verb: it ends the dialog, and the command hands the
// draft to the model in a prompt of its own (intakePrompt). Bugs have their own list, /k-bugs (gulnya/kirunak-bugs
// AC-1); a draft written before then that still names the accepted task it was found in says bug of <task>, in its
// list line and its head, until `k bug from` moves it there.

// A draft as `k drafts --json` gives it: `written` null when its date is missing or no date, `bugOf` the task an older
// draft names as found in, null for every other, `path` absolute.
export type DraftRow = { id: string; repo: string; slug: string; title: string; written: string | null; bugOf: string | null; path: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)
const writtenOf = (d: DraftRow): string => (d.written ? `written ${d.written}` : 'no date written')
// What follows the title: the date written, after "bug of <task>" on a bug's, in k board's order (kirunak-spikes D-2).
const tailOf = (d: DraftRow): string => (d.bugOf ? `bug of ${oneLine(d.bugOf)}, ${writtenOf(d)}` : writtenOf(d))

// A draft as the list names it: its id, title and the date written, a bug's with its task before the date.
export const draftItem = (d: DraftRow): Item => ({ lead: '', name: d.id, text: `: ${oneLine(d.title)}, ${tailOf(d)}` })

// `/k-drafts` when there is none, or when the dialog ran nothing: the drafts as a numbered list.
export function draftsText(rows: readonly DraftRow[]): string {
  if (!rows.length) return 'No drafts: no repo holds one.'
  const head = `${rows.length} ${rows.length === 1 ? 'draft' : 'drafts'}, in the order they wait:`
  return [head, '', ...numbered(rows.map(draftItem)), '', '/k-drafts shows one whole, to start its intake or drop it.'].join('\n')
}

// The draft's head: its id and title, and the date written, a bug's after "Bug of <task>".
const headLines = (d: DraftRow): string[] => [`${d.id}: ${sentence(oneLine(d.title))}`, `${sentence(tailOf(d)).replace(/^./, c => c.toUpperCase())}`]

// The draft whole, for the dialog's text: its head, then its file as written below the front matter (which the head
// says), blank lines at either end left out; `file` null when it could not be read, which the text says.
export function draftLines(d: DraftRow, file: string | null): string[] {
  if (file === null) return [...headLines(d), `Its file could not be read: ${d.path}`]
  const lines = file.replace(/\r/g, '').split('\n')
  let i = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) i = end + 1
  }
  const body = lines.slice(i)
  while (body.length && !(body[0] as string).trim()) body.shift()
  while (body.length && !(body[body.length - 1] as string).trim()) body.pop()
  return [...headLines(d), '', ...body]
}

// Its look on the phone and the desktop app (gulnya/mobile-dialogs AC-1, AC-8, AC-10), as a bug's: a draft waits for
// the owner to start its intake or drop it, so its chip is orange, the word "draft"; its title large, the repo and the
// date written; its Why's first paragraph, then what Show all unfolds in parts (E-1): its file's sections, then where
// it is, with its id, the task an older draft names and its file (AC-3).
const DRAFT: KirunakChip = { stage: 'waits', word: 'draft' }
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const writtenWord = (d: DraftRow, now: number): string => (d.written ? `written ${dateWord(d.written, now)}` : 'no date written')

function itemLook(d: DraftRow, file: string | null, now: number): Look {
  const sections = file === null ? [] : sectionsOf(bodyOf(file))
  const first = firstOf(sections)
  const where = [`Id: ${d.id}`, ...(d.bugOf ? [`A bug of ${oneLine(d.bugOf)}`] : []), `File: ${d.path}`]
  return {
    title: oneLine(d.title) || d.id,
    chip: DRAFT,
    line: `${d.repo}, ${writtenWord(d, now)}`,
    first: first === null ? [] : [{ heading: null, lines: [first] }],
    rows: [],
    fold: [...sections, { heading: 'Where it is', lines: file === null ? [...where, 'Its file could not be read.'] : where }],
  }
}

// The list's look: "Drafts", how many wait and in which repos, the newest date; a row a draft, its chip, id and title.
function listLook(rows: readonly DraftRow[], now: number): Look {
  const repos = [...new Set(rows.map(d => d.repo))]
  const newest = rows.map(d => d.written).filter((w): w is string => w !== null && /^\d{4}-\d{2}-\d{2}/.test(w)).sort().pop() ?? null
  return {
    title: 'Drafts',
    chip: { stage: 'waits', word: `${rows.length} ${rows.length === 1 ? 'waits' : 'wait'} to start` },
    line: `${plural(rows.length, 'draft')} in ${repos.join(', ')}${newest ? `, the newest written ${dateWord(newest, now)}` : ''}`,
    first: [],
    rows: rows.map(d => ({ chip: DRAFT, id: d.id, words: oneLine(d.title) })),
    fold: null,
  }
}

// The dialog: the drafts, three a page with More; the one picked whole, with Start intake (which ends the dialog with
// its id) and Drop; Drop's reason, then "Drop <id>" under it. `files` holds each draft's file by path; one missing
// could not be read. On the phone and the desktop app each dialog draws its look above the choices, dates said from
// `now`, this machine's clock (gulnya/mobile-dialogs AC-1).
export function draftsScreen(rows: readonly DraftRow[], files: ReadonlyMap<string, string>, now = Date.now()): Screen {
  // Drop's reason and its confirmation keep the draft's head alone, the confirm the reason under it.
  const headOf = (d: DraftRow): Look => ({ ...itemLook(d, files.get(d.path) ?? null, now), first: [], fold: null })
  const confirm = (d: DraftRow, why: string): Screen => ({
    kind: 'item',
    header: 'Drafts',
    text: [...headLines(d), `Reason: ${why}`],
    choices: [{ label: `Drop ${d.id}`, description: 'drops it in a commit that carries the reason', verb: ['draft', 'drop', d.id, '--why', why] }],
    question: 'Drop it, in a commit that carries that reason?',
    look: reasonLook(headOf(d), why),
  })
  const reason = (d: DraftRow): Screen => ({
    kind: 'reason',
    header: 'Drafts',
    text: headLines(d),
    question: 'Type the reason in the free-text row: why drop it?',
    given: why => confirm(d, why),
    look: headOf(d),
  })
  const item = (d: DraftRow): Screen => ({
    kind: 'item',
    header: 'Drafts',
    text: draftLines(d, files.get(d.path) ?? null),
    choices: [
      { label: 'Start intake', description: 'starts a task from it, its intake first', ends: d.id },
      { label: 'Drop', description: 'asks why, then drops it in a commit', open: () => reason(d) },
    ],
    question: 'Start the intake from it, or drop it?',
    look: itemLook(d, files.get(d.path) ?? null, now),
  })
  return { kind: 'list', header: 'Drafts', head: 'Drafts, in the order they wait:', question: 'Which draft?', rows: rows.map(d => ({ item: draftItem(d), label: d.id, open: () => item(d) })), look: listLook(rows, now) }
}

// What Start intake submits, a turn of its own, which the model reads as the plugin's message: the owner's tap, the
// draft, and the k-intake skill by name, loaded with the Skill tool, the sure way the model reads the skill: the
// engine's types promise no slash command run from a plugin's prompt text (a submission's `command` is the engine's to
// set, never the plugin's), and `$.command.run` rejects inside a hook the turn waits on, as /k-drafts' own hook is.
// Framed, not `asUser`: the owner tapped, and did not type, these words. The skill takes it from there (A-11's R26).
export const intakePrompt = (d: DraftRow): string =>
  [
    `The owner tapped Start intake on the draft ${d.id} in /k-drafts.`,
    `Start the intake from it now: first load the k-intake skill with the Skill tool (skill "k-intake"), then follow it from this draft:`,
    `run \`k intake start ${d.id} --from kirunak/drafts/${d.slug}.md\`, that moves the draft to kirunak/tasks/${d.slug}/draft.md, read it there (it is at ${d.path} until then) as background, and ask the owner every line of the task as the skill says, one question at a time.`,
  ].join(' ')

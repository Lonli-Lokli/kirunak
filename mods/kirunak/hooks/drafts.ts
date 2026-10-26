import { numbered } from './lists'
import type { Item } from './lists'
import type { Screen } from './owner'

// /k-drafts (A-11's R27, R28; kirunak-drafts AC-2, AC-7, E-3): the drafts, prepared intakes for future tasks, as
// `k drafts --json` gives them, every repo's, by the date written. The list names each by its id, title and the date
// written; the one picked shows whole, from its file, with Start intake and Drop. Drop takes the reason typed in the
// free-text row, then "Drop <id>" runs `k draft drop <id> --why` by id, so a draft gone since ends in k's refusal,
// never on another. Start intake runs no verb: it ends the dialog, and the command hands the draft to the model in a
// prompt of its own (intakePrompt). A bug, a draft that names the accepted task it was found in, shows here among
// the drafts, its list line and its head saying bug of <task>; it has no command of its own (kirunak-spikes AC-6,
// O-2).

// A draft as `k drafts --json` gives it: `written` null when its date is missing or no date, `bugOf` the task a bug
// was found in and null for a plain draft, `path` absolute.
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
  const head = `${rows.length} ${rows.length === 1 ? 'draft' : 'drafts'}, by the date written:`
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

// The dialog: the drafts, three a page with More; the one picked whole, with Start intake (which ends the dialog with
// its id) and Drop; Drop's reason, then "Drop <id>" under it. `files` holds each draft's file by path; one missing
// could not be read.
export function draftsScreen(rows: readonly DraftRow[], files: ReadonlyMap<string, string>): Screen {
  const confirm = (d: DraftRow, why: string): Screen => ({
    kind: 'item',
    header: 'Drafts',
    text: [...headLines(d), `Reason: ${why}`],
    choices: [{ label: `Drop ${d.id}`, verb: ['draft', 'drop', d.id, '--why', why] }],
    question: 'Drop it, in a commit that carries that reason?',
  })
  const reason = (d: DraftRow): Screen => ({
    kind: 'reason',
    header: 'Drafts',
    text: headLines(d),
    question: 'Type the reason in the free-text row: why drop it?',
    given: why => confirm(d, why),
  })
  const item = (d: DraftRow): Screen => ({
    kind: 'item',
    header: 'Drafts',
    text: draftLines(d, files.get(d.path) ?? null),
    choices: [
      { label: 'Start intake', ends: d.id },
      { label: 'Drop', open: () => reason(d) },
    ],
    question: 'Start the intake from it, or drop it?',
  })
  return { kind: 'list', header: 'Drafts', head: 'Drafts, by the date written:', question: 'Which draft?', rows: rows.map(d => ({ item: draftItem(d), label: d.id, open: () => item(d) })) }
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

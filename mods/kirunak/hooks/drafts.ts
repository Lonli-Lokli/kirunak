import type { KirunakChip, KirunakSection } from '../types'
import { bodyOf, firstOf, sectionsOf } from './bugs'
import { numbered } from './lists'
import type { Item } from './lists'
import { DIALOG_ROWS, dateWord, FREE, parts, reasonLook, rowsOf } from './looks'
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

// A draft's question as its intake asks it (gulnya/mobile-dialogs AC-15, AC-16): its number and words, and its
// Proposed answer, null for none and for one that only says what is missing ("open, the owner's to set", "this stays
// open"), which proposes nothing and is asked alone, as a bug's is (the k-intake skill).
export type DraftQuestion = { n: number; question: string; proposed: string | null }
const OPEN = /^(?:(?:it|this) )?(?:stays )?open\b/i

// Its Questions section's numbered lines, each with the lines under it (sectionsOf joins a wrapped line): the words
// up to its Proposed line, then that answer.
export function questionsOf(file: string): DraftQuestion[] {
  const lines = sectionsOf(bodyOf(file)).find(s => s.heading?.toLowerCase() === 'questions')?.lines ?? []
  const out: DraftQuestion[] = []
  for (const line of lines) {
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line)
    const at = out[out.length - 1]
    if (numbered) out.push({ n: Number(numbered[1]), question: numbered[2] as string, proposed: null })
    else if (at === undefined) continue
    else if (at.proposed === null && /^Proposed:/.test(line)) at.proposed = line.replace(/^Proposed:\s*/, '')
    else if (at.proposed === null) at.question += ` ${line}`
    else at.proposed += ` ${line}`
  }
  return out.map(q => ({ ...q, proposed: q.proposed && !OPEN.test(q.proposed) ? q.proposed : null }))
}

// A part of the first question, as the model asks it and the mod knows it: the question's text whole, its last line
// (`ask`, which the look's engine card shows under the draft's head), the choices in order, each one's line, the look.
export type FirstPart = { question: string; ask: string; labels: string[]; described: Record<string, string>; look: Look }
export const AGREE = 'Agree'
export const NOT = 'Not'
export const NEXT = 'Next'
export const BACK = 'Back'

// Whole questions packed into parts of at most `budget` rows, a blank line between two; one longer than a part alone
// goes in pieces through looks.ts's parts (E-3), so nothing is cut and no part goes over.
function packed(items: readonly string[][], budget: number): string[][] {
  const out: string[][] = []
  let part: string[] = []
  let used = 0
  const close = () => {
    if (part.length) out.push(part)
    part = []
    used = 0
  }
  for (const item of items) {
    const rows = item.reduce((n, l) => n + rowsOf(l), 0)
    if (rows > budget) {
      close()
      for (const p of parts(item.map(text => ({ text, heading: false })), budget)) out.push(p.map(l => l.text))
      continue
    }
    if (part.length && used + 1 + rows > budget) close()
    if (part.length) {
      part.push('')
      used += 1
    }
    part.push(...item)
    used += rows
  }
  close()
  return out
}

// A part's lines as the look draws them: each question its heading, its Proposed answer under it.
function sectionsIn(lines: readonly string[]): KirunakSection[] {
  const out: KirunakSection[] = []
  for (const l of lines) {
    if (!l) continue
    const at = out[out.length - 1]
    if (/^\d+\. /.test(l) || at === undefined) out.push(/^\d+\. /.test(l) ? { heading: l, lines: [] } : { heading: null, lines: [l.trim()] })
    else at.lines.push(l.trim())
  }
  return out
}

// The intake's first question (AC-15, E-3): the draft's head, then every Proposed answer numbered under its question,
// Agree first and Not second. Past 48 rows, counted at 40 columns with the room a look keeps (looks.ts's FREE), it
// comes in parts "n of m": each but the last offers Next, each but the first Back, and Agree is on the last alone, so
// no proposal is agreed unseen. Not stays on every part and is Not to all: each proposal is then asked alone (AC-16).
// None when the draft proposes nothing.
export function firstQuestion(d: DraftRow, asked: readonly DraftQuestion[]): FirstPart[] {
  const proposed = asked.filter(q => q.proposed !== null)
  const n = proposed.length
  if (!n) return []
  const title = oneLine(d.title) || d.id
  const counted = (k: number, m: number): string => `${plural(n, 'proposed answer')}${m > 1 ? `, part ${k} of ${m}` : ''}`
  const agree = (m: number): string => (n === 1 ? 'Agree to it, or not?' : `Agree to all ${n}${m > 1 ? `, in the ${m} parts` : ''}, or not?`)
  const onTo = (k: number, m: number): string => `On to part ${k} of ${m}, or not?`
  // The head's rows, as the look draws it and as the question's text holds it, the widest "n of m" and last line.
  const look = rowsOf(title) + rowsOf(DRAFT.stage) + rowsOf(DRAFT.word) + rowsOf(`${d.id}, ${counted(99, 99)}`)
  const text = rowsOf(`${d.id}: ${sentence(title)}`) + rowsOf(`${counted(99, 99)}:`) + 2 + Math.max(rowsOf(agree(99)), rowsOf(onTo(99, 99)))
  const all = packed(proposed.map(q => [`${q.n}. ${q.question}`, `   Proposed: ${q.proposed}`]), DIALOG_ROWS - FREE - Math.max(look, text))
  const m = all.length
  return all.map((lines, i) => {
    const k = i + 1
    const ask = k === m ? agree(m) : onTo(k + 1, m)
    const labels = [k === m ? AGREE : NEXT, NOT, ...(k > 1 ? [BACK] : [])]
    const described: Record<string, string> = {
      [AGREE]: n === 1 ? 'the proposal becomes your answer' : `all ${n} proposals become your answers`,
      [NOT]: 'asks each proposal alone',
      [NEXT]: `part ${k + 1} of ${m}`,
      [BACK]: `part ${k - 1} of ${m}`,
    }
    return {
      question: [`${d.id}: ${sentence(title)}`, `${counted(k, m)}:`, '', ...lines, '', ask].join('\n'),
      ask,
      labels,
      described: Object.fromEntries(labels.map(l => [l, described[l] as string])),
      look: { title, chip: DRAFT, line: `${d.id}, ${counted(k, m)}`, first: sectionsIn(lines), rows: [], fold: null },
    }
  })
}

// What Start intake submits, a turn of its own, which the model reads as the plugin's message: the owner's tap, the
// draft, and the k-intake skill by name, loaded with the Skill tool, the sure way the model reads the skill: the
// engine's types promise no slash command run from a plugin's prompt text (a submission's `command` is the engine's to
// set, never the plugin's), and `$.command.run` rejects inside a hook the turn waits on, as /k-drafts' own hook is.
// Framed, not `asUser`: the owner tapped, and did not type, these words. The skill takes it from there (A-11's R26).
// Then the first question's text whole, each part between lines of dashes for the model to ask as written, its
// choices and their lines (AC-14, AC-15; the call hook writes the same lines in, look.tsx), and the questions to ask
// alone after it (AC-16). `file` is the draft's file as read just now, null when it could not be read: the skill then
// says how to write the first question.
export function intakePrompt(d: DraftRow, file: string | null = null): string {
  const asked = file === null ? [] : questionsOf(file)
  const first = firstQuestion(d, asked)
  const alone = asked.filter(q => q.proposed === null).map(q => `${q.n}. ${q.question}`)
  const start = [
    `The owner tapped Start intake on the draft ${d.id} in /k-drafts.`,
    `Start the intake from it now: first load the k-intake skill with the Skill tool (skill "k-intake"), then follow its "Starting from a kirunak draft":`,
    `run \`k intake start ${d.id} --from kirunak/drafts/${d.slug}.md\`, that moves the draft to kirunak/tasks/${d.slug}/draft.md, read it there (it is at ${d.path} until then) as background, and ask the owner every line of the task as the skill says, one question at a time.`,
  ].join(' ')
  const m = first.length
  const how = [
    'Ask first, with AskUserQuestion and the header "Draft", the one question that holds every proposed answer: its text exactly as written between the lines of dashes, its choices in the order given, each with its line as the description.',
    `Agree makes every proposal the owner's answer, each sourced [owner <date> Q-n] to that question; Not asks each proposal alone.`,
    ...(m > 1 ? [`It comes in ${m} parts, so that no proposal is agreed unseen: ask part 1 first; Next asks the next part and Back the one before; Agree, on the last part alone, agrees to all of them; Not, on any part, is Not to all.`] : []),
  ].join(' ')
  const choices = (p: FirstPart): string => p.labels.map(l => `${l} ("${p.described[l]}")`).join(', ')
  const asks = first.flatMap((p, i) => ['', `${m > 1 ? `Part ${i + 1} of ${m}, its` : 'Its'} choices: ${choices(p)}.`, '---', p.question, '---'])
  const after = !alone.length ? [] : ['', first.length ? 'Then ask each of these alone, after it, as the draft proposes no answer to them:' : 'The draft proposes no answer, so ask each of its questions alone:', ...alone]
  return [start, ...(first.length ? ['', how, ...asks] : []), ...after].join('\n')
}

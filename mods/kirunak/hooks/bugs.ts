import type { KirunakChip, KirunakLookRow, KirunakSection } from '../types'

import { numbered, unmarked } from './lists'
import type { Item } from './lists'
import { clipped, dateWord, reasonLook, runRowOf } from './looks'
import type { Look, Screen } from './owner'

// /k-bugs (gulnya/kirunak-bugs AC-6, D-1): the bugs, faults in something that exists, as `k bugs --json` gives them,
// every repo's, those with a fix ready first, then the oldest. The list names each by its id, title, its fix and the
// date written; the one picked shows whole, from its file, with Review & merge when its fix is ready, Start fix and
// Drop. Review & merge runs `k bug review <id> --detach --via mod`, the owner's verb: a fresh Opus session reviews the
// fix, and kirunak merges it into master only when the review finds nothing. Start fix runs no verb: it ends the
// dialog, and the command hands the bug to the model in a prompt of its own (fixPrompt). Drop takes the reason typed in
// the free-text row, then "Drop <id>" runs `k bug drop <id> --why`. Each by id, so a bug gone since ends in k's
// refusal, never on another.
// Quad Damage (gulnya/quad-damage AC-1, AC-12, E-4, D-1): the list's first row while a bug marked `quad-damage: yes`
// waits and no run lives runs `k bugs quad-damage --via mod`, the owner's verb, which fixes and reviews the marked bugs
// one at a time, unattended; while a run lives, its line (`k bugs quad-damage --status`) instead, and the bug it is on
// says so, with no Review & merge, Start fix or Drop until the run moves on. While a run lives, Stop Quad Damage is the
// list's first row (AC-17): one confirm, naming the bug it is on or its wait and what a stop does, then `k bugs
// quad-damage --stop --via mod`, the owner's verb.

// A bug as `k bugs --json` gives it (lib/bugs.mjs): `written` null when no date is written, `bugOf` the accepted task
// it was found in, `fixRepo` the repo its fix branch is in, `branch` null when that branch does not exist, `ahead` the
// commits it holds that master does not, `reviewing` the Review & merge running now, `review` the last review beside
// the bug (`atHead` when it reviewed the branch's head), `path` absolute; `quadDamage` its mark, and `quadDamageRun`
// where Quad Damage's run is with it while the run is on it (`try` its fixing session's, times as the run file writes
// them, in this machine's zone with its offset).
export type BugRow = {
  id: string
  repo: string
  slug: string
  title: string
  written: string | null
  bugOf: string | null
  fixRepo: string
  branch: string | null
  head: string | null
  ahead: number
  fixReady: boolean
  reviewing: { pid: number; started: string } | null
  review: { file: string; verdict: string | null; head: string | null; atHead: boolean } | null
  quadDamage: boolean
  quadDamageRun: QuadDamagePhase | null
  path: string
}
export type QuadDamagePhase = { phase: 'fixing' | 'reviewing' | 'merging' | 'waiting' | null; try: number | null; since: string | null; waitUntil: string | null }
// What `k bugs quad-damage --status --json` gives: the live run's file, null when none lives, and its line.
export type QuadDamageStatus = { run: { pid: number; bug: string | null; phase?: QuadDamagePhase['phase']; waitUntil?: string | null } | null; line: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)
const capital = (s: string): string => s.replace(/^./, c => c.toUpperCase())
const p2 = (n: number): string => String(n).padStart(2, '0')
// A time as k board writes one, in this machine's time: 2026-11-07 11:50.
const stamp = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

// What a review at the fix's head found.
const found = (verdict: string | null): string =>
  verdict === 'conflict' ? 'found a conflict with master' : verdict === 'findings' ? 'found things to fix' : verdict ? `says ${verdict}` : 'has no verdict'

// Where the run is with the bug: fixing and its try, reviewing, or waiting for the 5-hour window and until when (as k
// bugs' runPhase). The run file's times carry this machine's zone, so their clock time is as written.
const hhmm = (iso: string): string => iso.slice(11, 16)
function phaseOf(q: QuadDamagePhase): string {
  if (q.phase === 'waiting') return `waiting for the 5-hour window${q.waitUntil ? ` until ${hhmm(q.waitUntil)}` : ''}`
  if (q.phase === 'fixing') return q.try ? `fixing, try ${q.try}` : 'fixing'
  return q.phase ?? 'working'
}

// Its fix in a few words: Quad Damage on it, in review, ready, what a review at its head found, or none yet (as k
// bugs' fixLine). The run holds the bug's review lock while it fixes too, so its phase comes first.
export function fixOf(b: BugRow): string {
  if (b.quadDamageRun) return `Quad Damage is on it (${phaseOf(b.quadDamageRun)})`
  if (b.reviewing) return `in review since ${stamp(b.reviewing.started)}`
  if (b.fixReady) return 'fix ready'
  if (b.review?.atHead && b.review.verdict !== 'clean') return `fix not ready: ${b.review.file} ${found(b.review.verdict)}`
  return b.branch && b.ahead > 0 ? 'fix not ready' : 'no fix yet'
}

const writtenOf = (b: BugRow): string => (b.written ? `written ${b.written}` : 'no date written')
// What follows the fix: the task it is a bug of, and the date written.
const tailOf = (b: BugRow): string => (b.bugOf ? `bug of ${oneLine(b.bugOf)}, ${writtenOf(b)}` : writtenOf(b))

// A bug as the list names it: its id, title, its fix and the date written.
export const bugItem = (b: BugRow): Item => ({ lead: '', name: b.id, text: `: ${oneLine(b.title)}, ${fixOf(b)}, ${tailOf(b)}` })

// `/k-bugs` when there is none, or when the dialog ran nothing: the bugs as a numbered list, under Quad Damage's line
// while a run lives (`run`).
export function bugsText(rows: readonly BugRow[], run: QuadDamageStatus | null = null): string {
  const above = run?.run ? [sentence(run.line), ''] : []
  if (!rows.length) return [...above, 'No bugs: no repo holds one.'].join('\n')
  const head = `${rows.length} ${rows.length === 1 ? 'bug' : 'bugs'}, a fix ready first, then the oldest:`
  return [...above, head, '', ...numbered(rows.map(bugItem)), '', '/k-bugs shows one whole, to review and merge its fix, start a fix or drop it.'].join('\n')
}

// The review file beside the bug: kirunak/bugs/<slug>/<file>.
const reviewPath = (b: BugRow, file: string): string => `${b.path.replace(/\.md$/, '')}/${file}`
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

// Its fix as the one picked says it, with where the branch is and, for a review that refused it, the review's file.
function fixLines(b: BugRow): string[] {
  const where = b.branch ? `${b.branch} in ${b.fixRepo}` : null
  const q = b.quadDamageRun
  if (q) return [`Quad Damage is on it: ${phaseOf(q)}${q.phase !== 'waiting' && q.since ? `, since ${hhmm(q.since)}` : ''}${where ? `, on ${where}` : ''}.`]
  if (b.reviewing) return [`In Review & merge since ${stamp(b.reviewing.started)}${where ? `: ${where}` : ''}.`]
  if (b.fixReady) return [`Fix ready: ${where}, ${plural(b.ahead, 'commit')} ahead of master.`]
  if (b.review?.atHead && b.review.verdict !== 'clean') return [`Fix not ready: ${b.review.file} ${found(b.review.verdict)}${where ? ` on ${where}` : ''}.`, `The review: ${reviewPath(b, b.review.file)}`]
  return [b.branch && b.ahead > 0 ? `Fix not ready: ${where}.` : 'No fix yet.']
}

// The bug's head: its id and title, the task it is a bug of and the date written, then its fix.
const headLines = (b: BugRow): string[] => [`${b.id}: ${sentence(oneLine(b.title))}`, sentence(capital(tailOf(b))), ...fixLines(b)]

// The bug's file as written below the front matter (which the head says), blank lines at either end left out.
export function bodyOf(file: string): string[] {
  const lines = file.replace(/\r/g, '').split('\n')
  let i = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) i = end + 1
  }
  const body = lines.slice(i)
  while (body.length && !(body[0] as string).trim()) body.shift()
  while (body.length && !(body[body.length - 1] as string).trim()) body.pop()
  return body
}

// The bug whole, for the dialog's text: its head, then its file's body; `file` null when it could not be read, which
// the text says.
export function bugLines(b: BugRow, file: string | null): string[] {
  if (file === null) return [...headLines(b), `Its file could not be read: ${b.path}`]
  return [...headLines(b), '', ...bodyOf(file)]
}

// Its look on the phone and the desktop app (gulnya/mobile-dialogs AC-1, AC-8 to AC-10): its chip, the word beside its
// icon. Quad Damage on it is yellow even while the run waits for the window, as AC-8 lists it under running, its icon
// the run's phase; a ready fix, or one a review refused, waits for the owner's choice; no fix yet is not reached.
export function chipOf(b: BugRow): KirunakChip {
  const q = b.quadDamageRun
  if (q) return { stage: q.phase === 'fixing' || q.phase === 'reviewing' ? q.phase : 'started', word: 'Quad Damage on it' }
  if (b.reviewing) return { stage: 'reviewing', word: 'in review' }
  if (b.fixReady) return { stage: 'waits', word: 'fix ready' }
  if ((b.review?.atHead && b.review.verdict !== 'clean') || (b.branch && b.ahead > 0)) return { stage: 'waits', word: 'fix not ready' }
  return { stage: 'not reached', word: 'no fix yet' }
}

const writtenWord = (b: BugRow, now: number): string => (b.written ? `written ${dateWord(b.written, now)}` : 'no date written')

// A file's body as sections under its headings (AC-4), each line one of its words as read: a paragraph's lines joined,
// an entry of a list, a question and its Proposed answer each a line of their own. Ids, paths and commits stay, as
// short shas (AC-3), since this is what Show all unfolds.
const STARTS = /^(?:[-*] |\d+\. |> |Proposed:)/
export const shortShas = (s: string): string => s.replace(/\b([0-9a-f]{7})[0-9a-f]{5,57}\b/g, '$1')
export function sectionsOf(body: readonly string[]): KirunakSection[] {
  const out: KirunakSection[] = []
  let at: KirunakSection | null = null
  let joining = false
  for (const raw of body) {
    const heading = /^#{1,6}\s+(.+)$/.exec(raw)
    if (heading) {
      at = { heading: unmarked(heading[1] as string).trim(), lines: [] }
      out.push(at)
      joining = false
      continue
    }
    const line = raw.trim()
    if (!line) {
      joining = false
      continue
    }
    if (at === null) {
      at = { heading: null, lines: [] }
      out.push(at)
    }
    const words = shortShas(unmarked(line))
    if (joining && !STARTS.test(line)) at.lines[at.lines.length - 1] += ` ${words}`
    else at.lines.push(words)
    joining = true
  }
  return out.filter(s => s.lines.length)
}

// The first lines under a bug's head (AC-10): its Why's first paragraph, else its first section's first line, in
// plain words (AC-3): no file or commit marks, cut at a sentence past 400 characters, which Show all shows whole.
export function firstOf(sections: readonly KirunakSection[]): string | null {
  const s = sections.find(x => x.heading?.toLowerCase() === 'why') ?? sections[0]
  const line = s?.lines[0]
  if (line === undefined) return null
  return clipped(line.replace(/\s*\[(?:file|commit)[^\]]*\]/g, '').replace(/^[-*] /, ''))
}

// A bug's look: its title large, its chip, the repo and the date written; its first lines; then what Show all
// unfolds: its file's sections, then its fix and where it is, with its id and file (AC-3, AC-10).
function itemLook(b: BugRow, file: string | null, now: number): Look {
  const sections = file === null ? [] : sectionsOf(bodyOf(file))
  const first = firstOf(sections)
  const where = [`Id: ${b.id}`, ...(b.bugOf ? [`A bug of ${b.bugOf}`] : []), `File: ${b.path}`]
  return {
    title: oneLine(b.title),
    chip: chipOf(b),
    line: `${b.repo}, ${writtenWord(b, now)}`,
    first: first === null ? [] : [{ heading: null, lines: [first] }],
    rows: [],
    fold: [...sections, { heading: 'Its fix', lines: fixLines(b).map(shortShas) }, { heading: 'Where it is', lines: file === null ? [...where, 'Its file could not be read.'] : where }],
  }
}

// The list's look: "Bugs", how many and in which repos, the newest date; its chip, Quad Damage's run while one lives,
// else the fixes ready, else what is in review, else none ready; a row a bug, its chip, its id and its title (AC-1).
// The run's line is a row of the head, drawn as a progress row (AC-12); a line of no form k prints stays the first
// line, as written (E-2).
function listLook(rows: readonly BugRow[], live: QuadDamageStatus | null, now: number): Look {
  const ready = rows.filter(b => b.fixReady).length
  const reviewing = rows.filter(b => b.reviewing).length
  const run = live ? runRowOf(live.line) : null
  // A run that waits for the 5-hour window is paused, orange, as its row says (AC-8); else it runs.
  const chip: KirunakChip = live
    ? run?.chip.stage === 'paused' ? { stage: 'paused', word: 'Quad Damage waits' } : { stage: 'started', word: 'Quad Damage runs' }
    : ready
      ? { stage: 'waits', word: `${ready} ${ready === 1 ? 'fix' : 'fixes'} ready` }
      : reviewing
        ? { stage: 'reviewing', word: 'in review' }
        : { stage: 'not reached', word: 'no fix ready' }
  const repos = [...new Set(rows.map(b => b.repo))]
  const newest = rows.map(b => b.written).filter((d): d is string => d !== null).sort().pop() ?? null
  const look: KirunakLookRow[] = rows.map(b => ({ chip: chipOf(b), id: b.id, words: oneLine(b.title) }))
  return {
    title: 'Bugs',
    chip,
    line: `${plural(rows.length, 'bug')} in ${repos.join(', ')}${newest ? `, the newest written ${dateWord(newest, now)}` : ''}`,
    run,
    first: live && run === null ? [{ heading: null, lines: [sentence(live.line)] }] : [],
    rows: look,
    fold: null,
  }
}

// Review & merge is offered while the fix is ready and no review of it runs (D-1), nor Quad Damage on it (E-4).
const mergeable = (b: BugRow): boolean => b.fixReady && !b.reviewing && !b.quadDamageRun

// Quad Damage as the list's first row: what it does with the marked bugs, and the verb its tap runs. Its label holds
// how many it takes, "Quad Damage (2 bugs)", the line the phone draws bold, and its line under it does not say it
// again (gulnya/mobile-dialogs AC-24).
const quadDamageLabel = (marked: number): string => `Quad Damage (${plural(marked, 'bug')})`
const quadDamageRow = (marked: number) => ({
  item: { lead: '', name: quadDamageLabel(marked), text: `: fix and review ${marked === 1 ? 'it' : 'them one at a time'}, unattended; nothing is pushed` },
  label: quadDamageLabel(marked),
  description: marked === 1 ? 'fixes and reviews the marked bug, unattended; nothing is pushed' : 'fixes and reviews the marked bugs one at a time, unattended; nothing is pushed',
  verb: ['bugs', 'quad-damage', '--via', 'mod'],
})

// What Stop Quad Damage does, said in its confirm: the run's line, then what ends at once and what is let finish.
function stopLines(live: QuadDamageStatus): string[] {
  const r = live.run
  const bug = r?.bug ?? null
  const what = !bug
    ? 'Stop Quad Damage ends the run before it takes another bug; the bugs left are not reached.'
    : r?.phase === 'waiting'
      ? `Stop Quad Damage ends its wait for the 5-hour window at once; ${bug} waits, and the bugs left are not reached.`
      : r?.phase === 'merging'
        ? `The merge of ${bug} is under way and is let finish; then the run ends, and the bugs left are not reached.`
        : `Stop Quad Damage ends the session it runs for ${bug} at once; a merge already under way is let finish. Then ${bug} waits with what its branch holds, and the bugs left are not reached.`
  return [sentence(live.line), '', what, 'Nothing is pushed. Its summary follows in the chat that started the run, and goes to your phone.']
}

// Stop Quad Damage as the list's first row while a run lives, and its one confirm, with Cancel.
const stopRow = (live: QuadDamageStatus) => ({
  item: { lead: '', name: 'Stop Quad Damage', text: ': end the run now, the bug it is on left waiting' },
  label: 'Stop Quad Damage',
  description: 'ends the run now, the bug it is on left waiting',
  open: (): Screen => ({
    kind: 'item',
    header: 'Bugs',
    text: stopLines(live),
    choices: [{ label: 'Stop Quad Damage', description: 'ends it at once; nothing is pushed', verb: ['bugs', 'quad-damage', '--stop', '--via', 'mod'] }],
    question: 'Stop Quad Damage now?',
    cancel: true,
    // Its look (gulnya/mobile-dialogs AC-1): the run as the list's chip says it, then what stopping does.
    look: { title: 'Stop Quad Damage', chip: { stage: 'started', word: 'Quad Damage runs' }, line: null, first: [{ heading: null, lines: stopLines(live) }], rows: [], fold: null },
  }),
})

// The dialog: the bugs, three a page with More; the one picked whole, with Review & merge (a verb, the last tap) when
// its fix is ready, Start fix (which ends the dialog with its id) and Drop; Drop's reason, then "Drop <id>" under it.
// What the owner reads to choose is in the dialog's own text, since on the phone the dialog covers the text above it:
// under a ready fix's bug, what Review & merge does. `files` holds each bug's file by path; one missing could not be
// read. `run`, Quad Damage's status: while a run lives, its line above the list, Stop Quad Damage first and, on the bug
// it is on, no choice but Back and Cancel (E-4); while none lives, its row first when a marked bug waits. On the phone
// and the desktop app each dialog draws its look above the choices, each choice with its line (gulnya/mobile-dialogs
// AC-1, AC-14), dates said from `now`, this machine's clock.
export function bugsScreen(rows: readonly BugRow[], files: ReadonlyMap<string, string>, run: QuadDamageStatus | null = null, now = Date.now()): Screen {
  // Drop's reason and its confirmation keep the bug's head alone.
  const headOf = (b: BugRow): Look => ({ ...itemLook(b, files.get(b.path) ?? null, now), first: [], fold: null })
  const confirm = (b: BugRow, why: string): Screen => ({
    kind: 'item',
    header: 'Bugs',
    text: [...headLines(b), ...(b.branch ? [`Its fix branch ${b.branch} stays in ${b.fixRepo}.`] : []), `Reason: ${why}`],
    choices: [{ label: `Drop ${b.id}`, description: 'drops it in a commit that carries the reason', verb: ['bug', 'drop', b.id, '--why', why] }],
    question: 'Drop it, in a commit that carries that reason?',
    look: reasonLook(headOf(b), why, b.branch ? [{ heading: 'Its fix', lines: [`Its fix branch ${b.branch} stays in ${b.fixRepo}.`] }] : []),
  })
  const reason = (b: BugRow): Screen => ({
    kind: 'reason',
    header: 'Bugs',
    text: headLines(b),
    question: 'Type the reason in the free-text row: why drop it?',
    given: why => confirm(b, why),
    look: headOf(b),
  })
  const held = (b: BugRow): Screen => ({
    kind: 'item',
    header: 'Bugs',
    text: bugLines(b, files.get(b.path) ?? null),
    choices: [],
    question: 'Review & merge, Start fix and Drop wait until Quad Damage moves on. Back to the list?',
    look: itemLook(b, files.get(b.path) ?? null, now),
  })
  const item = (b: BugRow): Screen => b.quadDamageRun ? held(b) : ({
    kind: 'item',
    header: 'Bugs',
    text: [
      ...bugLines(b, files.get(b.path) ?? null),
      ...(mergeable(b) ? ['', `Review & merge: a fresh Opus session reviews ${b.branch}; only when it finds nothing is the fix merged into ${b.fixRepo}'s master, never pushed, and the bug closed.`] : []),
    ],
    choices: [
      ...(mergeable(b) ? [{ label: 'Review & merge', description: 'a fresh session reviews, then merges, never pushes', verb: ['bug', 'review', b.id, '--detach', '--via', 'mod'] }] : []),
      { label: 'Start fix', description: 'starts a task to fix it, its intake first', ends: b.id },
      { label: 'Drop', description: 'asks why, then drops it in a commit', open: () => reason(b) },
    ],
    question: mergeable(b) ? 'Review and merge its fix, start a task to fix it, or drop it?' : 'Start a task to fix it, or drop it?',
    look: itemLook(b, files.get(b.path) ?? null, now),
  })
  const live = run?.run ? run : null
  const marked = rows.filter(b => b.quadDamage).length
  // Each bug's line under its choice, its words as the list said them with the date in words (AC-14, AC-23).
  const lineOf = (b: BugRow): string => `${oneLine(b.title)}, ${fixOf(b)}, ${b.bugOf ? `bug of ${oneLine(b.bugOf)}, ` : ''}${writtenWord(b, now)}`
  const bugRows = rows.map(b => ({ item: bugItem(b), label: b.id, description: lineOf(b), open: () => item(b) }))
  return {
    kind: 'list',
    header: 'Bugs',
    ...(live ? { text: [sentence(live.line)] } : {}),
    head: 'Bugs, a fix ready first, then the oldest:',
    question: live ? 'Stop Quad Damage, or which bug?' : marked ? 'Quad Damage, or which bug?' : 'Which bug?',
    rows: live ? [stopRow(live), ...bugRows] : marked ? [quadDamageRow(marked), ...bugRows] : bugRows,
    look: listLook(rows, live, now),
  }
}

// The answer once k took Quad Damage: that the run started, how many marked bugs wait, what it does and where it
// shows; then k's own lines, with its pid, log, folder and the bugs marked.
export function quadDamageStarted(said: string): string {
  const marked = /^bugs marked: (.+)$/m.exec(said)?.[1]?.split(', ').filter(Boolean).length ?? 0
  return [
    `Quad Damage started${marked ? ` with ${plural(marked, 'marked bug')} waiting` : ''}: it fixes and reviews them one at a time, unattended, and merges a fix into master only when its review finds nothing; nothing is pushed.`,
    '/k-bugs, `k waiting` and the board show the bug it is on; each step it takes is written here as a short line, and when it ends, its summary is written here and sent to your phone.',
    ...(said.trim() ? ['', said.trim()] : []),
  ].join('\n')
}

// The answer once k took Stop Quad Damage: what the stop does and where the summary follows; then k's own line, that
// the run stopped or is still stopping.
export function quadDamageStopping(said: string): string {
  return [
    'Quad Damage stops: the session it was in is ended, a merge already under way is let finish, the bug it was on waits and the bugs left are not reached. Its summary follows in the chat that started the run, and goes to your phone.',
    ...(said.trim() ? ['', said.trim()] : []),
  ].join('\n')
}

// The answer once k took Review & merge: what runs now, what comes of it, and where the result shows; then k's own
// line, with the process and its log.
export const reviewStarted = (id: string, said: string): string =>
  [
    `A fresh Opus session reviews the fix of ${id} now. Only when it finds nothing is the fix merged into master, never pushed, and the bug closed; a finding or a conflict merges nothing and is written beside the bug.`,
    '/k-bugs or `k bugs` shows the result.',
    ...(said.trim() ? ['', said.trim()] : []),
  ].join('\n')

// What Start fix submits, a turn of its own, as Start intake does (drafts.ts, intakePrompt): the owner's tap, the bug,
// and the k-intake skill by name, whose "Starting from a bug (Start fix)" asks first one question that holds every
// proposed answer in its own text, then each open question alone (AC-8).
export const fixPrompt = (b: BugRow): string =>
  [
    `The owner tapped Start fix on the bug ${b.id} in /k-bugs.`,
    `Start the intake from it now: first load the k-intake skill with the Skill tool (skill "k-intake"), then follow its "Starting from a bug (Start fix)":`,
    `run \`k intake start ${b.id} --from kirunak/bugs/${b.slug}.md\`, that moves the bug to kirunak/tasks/${b.slug}/bug.md, read it there (it is at ${b.path} until then) and the notes.md it writes,`,
    'then ask the owner first one question that holds every proposed answer in its own text, then each open question alone, as the skill says.',
  ].join(' ')

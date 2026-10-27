import type { On, PromptOrigin } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { DraftRow } from '../hooks/drafts'
import type { Brief } from '../hooks/picks'
import type { AmendmentRow, Waiting } from '../hooks/waiting'
import type { KirunakRow, KirunakStatus } from '../types'

export const ID = 'weather/offline-forecast'

// What `k list --json --all` gives: the session's task with its review and checklist, a queued one, a done one.
export const ROWS: KirunakRow[] = [
  {
    id: ID,
    repo: 'weather',
    title: 'The last forecast stays readable offline',
    state: 'in review',
    queue: 1,
    step: '2026-11-07 11:40 S-2 finished (review.md sha256:3f2a0000000000000000000000000000000000000000000000000000000000ab)',
    lock: 'weather unit tests',
    review: { file: 'review.md', verdict: 'needs owner (E-1)' },
    checklist: { open: 1, ticked: 2 },
    ac: [
      { id: 'AC-1', text: 'The last forecast shows with no network.', verdict: 'met' },
      { id: 'AC-2', text: 'The age of the forecast is said.', verdict: 'not met' },
    ],
    e: [{ id: 'E-1', text: 'On the oldest phone.', verdict: 'needs device' }],
  },
  { id: 'hub/sync-notes', repo: 'hub', title: 'Sync notes', state: 'queued', queue: 2, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
  { id: 'hub/old', repo: 'hub', title: 'Done before', state: 'done', queue: null, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
  { id: 'weather/was-reviewed', repo: 'weather', title: 'Reviewed and met', state: 'reviewed', queue: null, step: null, lock: null, review: { file: 'review.md', verdict: 'met' }, checklist: null, ac: [], e: [] },
  { id: 'hub/proposed', repo: 'hub', title: 'Asks for approval', state: 'proposed', queue: null, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
  { id: 'weather/asks-owner', repo: 'weather', title: 'A step asked a question', state: 'awaiting owner', queue: null, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
]

const row = (id: string, title: string, state: string, queue: number | null): KirunakRow => ({ id, repo: id.split('/')[0] as string, title, state, queue, step: null, lock: null, review: null, checklist: null, ac: [], e: [] })

// A queue of four, the first in review, and beside it a parked task and a done one (`rows` for /k-queue).
export const QUEUE: KirunakRow[] = [ROWS[0] as KirunakRow, ROWS[1] as KirunakRow, row('hub/next', 'Next up', 'queued', 3), row('hub/later', 'Later on', 'queued', 4), row('hub/parked', 'Waits outside', 'parked', null), ROWS[2] as KirunakRow]

// Two tasks on hold, out of the queue (`rows` for /k-resume, beside ROWS or QUEUE).
export const HELD: KirunakRow[] = [row('hub/paused', 'Waits for the parts', 'on hold', null), row('weather/held', 'Held for the phone test', 'on hold', null)]

const AMENDMENT_DIR = '/w/weather/kirunak/tasks/offline-forecast/amendments'

// The amendments `k waiting --json` gives: one k would approve, one it would refuse; A-4 has no name of its own, so k
// names the criterion it changes, and its file cannot be read.
export const AMENDMENTS: AmendmentRow[] = [
  { id: ID, amendment: 'A-3', title: 'The last forecast stays readable offline', name: 'Age line in words', proposed: '2026-11-06', by: 'session s1', why: 'The age line needs its words.', lines: 2, refuse: null, file: `${AMENDMENT_DIR}/A-3.md` },
  { id: ID, amendment: 'A-4', title: 'The last forecast stays readable offline', name: 'replaces E-1', proposed: '2026-11-06', by: 'session s1', why: 'E-1 is covered by AC-1.', lines: 1, refuse: `${ID} with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have`, file: `${AMENDMENT_DIR}/A-4.md` },
]

// The drafts `k drafts --json` gives (kirunak-drafts S-3), with no order file: by the date written, the undated last;
// the last one's file cannot be read.
export const DRAFTS: DraftRow[] = [
  { id: 'hub/offline-maps', repo: 'hub', slug: 'offline-maps', title: 'Maps that work offline', written: '2026-11-05', bugOf: null, path: '/w/hub/kirunak/drafts/offline-maps.md' },
  { id: 'weather/rain-alerts', repo: 'weather', slug: 'rain-alerts', title: 'Rain alerts', written: '2026-11-06', bugOf: null, path: '/w/weather/kirunak/drafts/rain-alerts.md' },
  { id: 'hub/no-date', repo: 'hub', slug: 'no-date', title: 'no-date', written: null, bugOf: null, path: '/w/hub/kirunak/drafts/no-date.md' },
]

// A bug as `k drafts --json` gives it (kirunak-spikes AC-6): a draft whose `bugOf` names the accepted task it was
// found in, here in another repo than its task.
export const BUG: DraftRow = { id: 'hub/stale-tiles', repo: 'hub', slug: 'stale-tiles', title: 'Old tiles stay after an update', written: '2026-11-07', bugOf: 'weather/offline-forecast', path: '/w/hub/kirunak/drafts/stale-tiles.md' }

// A draft's file as templates/draft.md shapes it.
export const DRAFT_FILE = '---\nid: hub/offline-maps\ntitle: Maps that work offline\nwritten: 2026-11-05\n---\n\n## Who raised it\n\n> The maps should work offline too.\n\nowner, 2026-11-05, session s1\n\n## Why\n\nThe forecast works offline; the maps do not.\n\n## What was found\n\n- The tiles load from the network. [file hub/src/Map.kt]\n\n## Questions\n\n1. Which areas are kept?\n2. How old may a tile be?\n'

// Their files, as the mod reads them for `/k-amendments <n>` and /k-drafts.
export const FILES: Record<string, string> = {
  [`${AMENDMENT_DIR}/A-3.md`]: `---\ntask: ${ID}\nproposed: 2026-11-06\nby: session s1\n---\n\n## Why\nThe age line needs its words. The old one was a time alone.\n\n## Changes\n- replace E-1: A forecast older than a day says "yesterday".\n- replace D-1: Keep the last three days.\n`,
  '/w/hub/kirunak/drafts/offline-maps.md': DRAFT_FILE,
  '/w/weather/kirunak/drafts/rain-alerts.md': '---\nid: weather/rain-alerts\ntitle: Rain alerts\nwritten: 2026-11-06\n---\n\n## Why\n\nRain comes fast.\n',
  '/w/hub/kirunak/drafts/stale-tiles.md': '---\nid: hub/stale-tiles\ntitle: Old tiles stay after an update\nwritten: 2026-11-07\nbug-of: weather/offline-forecast\n---\n\n## What was found\n\n- The tile cache keeps no version. [file hub/src/Tiles.kt]\n\n## Fix written\n\n- The cache is keyed by version. [commit 3f2a9c1]\n',
}

// A brief board as `k board --brief --json` gives it (lib/board-brief.mjs): each group's name and entry lines, the
// text made of them and the machine's line, each paragraph after a blank line, and the ids in the order of the lines.
export function briefOf(groups: readonly { name: string; lines: string[] }[], machine = 'No lock, no heavy jobs waiting, 0 of 2 steps running, no device claims.', made = '2026-11-07 12:00'): Brief {
  const all = groups.map(g => ({ name: g.name, count: g.lines.length, ids: g.lines.map(l => l.slice(0, l.indexOf(':'))), lines: [...g.lines] }))
  const text = [`Made at ${made}.`, ...all.map(g => [`${g.name} (${g.count})`, ...g.lines].join('\n')), machine].join('\n\n')
  return { made, text, ids: all.flatMap(g => g.ids), groups: all, machine }
}

// The brief board for ROWS: the task worked on first, then each state's, one task a group.
export const BRIEF: Brief = briefOf(
  [
    { name: 'Working on now', lines: [`${ID}: in review, queue 1, S-2 done, 1 of 3 met, 1 not met, 1 needs a device`] },
    { name: 'Proposed', lines: ['hub/proposed: proposed'] },
    { name: 'Queued', lines: ['hub/sync-notes: queued, queue 2'] },
    { name: 'Reviewed', lines: ['weather/was-reviewed: reviewed'] },
    { name: 'Awaiting owner', lines: ['weather/asks-owner: awaiting owner'] },
    { name: 'Done this week', lines: ['hub/old: done'] },
  ],
  'Lock: weather unit tests (session s1, since 2026-11-07 11:50), 1 heavy job waiting, 1 of 2 steps running, no device claims.',
)

// What `k board --card <id>` prints for a draft (kirunak-drafts S-4): its card, markdown.
export const draftCardOf = (d: DraftRow): string => `### ${d.id}\n\n${d.title}.\n\n- Draft, ${d.written ? `written ${d.written}` : 'no date written'}.\n`

// What `k board --card <id>` prints for a task of `rows`: its card, markdown.
export const cardOf = (r: KirunakRow): string => `### ${r.id}\n\n${r.title}.\n\n- State: ${r.state}.\n${[...r.ac, ...r.e].map(x => `- ${x.id} ${x.verdict ?? 'no verdict'}: ${x.text}\n`).join('')}`

// What `k waiting --json` gives for those rows.
export const WAITING: Waiting = {
  amendments: AMENDMENTS,
  approve: [{ id: 'hub/proposed', title: 'Asks for approval', why: null }],
  accept: [
    { id: 'weather/was-reviewed', title: 'Reviewed and met', review: { file: 'review.md', verdict: 'met' }, why: null },
    { id: ID, title: 'The last forecast stays readable offline', review: { file: 'review.md', verdict: 'needs owner (E-1)' }, why: `${ID}: checklist.md has 1 unticked item(s):\n  - [ ] E-1 On the oldest phone. (review.md)`, checklistOpen: 1, onlyChecklist: true },
  ],
  hold: [
    { id: ID, title: 'The last forecast stays readable offline', state: 'in review' },
    { id: 'hub/sync-notes', title: 'Sync notes', state: 'queued' },
  ],
  // k start takes what k list shows: every task neither done nor on hold.
  start: ROWS.filter(r => r.state !== 'done').map(({ id, title, state }) => ({ id, title, state })),
}

export const status = (task: string | null): KirunakStatus => ({
  home: '/h/.kirunak',
  lock: { what: 'weather unit tests', session: 's1', since: '2026-11-07T11:50:00Z' },
  queue: [{ what: 'hub build', session: 's2' }],
  running: [{ task: ID, step: 'S-2', since: '2026-11-07T11:40:00Z' }],
  maxAgents: 2,
  session: { id: 'sess-1', task, step: null, since: task ? '2026-11-07T11:00:00Z' : null },
})

type Answer = { exitCode: number; stdout: string; stderr: string }

// A dialog the mod opened: its question, choices and chip.
export type Asked = { question: string; labels: string[]; header: string }

// The world beneath the mod: a clock, the commands it registers, its session's id (`idRead`: how many dialogs had
// opened at each read of it), a k that exists and answers `k list` (from `rows`, ROWS unless a test gives its own),
// `k status`, `k waiting` and `k board --brief` from the fixtures above, `k board --card <id>` for a task of `rows` or a draft (any
// other id refused) (each owner verb with `verb`), the amendment files,
// `k drafts --json` from `drafts` (each read takes the next, the last again once they run out; null is a k that failed),
// the prompts the mod submitted (`submitted`), events.jsonl's lines as tail would print them, the toasts and panes the mod raised, and the owner's answers to its
// dialogs: each dialog takes the next of `taps` (a choice, '[No preference]' for Skip, or typed text), null or none
// left dismisses it; the environment (`env`: KIRUNAK_HOME unset, HOME /home/dev unless a test gives its own) and the
// files the mod wrote (`files`, read back by fs.read; `unwritable` refuses every write).
export function world(on: On, { verb = { exitCode: 0, stdout: `${ID}: done\n`, stderr: '' } as Answer, task = ID as string | null, events = [] as string[], broken = false, linkedTo = null as string | null, waiting = [WAITING] as (Waiting | null)[], brief = { exitCode: 0, stdout: JSON.stringify(BRIEF), stderr: '' } as Answer, verbFails = null as string | null, taps = [] as (string | null)[], rows = ROWS, env = { HOME: '/home/dev' } as Record<string, string>, unwritable = false, drafts = [DRAFTS] as (DraftRow[] | null)[] } = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 7, 12, 0) })
  const w = { clock, registered: [] as string[], runs: [] as string[][], reads: 0, waits: 0, boards: [] as string[][], tails: [] as string[][], toasts: [] as string[], panes: new Set<string>(), asked: [] as Asked[], idRead: [] as number[], files: {} as Record<string, string>, draftReads: 0, submitted: [] as { text: string; origin: PromptOrigin }[] }
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = e.questions[0]
    if (q === undefined) return { deny: 'no question' }
    w.asked.push({ question: q.question, labels: q.options.map(o => o.label), header: q.header })
    const tap = taps.shift() ?? null
    return tap === null ? { deny: 'dismissed' } : { result: { questions: e.questions, answers: { [q.question]: tap } } }
  })
  on('command.register', ($, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  // How many dialogs had opened when the session's id was read.
  on('session.id', () => {
    w.idRead.push(w.asked.length)
    return { value: 'sess-1' }
  })
  // `broken` makes the mod's first question about k fail, as a hook that throws.
  on('fs.exists', () => (broken ? { deny: 'the disk is gone' } : { value: true }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('fs.write', ($, e) => {
    if (unwritable) return { deny: `EACCES: permission denied, ${e.path}` }
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.read', ($, e) => (w.files[e.path] !== undefined ? { value: w.files[e.path] as string } : FILES[e.path] !== undefined ? { value: FILES[e.path] as string } : { deny: `ENOENT: no such file, ${e.path}` }))
  // The mod's folder, or with `linkedTo` a link to that folder.
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: linkedTo !== null, realPath: linkedTo ?? e.path } }))
  on('prompt.autocomplete', () => ({ suggestions: [{ text: 'engine-row' }] }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('process.run', ($, e) => {
    const [, , what] = e.argv
    let answer = verb
    if (what === 'list' || what === 'status') {
      w.reads += what === 'list' ? 1 : 0
      // k list leaves out done and on hold unless asked for --all.
      const shown = e.argv.includes('--all') ? rows : rows.filter(r => r.state !== 'done' && r.state !== 'on hold')
      answer = { exitCode: 0, stdout: JSON.stringify(what === 'list' ? { rows: shown } : status(task)), stderr: '' }
    } else if (what === 'board') {
      w.boards.push([...e.argv])
      const at = e.argv.indexOf('--card')
      const id = at < 0 ? null : (e.argv[at + 1] ?? '')
      const r = rows.find(x => x.id === id)
      const d = DRAFTS.find(x => x.id === id)
      answer = id === null ? brief : r ? { exitCode: 0, stdout: cardOf(r), stderr: '' } : d ? { exitCode: 0, stdout: draftCardOf(d), stderr: '' } : { exitCode: 1, stdout: '', stderr: `k: no task ${id}\n` }
    } else if (what === 'drafts') {
      w.draftReads++
      const next = drafts.length > 1 ? drafts.shift() : drafts[0]
      answer = next ? { exitCode: 0, stdout: JSON.stringify(next), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'k: the workspace did not load\n' }
    } else if (what === 'waiting') {
      w.waits++
      // Each `k waiting` takes the next answer, the last one again once they run out; null is a k that failed.
      const next = waiting.length > 1 ? waiting.shift() : waiting[0]
      answer = next ? { exitCode: 0, stdout: JSON.stringify(next), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'k: the workspace did not load\n' }
    } else {
      w.runs.push([...e.argv])
      // `verbFails`: the verb never finished, as a timeout rejects.
      if (verbFails !== null) return { deny: verbFails }
    }
    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    w.tails.push([...e.argv])
    for (const line of events) yield { stream: 'stdout' as const, text: `${line}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...w.panes].map(id => ({ id, title: 'kirunak', isShown: true, isFocused: false, isPlaced: true })) }))
  return w
}

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

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

const AMENDMENT_DIR = '/w/weather/kirunak/tasks/offline-forecast/amendments'

// The amendments `k waiting --json` gives: one k would approve, one it would refuse.
export const AMENDMENTS: AmendmentRow[] = [
  { id: ID, amendment: 'A-3', title: 'The last forecast stays readable offline', proposed: '2026-11-06', by: 'session s1', why: 'The age line needs its words.', lines: 2, refuse: null, file: `${AMENDMENT_DIR}/A-3.md` },
  { id: ID, amendment: 'A-4', title: 'The last forecast stays readable offline', proposed: '2026-11-06', by: 'session s1', why: 'E-1 is covered by AC-1.', lines: 1, refuse: `${ID} with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have`, file: `${AMENDMENT_DIR}/A-4.md` },
]

// Their files, as the mod reads them for `/k-amendments <n>`.
export const FILES: Record<string, string> = {
  [`${AMENDMENT_DIR}/A-3.md`]: `---\ntask: ${ID}\nproposed: 2026-11-06\nby: session s1\n---\n\n## Why\nThe age line needs its words. The old one was a time alone.\n\n## Changes\n- replace E-1: A forecast older than a day says "yesterday".\n- replace D-1: Keep the last three days.\n`,
}

// What `k board --markdown` prints: its heading names kirunak, which the engine's prefix already does.
export const BOARD = '# kirunak board\n\nMade at 2026-11-07 12:00.\n\n## Working on now (1)\n\n### weather/offline-forecast\n'

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
// `k status`, `k waiting` and `k board` from the fixtures above (each owner verb with `verb`), the amendment files,
// events.jsonl's lines as tail would print them, the toasts and panes the mod raised, and the owner's answers to its
// dialogs: each dialog takes the next of `taps` (a choice, '[No preference]' for Skip, or typed text), null or none
// left dismisses it.
export function world(on: On, { verb = { exitCode: 0, stdout: `${ID}: done\n`, stderr: '' } as Answer, task = ID as string | null, events = [] as string[], broken = false, linkedTo = null as string | null, waiting = [WAITING] as (Waiting | null)[], board = { exitCode: 0, stdout: BOARD, stderr: '' } as Answer, verbFails = null as string | null, taps = [] as (string | null)[], rows = ROWS } = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 7, 12, 0) })
  const w = { clock, registered: [] as string[], runs: [] as string[][], reads: 0, waits: 0, boards: [] as string[][], tails: [] as string[][], toasts: [] as string[], panes: new Set<string>(), asked: [] as Asked[], idRead: [] as number[] }
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
  // How many dialogs had opened when the session's id was read.
  on('session.id', () => {
    w.idRead.push(w.asked.length)
    return { value: 'sess-1' }
  })
  // `broken` makes the mod's first question about k fail, as a hook that throws.
  on('fs.exists', () => (broken ? { deny: 'the disk is gone' } : { value: true }))
  on('fs.read', ($, e) => (FILES[e.path] !== undefined ? { value: FILES[e.path] as string } : { deny: `ENOENT: no such file, ${e.path}` }))
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
      answer = board
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

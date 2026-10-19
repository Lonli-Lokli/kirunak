import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

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
  { id: 'hub/sync-notes', repo: 'hub', title: 'Sync notes', state: 'ready', queue: 2, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
  { id: 'hub/old', repo: 'hub', title: 'Done before', state: 'done', queue: null, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
  { id: 'weather/was-reviewed', repo: 'weather', title: 'Reviewed and met', state: 'reviewed', queue: null, step: null, lock: null, review: { file: 'review.md', verdict: 'met' }, checklist: null, ac: [], e: [] },
  { id: 'hub/proposed', repo: 'hub', title: 'Asks for approval', state: 'proposed', queue: null, step: null, lock: null, review: null, checklist: null, ac: [], e: [] },
]

// What `k waiting --json` gives for those rows.
export const WAITING = {
  approve: [{ id: 'hub/proposed', title: 'Asks for approval', why: null }],
  accept: [
    { id: 'weather/was-reviewed', title: 'Reviewed and met', review: { file: 'review.md', verdict: 'met' }, why: null },
    { id: ID, title: 'The last forecast stays readable offline', review: { file: 'review.md', verdict: 'needs owner (E-1)' }, why: `${ID}: checklist.md has 1 unticked item(s):\n  - [ ] E-1 On the oldest phone. (review.md)` },
  ],
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

// The world beneath the mod: a clock, the commands it registers, its session's id, a k that exists and answers
// `k list` and `k status` from the fixtures above (each owner verb with `verb`), events.jsonl's lines as tail would
// print them, and the toasts and panes the mod raised.
export function world(on: On, { verb = { exitCode: 0, stdout: `${ID}: done\n`, stderr: '' } as Answer, task = ID as string | null, events = [] as string[], broken = false, linkedTo = null as string | null } = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 7, 12, 0) })
  const w = { clock, registered: [] as string[], runs: [] as string[][], reads: 0, tails: [] as string[][], toasts: [] as string[], panes: new Set<string>() }
  on('command.register', ($, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  // `broken` makes the mod's first question about k fail, as a hook that throws.
  on('fs.exists', () => (broken ? { deny: 'the disk is gone' } : { value: true }))
  // The mod's folder, or with `linkedTo` a link to that folder.
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: linkedTo !== null, realPath: linkedTo ?? e.path } }))
  on('prompt.autocomplete', () => ({ suggestions: [{ text: 'engine-row' }] }))
  on('process.run', ($, e) => {
    const [, , what] = e.argv
    let answer = verb
    if (what === 'list' || what === 'status') {
      w.reads += what === 'list' ? 1 : 0
      answer = { exitCode: 0, stdout: JSON.stringify(what === 'list' ? { rows: ROWS } : status(task)), stderr: '' }
    } else if (what === 'waiting') {
      answer = { exitCode: 0, stdout: JSON.stringify(WAITING), stderr: '' }
    } else {
      w.runs.push([...e.argv])
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

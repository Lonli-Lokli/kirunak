import type { KirunakBoard, KirunakRow } from '../types'
import { STATES, stateOf, taskChip } from './looks'
import type { State } from './looks'

// What the pane, the band and the toasts say, from the last read (boards.md §4). Plain text with a tone each, and the
// state of a line that has one, so the render hooks only map them onto Text's props, and the words are the same on
// every surface.

export type Tone = 'plain' | 'dim' | 'bold'
export type Line = { text: string; tone: Tone; state?: State }

// The five states on the terminal (gulnya/mobile-dialogs AC-8, O-2): the theme's own key where it has one, so the
// colour follows the person's theme, and the dialogs' orange for waits, which no key names.
export const PANE_COLORS: Record<State, string> = { done: 'success', running: 'warning', na: 'inactive', waits: STATES.waits.fill, failed: 'error' }

// A progress line as k list's row carries it, less its date and a review's hash, as `k list` prints it.
export const stepOf = (step: string | null): string | null =>
  step === null ? null : step.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, '').replace(/ sha256:[0-9a-f]{64}/, '')

// A verdict's state, as the board's page has it: met done, not met failed, needs device or owner waits, none n/a. A
// task's, as its chip in the dialogs (looks.ts TASK_STAGES).
const verdictState = (verdict: string | null): State =>
  verdict === null ? 'na' : verdict === 'met' ? 'done' : verdict.startsWith('not met') ? 'failed' : 'waits'
const taskState = (state: string): State => stateOf(taskChip(state).stage)

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const taskOf = (board: KirunakBoard): KirunakRow | undefined =>
  board.rows.find(r => r.id === board.status?.session?.task)

export function paneLines(board: KirunakBoard | null): Line[] {
  if (board === null) return [{ text: 'Reading kirunak...', tone: 'dim' }]
  const out: Line[] = []
  if (board.error !== null) out.push({ text: `k did not answer: ${board.error}`, tone: 'plain', state: 'failed' })
  const st = board.status
  const current = st?.session?.task ?? null
  const task = taskOf(board)
  if (current === null) {
    out.push({ text: 'No task in this session: /k-start <id> names one.', tone: 'dim' })
  } else if (task === undefined) {
    // A task k list does not have is a failed read, red as k's own failure is (AC-8), no longer yellow, which runs.
    out.push({ text: `${current}: k list does not have it`, tone: 'plain', state: 'failed' })
  } else {
    out.push({ text: `${task.id}  ${task.state}${task.queue !== null ? `, queue place ${task.queue}` : ''}`, tone: 'bold', state: taskState(task.state) })
    out.push({ text: task.title, tone: 'plain' })
    for (const item of [...task.ac, ...task.e]) {
      out.push({ text: `${item.id} ${item.verdict ?? 'no verdict'}: ${item.text}`, tone: 'plain', state: verdictState(item.verdict) })
    }
    const step = stepOf(task.step)
    if (step !== null) out.push({ text: `step: ${step}`, tone: 'dim' })
    if (task.review !== null) out.push({ text: `review: ${task.review.file}${task.review.verdict ? `, verdict: ${task.review.verdict}` : ''}`, tone: 'dim' })
    if (task.checklist !== null) out.push({ text: `checklist: ${task.checklist.open} open, ${task.checklist.ticked} ticked`, tone: 'dim' })
  }
  const queued = board.rows.filter(r => r.queue !== null).sort((a, b) => (a.queue ?? 0) - (b.queue ?? 0))
  out.push({ text: '', tone: 'plain' }, { text: queued.length ? 'Queue' : 'The queue is empty', tone: 'bold' })
  for (const r of queued) out.push({ text: `${String(r.queue).padStart(2)}  ${r.state}  ${r.id}`, tone: r.id === current ? 'bold' : 'plain', state: taskState(r.state) })
  if (st !== null) {
    const waiting = st.queue.length ? `, ${st.queue.length} waiting` : ''
    const lock = st.lock ? `lock: ${st.lock.what ?? 'a job'}${st.lock.session ? ` (session ${st.lock.session})` : ''}${waiting}` : `no lock${waiting}`
    out.push({ text: '', tone: 'plain' }, { text: lock, tone: 'plain' })
    out.push({ text: `running steps: ${st.running.length} of ${st.maxAgents}`, tone: 'dim' })
  }
  out.push({ text: `read at ${clock(board.at)}`, tone: 'dim' })
  return out
}

// The line above the prompt: task · step · lock holder · queue place; none while the session has no task.
export function bandLine(board: KirunakBoard | null): string | null {
  const current = board?.status?.session?.task ?? null
  if (board === null || current === null) return null
  const task = taskOf(board)
  const step = stepOf(task?.step ?? null)
  const lock = board.status?.lock?.what
  return ['kirunak', current, step, lock ? `lock: ${lock}` : null, task?.queue ? `queue place ${task.queue}` : null]
    .filter(Boolean)
    .join(' · ')
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

// A line of events.jsonl as a toast: a heavy job ended, a review is ready, a cache was kept warm, a step waits for
// the owner, a hook refused an edit. Null for every other line, and for one that does not parse.
export function toastFor(line: string): string | null {
  let ev: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    ev = v as Record<string, unknown>
  } catch {
    return null
  }
  const where = [str(ev.task), str(ev.step)].filter(Boolean).join(' ')
  const at = where ? ` (${where})` : ''
  switch (ev.kind) {
    case 'build-ended': {
      const minutes = typeof ev.minutes === 'number' ? `, ${ev.minutes} min` : ''
      return `${str(ev.what) ?? 'a heavy job'} ended, exit ${String(ev.exitCode ?? '?')}${minutes}${at}`
    }
    case 'review-ready':
      return `the review is ready: ${str(ev.file) ?? 'review.md'}${at}`
    case 'keep-alive':
      return `cache kept warm${at || (str(ev.session) ? ` (session ${str(ev.session)})` : '')}`
    case 'awaiting owner':
      return `${where || 'a step'} waits for you${str(ev.question) ? `: ${str(ev.question)}` : ''}`
    case 'refusal':
      return `refused ${str(ev.tool) ?? 'a tool call'}: ${(str(ev.reason) ?? 'no reason given').split('\n')[0]}`
    default:
      return null
  }
}

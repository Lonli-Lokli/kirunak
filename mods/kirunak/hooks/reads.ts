import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { KirunakBoard, KirunakRow } from '../types'
import { toastFor } from './board'

// kirunak's command line, from the same checkout as this mod: mods/kirunak/../../bin/k.mjs, from the folder's real
// path, so a mod loaded through a link (a mods folder's) still finds its checkout's k.
export async function kOf($: EngineInterface): Promise<string> {
  const root = await $.fs.stat($.plugin.root, { resolve: true }).then(
    s => s.realPath ?? $.plugin.root,
    () => $.plugin.root,
  )
  return `${root}/../../bin/k.mjs`
}

const board = atom({ plugin: 'kirunak', key: 'board' } as const, null)

// One read at a time: a read asked for while one runs makes one more after it, so a burst of events costs two. The
// module's own variables, so a reload starts them over.
let reading: Promise<void> | null = null
let again = false
let following = false
let last: KirunakBoard | null = null

async function readBoard($: EngineInterface): Promise<void> {
  const k = await kOf($)
  const at = await $.clock.now()
  try {
    const session = await $.session.id()
    const [list, status] = await Promise.all([
      $.process.run(['node', k, 'list', '--json', '--all']),
      $.process.run(['node', k, 'status', '--json', '--session', session]),
    ])
    const failed = [list, status].find(r => r.exitCode !== 0)
    if (failed) throw new Error((failed.stderr || failed.stdout).trim().split('\n')[0] || `exit ${failed.exitCode}`)
    last = { rows: JSON.parse(list.stdout).rows, status: JSON.parse(status.stdout), at, error: null }
  } catch (err) {
    // The rows of the last good read stay on screen under the reason.
    last = { rows: last?.rows ?? [], status: last?.status ?? null, at, error: err instanceof Error ? err.message : String(err) }
  }
  const shown = last
  await update($, board, () => shown)
}

// The clock's read, which also starts the events' tail when none runs (a read an event asked for never does, so a
// tail that ends cannot start itself again in a loop).
export async function tick($: EngineInterface): Promise<void> {
  await refresh($)
  if (last?.status) follow($, last.status.home)
}

export function refresh($: EngineInterface): Promise<void> {
  if (reading) {
    again = true
    return reading
  }
  reading = (async () => {
    do {
      again = false
      // A read that fails outside its own catch (the session ending under it) is dropped: no read rejects.
      await readBoard($).catch(() => undefined)
    } while (again)
  })().finally(() => {
    reading = null
  })
  return reading
}

// events.jsonl, followed for the session's life: a new line may toast, and asks for a read at once. A tail that
// could not start or stopped is started again by the next tick.
function follow($: EngineInterface, home: string): void {
  if (following) return
  following = true
  void (async () => {
    let rest = ''
    try {
      for await (const piece of $.process.spawn({ argv: ['tail', '-n', '0', '-F', `${home}/events.jsonl`] })) {
        if (piece.stream !== 'stdout') continue
        const lines = (rest + piece.text).split('\n')
        rest = lines.pop() ?? ''
        for (const line of lines) {
          const text = toastFor(line)
          if (text !== null) $.ui.toast(text)
        }
        if (lines.length) void refresh($)
      }
    } catch {
      // tail is not there or failed: nothing toasts until the next tick starts it again
    } finally {
      following = false
    }
  })()
}

// The task the last read found for this session (k start's record), if any.
export function sessionTask(): string | null {
  return last?.status?.session?.task ?? null
}

// The rows of the last read, for the typeahead, which must not wait on a read of its own.
export function lastRows(): readonly KirunakRow[] {
  return last?.rows ?? []
}

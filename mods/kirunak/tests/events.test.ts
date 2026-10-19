import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, world } from './world'

const start = async ($: Engine, w: ReturnType<typeof world>) => {
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

describe('the reads and the toasts', () => {
  test('a build-ended line in events.jsonl toasts, and asks for a read at once; a line of no such kind does not', async ($, on) => {
    const ended = JSON.stringify({ time: '2026-11-07T12:01:00Z', kind: 'build-ended', task: ID, step: 'S-1', what: 'weather unit tests', exitCode: 0, minutes: 3.5 })
    const w = world(on, { events: [ended, JSON.stringify({ kind: 'approved', task: ID }), 'not json'] })
    await start($, w)
    expect(w.tails).toEqual([['tail', '-n', '0', '-F', '/h/.kirunak/events.jsonl']])
    expect(w.toasts).toEqual([`weather unit tests ended, exit 0, 3.5 min (${ID} S-1)`])
    // The start's read, then one for the burst and at most one more for the lines that came during it.
    expect([2, 3]).toContain(w.reads)
  })

  test('a tail that ended is started again by the 30 s tick, and never by a read a command asked for', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(w.tails.length).toBe(1)
    await $.command.run({ command: 'k-start', args: ID, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    await w.clock.settle()
    expect([w.reads, w.tails.length]).toEqual([2, 1])
    await w.clock.advance(30_000)
    expect([w.reads, w.tails.length]).toEqual([3, 2])
  })

  test('k list and k status run once at the start, then no more than every 30 s', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(w.reads).toBe(1)
    await w.clock.advance(29_000)
    expect(w.reads).toBe(1)
    await w.clock.advance(1_000)
    expect(w.reads).toBe(2)
    await w.clock.advance(30_000)
    expect(w.reads).toBe(3)
  })
})

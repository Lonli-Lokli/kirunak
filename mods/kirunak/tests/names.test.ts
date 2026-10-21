import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { amendmentLines } from '../hooks/lists'
import type { AmendmentRow } from '../hooks/waiting'

import { AMENDMENTS, FILES, ID, QUEUE, WAITING, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'bridge' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
const FORECAST = 'The last forecast stays readable offline'
const REFUSED = { id: 'hub/refused', title: 'Refused for now', why: 'hub/refused: task.md fails k check: AC-1 has no source' }

// The owner's ask (A-8, Q-38): "their names and specific amendment inside when I select it". Each picking list's text
// is its rows' names alone; the row picked shows its details in the next dialog's text.
describe('names in the list, details once picked (A-8)', () => {
  const cases: { command: string; rows?: typeof QUEUE; pick: string; list: string; title: string; inside: string[] }[] = [
    { command: 'k-approve', pick: REFUSED.id, list: 'Waiting for you to approve:\n1. hub/proposed: proposed\n2. hub/refused: proposed\nWhich task?', title: 'Refused for now', inside: ['State: proposed.', 'Not yet:', 'task.md fails k check: AC-1 has no source'] },
    { command: 'k-accept', pick: ID, list: `Waiting for you to accept:\n1. weather/was-reviewed: reviewed\n2. ${ID}: awaiting owner\nWhich task?`, title: FORECAST, inside: ['State: awaiting owner.', 'Review: review.md, needs owner (E-1).', 'checklist.md has 1 unticked item(s):', '- [ ] E-1 On the oldest phone. (review.md)'] },
    { command: 'k-hold', pick: 'hub/sync-notes', list: `Tasks you can put on hold:\n1. ${ID}: in review\n2. hub/sync-notes: queued\nWhich task?`, title: 'Sync notes', inside: ['State: queued.'] },
    { command: 'k-start', pick: 'hub/sync-notes', list: `Tasks this session can work on: (1 to 3 of 5)\n1. ${ID}: in review\n2. hub/sync-notes: queued\n3. weather/was-reviewed: reviewed\nWhich task?`, title: 'Sync notes', inside: ['State: queued.'] },
    { command: 'k-queue', rows: QUEUE, pick: 'hub/next', list: `The queue in order, then the parked tasks: (1 to 3 of 5)\n1. ${ID}: in review, place 1\n2. hub/sync-notes: queued, place 2\n3. hub/next: queued, place 3\nWhich task?`, title: 'Next up', inside: ['Queued, place 3 of 4 in the queue.'] },
  ]
  for (const c of cases) {
    test(`/${c.command}: the list is each row's id and state, one line each; the task picked shows its title and the rest`, async ($, on) => {
      const w = world(on, { rows: c.rows, waiting: [{ ...WAITING, approve: [...WAITING.approve, REFUSED] }], taps: [c.pick, SKIP] })
      await run($, c.command)
      const [list, item] = w.asked
      expect(list?.question).toBe(c.list)
      expect(list?.question).not.toContain(c.title)
      expect(list?.labels).toContain(c.pick)
      expect(item?.question).toMatch(new RegExp(`^${c.pick}: ${c.title}\\.\\n`))
      for (const line of c.inside) expect(item?.question.split('\n')).toContain(line)
      expect(w.runs).toEqual([])
    })
  }

  test('/k-amendments: the list is task id, A-n and name; one picked shows in full from its file: the date, Why, Changes, how many lines, and that k would approve it', async ($, on) => {
    const w = world(on, { taps: [`${ID} A-3`, SKIP] })
    await run($, 'k-amendments')
    const [list, item] = w.asked
    expect(list?.question).toBe(`Waiting for your approval:\n1. ${ID} A-3: Age line in words\n2. ${ID} A-4: replaces E-1\nWhich amendment?`)
    for (const words of ['2026-11-06', 'The age line needs its words', 'E-1 is covered by AC-1', 'Changes', 'Not yet', 'fails k check', FORECAST]) expect(list?.question).not.toContain(words)
    expect(item?.question).toBe([
      `${ID} A-3: Age line in words. Proposed 2026-11-06 by session s1, changes 2 lines.`,
      `Task: ${FORECAST}.`,
      'Why:',
      'The age line needs its words. The old one was a time alone.',
      'Changes:',
      '- replace E-1: A forecast older than a day says "yesterday".',
      '- replace D-1: Keep the last three days.',
      'k would approve it now.',
      'Approve it, or decline it?',
    ].join('\n'))
  })

  test('/k-amendments: one whose file cannot be read shows k waiting\'s words and says so; what k would refuse is inside, above Decline alone', async ($, on) => {
    const w = world(on, { taps: [`${ID} A-4`, SKIP] })
    await run($, 'k-amendments')
    expect(w.asked[1]).toEqual({
      header: 'Amendments',
      question: [
        `${ID} A-4: replaces E-1. Proposed 2026-11-06 by session s1, changes 1 line.`,
        `Task: ${FORECAST}.`,
        'Why:',
        'E-1 is covered by AC-1.',
        `Its file could not be read, so its Changes are not shown: ${AMENDMENTS[1]?.file}`,
        'Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have',
        'k would refuse its approval now. Decline it?',
      ].join('\n'),
      labels: ['Decline', 'Back'],
    })
  })

  test('an amendment applied or declined since the list was read says so where k\'s word would be; with no name, its id and A-n alone', () => {
    const [A3] = AMENDMENTS as [AmendmentRow]
    const file = FILES[A3.file] as string
    expect(amendmentLines(A3, file.replace('by: session s1\n', 'by: session s1\napplied: 2026-11-07\n')).at(-1)).toBe('Applied on 2026-11-07 since the list was shown.')
    expect(amendmentLines(A3, file.replace('by: session s1\n', 'by: session s1\ndeclined: covered\n')).at(-1)).toBe('Declined since the list was shown: covered')
    expect(amendmentLines({ ...A3, name: '' }, file)[0]).toBe(`${ID} A-3. Proposed 2026-11-06 by session s1, changes 2 lines.`)
  })
})

import { describe, expect, test } from 'claude-code/testing'

import { amendmentItem, amendmentLabel, amendmentsText, amendmentText, listText, plainLines, taskItem, taskLabel, WIDTH, wrap } from '../hooks/lists'
import type { AmendmentRow } from '../hooks/waiting'

import { AMENDMENTS, ID, ROWS } from './world'

const [A3, A4] = AMENDMENTS as [AmendmentRow, AmendmentRow]

// A phone shows a line of at most WIDTH characters without sideways scrolling; a longer one holds a single word.
const fits = (text: string): boolean => text.split('\n').every(l => l.length <= WIDTH || !/\S\s+\S/.test(l.trim()))

const FILE = `---
task: ${ID}
proposed: 2026-11-06
by: session s1
---

## Why
The age line needs its words. The old one was a time alone. [research docs/offline.md §2]

Kept *short*.

## Changes
- replace E-1: A forecast older than a day says "yesterday" or "2 days ago". [research docs/offline.md §2]
- replace D-1: Keep the last three days, the first one hourly. [research docs/offline.md §2]
`

describe('the lists the commands answer with', () => {
  test('/k-list: one numbered entry per task in k\'s order, state and queue place, id, title, the step as the pane shortens it', () => {
    const open = ROWS.filter(r => r.state !== 'done')
    expect(listText(open, false)).toBe([
      '5 tasks not done and not on hold, the queue first:',
      '',
      '1. in review, queue place 1, **weather/offline-forecast**: The last',
      '   forecast stays readable offline. Step: S-2 finished (review.md).',
      '2. ready, queue place 2, **hub/sync-notes**: Sync notes.',
      '3. reviewed, **weather/was-reviewed**: Reviewed and met.',
      '4. proposed, **hub/proposed**: Asks for approval.',
      '5. awaiting owner, **weather/asks-owner**: A step asked a question.',
      '',
      '/k-list all adds the done and on hold.',
    ].join('\n'))
    expect(listText(ROWS, true).split('\n').slice(0, 2)).toEqual(['6 tasks, done and on hold among them, the queue first:', ''])
    expect(listText(ROWS, true)).toContain('\n3. done, **hub/old**: Done before.\n')
    expect(listText([], false)).toBe('No open task: every task is done or on hold. /k-list all shows them.')
    expect(listText([], true)).toBe('No task in the workspace.')
  })

  test('no line wider than a phone but a lone id, and the task\'s text shows as written', () => {
    const long = { id: 'a-repository-with-a-long-name/a-forty-character-slug-for-the-test', title: 'Uses `k list`, *bold* words and snake_case, then 1. a list marker', state: 'in progress', queue: 12, step: '2026-11-07 11:40 S-12 started (session a-very-long-session-name-1234567890abcdef)' }
    const text = listText([...ROWS, long], true)
    expect(fits(text)).toBe(true)
    expect(text).toContain('**a-repository-with-a-long-name/a-forty-character-slug-for-the-test**:')
    expect(text).toContain('Uses \\`k list\\`, \\*bold\\* words and snake\\_case')
    // A word that would start a line as a list marker, a heading or a rule is escaped there, and only there.
    expect(wrap('aaa 1. bbb - c', '', 5)).toEqual(['aaa', '1\\.', 'bbb -', 'c'])
    expect(wrap('', '1. ')).toEqual(['1.'])
  })

  test('/k-amendments: numbered, task id and A-n, date proposed, the first sentence of the Why, the lines it changes, what k would refuse', () => {
    expect(amendmentsText(AMENDMENTS)).toBe([
      '2 amendments wait for your approval:',
      '',
      '1. **weather/offline-forecast A-3**, proposed 2026-11-06: The age line',
      '   needs its words. Changes 2 lines.',
      '2. **weather/offline-forecast A-4**, proposed 2026-11-06: E-1 is',
      '   covered by AC-1. Changes 1 line. Not yet: with A-4 applied fails k',
      '   check: line 9: aspect offline: in (E-1) names E-1, which the task',
      '   does not have',
      '',
      '/k-amendments 1 shows the first in full; /k-approve-amendment 1',
      'approves it.',
    ].join('\n'))
    expect(amendmentsText([A3])).toMatch(/^1 amendment waits for your approval:\n\n1\. \*\*weather\/offline-forecast A-3\*\*/)
    expect(amendmentsText([])).toBe('No amendment waits for your approval.')
  })

  test('/k-amendments <n>: the Why and Changes in full, from the file, and what follows', () => {
    expect(amendmentText(1, A3, FILE)).toBe([
      'weather/offline-forecast A-3, proposed 2026-11-06 by session s1, changes 2 lines.',
      '',
      'Why:',
      '',
      'The age line needs its words. The old one was a time alone. \\[research',
      'docs/offline.md §2\\]',
      '',
      'Kept \\*short\\*.',
      '',
      'Changes:',
      '',
      '- replace E-1: A forecast older than a day says "yesterday" or "2 days',
      '  ago". \\[research docs/offline.md §2\\]',
      '- replace D-1: Keep the last three days, the first one hourly.',
      '  \\[research docs/offline.md §2\\]',
      '',
      '/k-approve-amendment 1 approves it.',
    ].join('\n'))
    // One k would refuse says why, and offers no approval; one stamped since the list was shown says so.
    expect(amendmentText(2, A4, FILE).split('\n').slice(-2)).toEqual(['Not yet: with A-4 applied fails k check: line 9: aspect offline: in', '(E-1) names E-1, which the task does not have'])
    expect(amendmentText(1, A3, FILE.replace('by: session s1\n', 'by: session s1\napplied: 2026-11-07\n')).split('\n').at(-1)).toBe('Applied on 2026-11-07 since the list was shown.')
    expect(amendmentText(1, A3, '---\ntask: x\n---\n')).toMatch(/Why:\n\n\(empty\)\n\nChanges:\n\n\(none\)\n/)
  })

  test('the same rows as a dialog shows them: numbered plain lines, and short names for the choices', () => {
    expect(plainLines([A3, A4].map(amendmentItem), 4)).toEqual([
      '4. weather/offline-forecast A-3, proposed 2026-11-06: The age line needs its words. Changes 2 lines.',
      '5. weather/offline-forecast A-4, proposed 2026-11-06: E-1 is covered by AC-1. Changes 1 line. Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have',
    ])
    expect(plainLines([taskItem(ROWS[1] as (typeof ROWS)[number])])).toEqual(['1. ready, queue place 2, hub/sync-notes: Sync notes.'])
    expect([amendmentLabel(A3), taskLabel(ROWS[1] as (typeof ROWS)[number])]).toEqual(['weather/offline-forecast A-3', 'hub/sync-notes'])
  })
})

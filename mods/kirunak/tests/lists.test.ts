import { describe, expect, test } from 'claude-code/testing'

import { amendmentItem, amendmentLabel, amendmentsText, amendmentText, entry, listText, plainLines, queueNow, taskItem, taskLabel, unmarked } from '../hooks/lists'
import type { AmendmentRow } from '../hooks/waiting'

import { AMENDMENTS, ID, ROWS } from './world'

const [A3, A4] = AMENDMENTS as [AmendmentRow, AmendmentRow]

// The phone wraps a line itself, so no entry goes on past its line: no line starts with a space, as a line the mod
// broke would (S-10).
const unbroken = (text: string): boolean => text.split('\n').every(l => !/^\s/.test(l))

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
      '1. in review, queue place 1, **weather/offline-forecast**: The last forecast stays readable offline. Step: S-2 finished (review.md).',
      '2. queued, queue place 2, **hub/sync-notes**: Sync notes.',
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

  test('no entry is broken across lines, however long, and the task\'s text shows as written (S-10)', () => {
    const long = { id: 'a-repository-with-a-long-name/a-forty-character-slug-for-the-test', title: 'Uses `k list`, *bold* words and snake_case, then 1. a list marker', state: 'in progress', queue: 12, step: '2026-11-07 11:40 S-12 started (session a-very-long-session-name-1234567890abcdef)' }
    const text = listText([...ROWS, long], true)
    expect(unbroken(text)).toBe(true)
    expect(text.split('\n').filter(l => /^\d+\. /.test(l)).length).toBe(ROWS.length + 1)
    expect(text).toContain('\n7. in progress, queue place 12, **a-repository-with-a-long-name/a-forty-character-slug-for-the-test**: Uses \\`k list\\`, \\*bold\\* words and snake\\_case, then 1. a list marker. Step: S-12 started (session a-very-long-session-name-1234567890abcdef).')
    expect(text).toContain('**a-repository-with-a-long-name/a-forty-character-slug-for-the-test**:')
    expect(text).toContain('Uses \\`k list\\`, \\*bold\\* words and snake\\_case')
    // A word that would start the line as a list marker, a heading or a rule is escaped there, and only there.
    expect(entry('1. bbb  -\n c')).toBe('1\\. bbb - c')
    expect(entry('- c 1.', '2. ')).toBe('2. \\- c 1.')
    expect(entry('', '1. ')).toBe('1.')
  })

  test('/k-amendments: numbered, task id and A-n, date proposed, the first sentence of the Why, the lines it changes, what k would refuse', () => {
    expect(amendmentsText(AMENDMENTS)).toBe([
      '2 amendments wait for your approval:',
      '',
      '1. **weather/offline-forecast A-3**, proposed 2026-11-06: The age line needs its words. Changes 2 lines.',
      '2. **weather/offline-forecast A-4**, proposed 2026-11-06: E-1 is covered by AC-1. Changes 1 line. Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have',
      '',
      '/k-amendments 1 shows the first in full; /k-approve-amendment 1 approves it.',
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
      'The age line needs its words. The old one was a time alone. \\[research docs/offline.md §2\\]',
      '',
      'Kept \\*short\\*.',
      '',
      'Changes:',
      '',
      '- replace E-1: A forecast older than a day says "yesterday" or "2 days ago". \\[research docs/offline.md §2\\]',
      '- replace D-1: Keep the last three days, the first one hourly. \\[research docs/offline.md §2\\]',
      '',
      '/k-approve-amendment 1 approves it.',
    ].join('\n'))
    // One k would refuse says why, and offers no approval; one stamped since the list was shown says so.
    expect(amendmentText(2, A4, FILE).split('\n').at(-1)).toBe('Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have')
    expect(amendmentText(1, A3, FILE.replace('by: session s1\n', 'by: session s1\napplied: 2026-11-07\n')).split('\n').at(-1)).toBe('Applied on 2026-11-07 since the list was shown.')
    expect(amendmentText(1, A3, '---\ntask: x\n---\n')).toMatch(/Why:\n\n\(empty\)\n\nChanges:\n\n\(none\)\n/)
    expect(unbroken(amendmentText(1, { ...A3, id: 'a-repository-with-a-long-name/a-forty-character-slug-for-the-test' }, FILE.replace('session s1', 'session 1d4ef848 (asked by session gulnya-83 for the owner)')))).toBe(true)
  })

  test('the same rows as a dialog shows them: numbered plain lines, and short names for the choices', () => {
    expect(plainLines([A3, A4].map(amendmentItem), 4)).toEqual([
      '4. weather/offline-forecast A-3, proposed 2026-11-06: The age line needs its words. Changes 2 lines.',
      '5. weather/offline-forecast A-4, proposed 2026-11-06: E-1 is covered by AC-1. Changes 1 line. Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have',
    ])
    expect(plainLines([taskItem(ROWS[1] as (typeof ROWS)[number])])).toEqual(['1. queued, queue place 2, hub/sync-notes: Sync notes.'])
    expect([amendmentLabel(A3), taskLabel(ROWS[1] as (typeof ROWS)[number])]).toEqual(['weather/offline-forecast A-3', 'hub/sync-notes'])
  })

  test('a dialog\'s question loses its markdown marks: backticks, ** and * around words, a heading\'s leading #; a lone * stays (S-10)', () => {
    expect(unmarked('## Why\nRun `/k-queue` after **this**, and *then* the rest.\n  # Note\n#5 and 2 * 3 * 4, a*b*c\n*x*')).toBe('Why\nRun /k-queue after this, and then the rest.\n  Note\n#5 and 2 * 3 * 4, a*b*c\nx')
  })

  test('what a queue verb printed, as a numbered list; anything else as k said it', () => {
    expect(queueNow(' 1  hub/next\n 2  my_repo/sync-notes\n')).toBe('The queue now:\n\n1. hub/next\n2. my\\_repo/sync-notes')
    expect(queueNow('the queue is empty\n')).toBe('the queue is empty')
  })
})

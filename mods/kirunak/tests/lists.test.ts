import { describe, expect, test } from 'claude-code/testing'

import { listText, plainLines, taskItem, taskLabel, WIDTH, wrap } from '../hooks/lists'

import { ROWS } from './world'

// A phone shows a line of at most WIDTH characters without sideways scrolling; a longer one holds a single word.
const fits = (text: string): boolean => text.split('\n').every(l => l.length <= WIDTH || !/\S\s+\S/.test(l.trim()))

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

  test('the same rows as a dialog shows them: numbered plain lines, and short names for the choices', () => {
    expect(plainLines([taskItem(ROWS[1] as (typeof ROWS)[number])])).toEqual(['1. ready, queue place 2, hub/sync-notes: Sync notes.'])
    expect(taskLabel(ROWS[1] as (typeof ROWS)[number])).toBe('hub/sync-notes')
  })
})

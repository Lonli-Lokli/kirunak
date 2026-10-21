import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { KirunakRow } from '../types'

import { ID, ROWS, WAITING, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }): Promise<string> =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

describe('the lists as answers', () => {
  test('/k-list: k list\'s rows for a phone, done and on hold only with all; from the phone it says so under the list', async ($, on) => {
    const w = world(on)
    const open = await run($, 'k-list')
    expect(open.split('\n').slice(0, 3)).toEqual(['5 tasks not done and not on hold, the queue first:', '', '1. in review, queue place 1, **weather/offline-forecast**: The last forecast stays readable offline. Step: S-2 finished (review.md).'])
    expect(open).not.toContain('hub/old')
    expect(await run($, 'k-list', ' all ', { kind: 'bridge' })).toMatch(/^6 tasks, done and on hold among them, the queue first:\n[^]*\n3\. done, \*\*hub\/old\*\*: Done before\.\n[^]*\n\n\(typed in Remote Control\)$/)
    expect(await run($, 'k-list', 'everything')).toBe('/k-list takes all or nothing, not everything.')
    expect(w.reads).toBe(2)
    expect(w.runs).toEqual([])
  })

  test('/k-list breaks no entry across lines, however long its title and step: the phone wraps a line itself (S-10)', async ($, on) => {
    const long: KirunakRow = { ...(ROWS[1] as KirunakRow), id: 'hub/long-one', title: 'A title long enough that a line of seventy characters would have broken it in the middle of a sentence', state: 'in progress', queue: null, step: '2026-11-07 11:40 S-3 started (session a-very-long-session-name-1234567890abcdef) and more words after' }
    world(on, { rows: [...ROWS, long] })
    const lines = (await run($, 'k-list', '', { kind: 'bridge' })).split('\n')
    expect(lines.filter(l => /^\d+\. /.test(l)).length).toBe(6)
    expect(lines.filter(l => /^\s/.test(l))).toEqual([])
    expect(lines).toContain('6. in progress, **hub/long-one**: A title long enough that a line of seventy characters would have broken it in the middle of a sentence. Step: S-3 started (session a-very-long-session-name-1234567890abcdef) and more words after.')
  })

  test('/k-board answers k\'s refusal, of the brief board or of a card', async ($, on) => {
    world(on, { brief: { exitCode: 1, stdout: '', stderr: 'k: the workspace did not load\n' } })
    expect(await run($, 'k-board')).toBe('/k-board refused:\nk: the workspace did not load')
    expect(await run($, 'k-board', 'hub/nope')).toBe('/k-board refused:\nk: no task hub/nope')
  })

  test('/k-amendments lists what waits, numbered; /k-amendments <n> shows that one in full from the list last shown', async ($, on) => {
    world(on)
    expect(await run($, 'k-amendments', '1')).toBe('/k-amendments 1: 1 of which list? /k-amendments shows it first.')
    expect((await run($, 'k-amendments')).split('\n').slice(0, 5)).toEqual(['Nothing ran: dismissed.', '', '2 amendments wait for your approval:', '', '1. **weather/offline-forecast A-3**: Age line in words'])
    expect(await run($, 'k-amendments', '1', { kind: 'bridge' })).toBe([
      'weather/offline-forecast A-3: Age line in words. Proposed 2026-11-06 by session s1, changes 2 lines.',
      '',
      'Why:',
      '',
      'The age line needs its words. The old one was a time alone.',
      '',
      'Changes:',
      '',
      '- replace E-1: A forecast older than a day says "yesterday".',
      '- replace D-1: Keep the last three days.',
      '',
      '/k-approve-amendment 1 approves it.',
      '',
      '(typed in Remote Control)',
    ].join('\n'))
    expect(await run($, 'k-amendments', '2')).toBe(`/k-amendments 2: /w/weather/kirunak/tasks/offline-forecast/amendments/A-4.md could not be read (ENOENT: no such file, /w/weather/kirunak/tasks/offline-forecast/amendments/A-4.md).`)
    expect(await run($, 'k-amendments', '3')).toBe('/k-amendments 3: the list you were shown has no 3.')
    expect(await run($, 'k-amendments', '1 decline')).toBe('/k-amendments 1 decline: unexpected decline.')
    expect(await run($, 'k-amendments', 'A-3')).toBe('/k-amendments A-3: give an amendment\'s number from the list. Usage: /k-amendments [<n>]')
  })

  test('/k-approve-amendment <n> approves the n-th of the list /k-amendments last showed; any other number, or none, runs nothing', async ($, on) => {
    const w = world(on)
    expect(await run($, 'k-approve-amendment', '1')).toBe('/k-approve-amendment 1: 1 of which list? /k-amendments shows it first. Nothing ran.')
    await run($, 'k-amendments')
    expect(await run($, 'k-approve-amendment')).toBe('/k-approve-amendment: which one? give its number from /k-amendments. Nothing ran.')
    expect(await run($, 'k-approve-amendment', '3')).toBe('/k-approve-amendment 3: the list you were shown has no 3. Nothing ran.')
    expect(await run($, 'k-approve-amendment', '1 --first')).toBe('/k-approve-amendment 1 --first: unexpected --first. Nothing ran.')
    expect(await run($, 'k-approve-amendment', `${ID} A-3`)).toBe(`/k-approve-amendment ${ID} A-3: which one? give its number from /k-amendments. Nothing ran.`)
    expect(w.runs).toEqual([])
    expect(await run($, 'k-approve-amendment', '2', { kind: 'bridge' })).toBe(`${ID}: done\n(typed in Remote Control)`)
    expect(w.runs.map(argv => argv.slice(2))).toEqual([['approve', ID, '--amendment', 'A-4', '--via', 'mod']])
  })

  test('k checks the amendment again as it runs, and its refusal is the answer (E-2)', async ($, on) => {
    world(on, { verb: { exitCode: 1, stdout: '', stderr: `k: ${ID} A-3 was already applied on 2026-11-07\n` } })
    await run($, 'k-amendments')
    expect(await run($, 'k-approve-amendment', '1')).toBe(`/k-approve-amendment refused:\nk: ${ID} A-3 was already applied on 2026-11-07`)
  })

  test('/clear or a resume forgets the amendments shown, as does a list that could not be read', async ($, on) => {
    const w = world(on, { waiting: [WAITING, WAITING, null] })
    await run($, 'k-amendments')
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(await run($, 'k-approve-amendment', '1')).toBe('/k-approve-amendment 1: 1 of which list? /k-amendments shows it first. Nothing ran.')
    await run($, 'k-amendments')
    expect(await run($, 'k-amendments')).toBe('k waiting did not answer: k: the workspace did not load')
    expect(await run($, 'k-approve-amendment', '1')).toBe('/k-approve-amendment 1: 1 of which list? /k-amendments shows it first. Nothing ran.')
    expect(w.runs).toEqual([])
  })

  test('/k-approve with no id still lists only the tasks proposed, never an amendment (AC-2)', async ($, on) => {
    world(on)
    expect(await run($, 'k-approve')).toBe('Nothing ran: dismissed.\n\nWaiting for you to approve:\n  1  hub/proposed  can approve\n/k-approve 1 approves the first.')
  })

  const others: PromptOrigin[] = [{ kind: 'sdk' }, { kind: 'plugin', name: 'other' }, { kind: 'peer' }, { kind: 'task-notification' }, { kind: 'auto-continuation' }]
  for (const origin of others) {
    test(`from ${origin.kind}: each list is refused with a line, and k never runs`, async ($, on) => {
      const w = world(on)
      for (const [command, args] of [['k-list', 'all'], ['k-board', ''], ['k-board', ID], ['k-amendments', ''], ['k-amendments', '1'], ['k-approve-amendment', '1']] as const) {
        expect(await run($, command, args, origin)).toMatch(new RegExp(`^/${command} runs only from your own prompt or from Remote Control; this one came from .+, so nothing ran\\.$`))
      }
      expect([w.reads, w.boards.length, w.runs.length]).toEqual([0, 0, 0])
    })
  }

  test('a verb k did not finish says so without the engine\'s own prefix (AC-12)', async ($, on) => {
    world(on, { verbFails: 'timed out after 600000 ms' })
    await run($, 'k-amendments')
    expect(await run($, 'k-approve-amendment', '1')).toMatch(/^\/k-approve-amendment: k did not finish \((?!kirunak)[^]*timed out after 600000 ms\); `k list --all` says whether it took\.$/)
  })

  test('a list whose hook fails says so in the mod\'s own line', async ($, on) => {
    world(on, { broken: true })
    expect(await run($, 'k-board')).toBe('/k-board failed in the mod; the debug log says why.')
  })

  test('no answer of the mod names kirunak: the engine does, before its first line (AC-12)', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    const answers: string[] = []
    const calls: [string, string][] = [
      ['k-list', ''], ['k-list', 'all'], ['k-list', 'x'], ['k-board', ''], ['k-board', ID], ['k-board', 'hub/nope'], ['k-amendments', '1'], ['k-amendments', ''], ['k-amendments', '1'], ['k-amendments', '2'],
      ['k-approve-amendment', '1'], ['k-approve', ''], ['k-accept', ''], ['k-accept', '9'], ['k-hold', ID], ['k-resume', ID], ['k-resume', ''], ['k-start', ID], ['kirunak', ''], ['kirunak', ''],
    ]
    for (const [command, args] of calls) for (const kind of ['composer', 'bridge'] as const) answers.push(await run($, command, args, { kind }))
    answers.push(await run($, 'k-list', '', { kind: 'sdk' }))
    // A path or an id may hold the word; the mod's own words never do.
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

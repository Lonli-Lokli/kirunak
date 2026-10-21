import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { AmendmentRow } from '../hooks/waiting'

import { AMENDMENTS, briefOf, ID, QUEUE, WAITING, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }) =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
// k's arguments after `node <k>`.
const verbs = (runs: string[][]) => runs.map(argv => argv.slice(2))

// Seven proposed tasks, the second refused: three pages of the dialog.
const SEVEN = { ...WAITING, approve: [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `hub/t${n}`, title: `Task ${n}`, why: n === 2 ? 'hub/t2: task.md fails k check: AC-1 has no source' : null })) }

describe('picking by touch', () => {
  test('/k-approve: the list as numbered lines and the ids as choices, then the task in its own words above "Approve <id>", which runs k approve by id', async ($, on) => {
    const w = world(on, { taps: ['hub/proposed', 'Approve hub/proposed'], verb: { exitCode: 0, stdout: 'hub/proposed: queued, place 3\n', stderr: '' } })
    expect(await run($, 'k-approve')).toBe('hub/proposed: queued, place 3')
    expect(w.asked).toEqual([
      { header: 'Approve', question: 'Waiting for you to approve:\n1. hub/proposed: proposed\nWhich task?', labels: ['hub/proposed', 'Cancel'] },
      { header: 'Approve', question: 'hub/proposed: Asks for approval.\nState: proposed.\nk would approve it now.\nApprove it?', labels: ['Approve hub/proposed', 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['approve', 'hub/proposed', '--via', 'mod']])
  })

  test('a long list comes in pages of three and More, later pages under Back, numbered as the app numbers them; a task k would refuse offers no Approve (E-1, E-4, E-5)', async ($, on) => {
    const w = world(on, { waiting: [SEVEN], taps: ['More', 'More', 'Back', 'Back', 'hub/t2', 'Back', 'More', 'More', 'hub/t7', 'Approve hub/t7'] })
    await run($, 'k-approve')
    const [one, two, three] = [w.asked[0], w.asked[1], w.asked[2]]
    expect(one).toEqual({ header: 'Approve', question: 'Waiting for you to approve: (1 to 3 of 7)\n1. hub/t1: proposed\n2. hub/t2: proposed\n3. hub/t3: proposed\nWhich task?', labels: ['hub/t1', 'hub/t2', 'hub/t3', 'More'] })
    // A page after the first keeps the app's numbers and adds the one `/k-approve <n>` takes (Q-33).
    expect(two).toEqual({ header: 'Approve', question: 'Waiting for you to approve: (4 to 5 of 7)\n1. hub/t4 (type 4): proposed\n2. hub/t5 (type 5): proposed\nWhich task?', labels: ['hub/t4', 'hub/t5', 'More', 'Back'] })
    expect(three).toEqual({ header: 'Approve', question: 'Waiting for you to approve: (6 to 7 of 7)\n1. hub/t6 (type 6): proposed\n2. hub/t7 (type 7): proposed\nWhich task?', labels: ['hub/t6', 'hub/t7', 'Back'] })
    // Back shows the dialog before again: page two, then page one.
    expect([w.asked[3], w.asked[4]]).toEqual([two, one])
    expect(w.asked[5]).toEqual({ header: 'Approve', question: 'hub/t2: Task 2.\nState: proposed.\nNot yet:\ntask.md fails k check: AC-1 has no source\nk would refuse it now. Back to the list?', labels: ['Cancel', 'Back'] })
    expect(w.asked[6]).toEqual(one)
    expect(verbs(w.runs)).toEqual([['approve', 'hub/t7', '--via', 'mod']])
  })

  test('on a page after the first, /k-approve, /k-accept and /k-amendments give each line the number their typed command takes, which takes that row (Q-33)', async ($, on) => {
    const accept = [1, 2, 3, 4, 5].map(n => ({ id: `hub/a${n}`, title: `Accept ${n}`, review: { file: 'review.md', verdict: 'met' }, why: null }))
    const amendments = [1, 2, 3, 4, 5].map(n => ({ ...(AMENDMENTS[0] as AmendmentRow), amendment: `A-${n}`, name: `Name ${n}`, why: `Reason ${n}.`, lines: 1 }))
    const w = world(on, { waiting: [{ ...SEVEN, accept, amendments }], taps: ['More', SKIP, 'More', SKIP, 'More', SKIP] })
    for (const command of ['k-approve', 'k-accept', 'k-amendments']) await run($, command)
    expect(w.asked[1]?.question).toBe('Waiting for you to approve: (4 to 5 of 7)\n1. hub/t4 (type 4): proposed\n2. hub/t5 (type 5): proposed\nWhich task?')
    expect(w.asked[3]?.question).toBe('Waiting for you to accept: (4 to 5 of 5)\n1. hub/a4 (type 4): reviewed\n2. hub/a5 (type 5): reviewed\nWhich task?')
    expect(w.asked[5]?.question).toBe(`Waiting for your approval: (4 to 5 of 5)\n1. ${ID} A-4 (type 4): Name 4\n2. ${ID} A-5 (type 5): Name 5\nWhich amendment?`)
    // The first page's numbers are the typed ones already.
    for (const a of [w.asked[0], w.asked[2], w.asked[4]]) expect(a?.question).not.toMatch(/\(type /)
    expect(w.runs).toEqual([])
    await run($, 'k-approve', '4')
    await run($, 'k-accept', '5')
    await run($, 'k-approve-amendment', '4')
    expect(verbs(w.runs)).toEqual([['approve', 'hub/t4', '--via', 'mod'], ['accept', 'hub/a5', '--via', 'mod'], ['approve', ID, '--amendment', 'A-4', '--via', 'mod']])
  })

  test('/k-hold, /k-start and /k-queue take no number typed, so a page after the first adds none: /k-hold\'s and /k-start\'s lines keep the app\'s numbers, /k-queue\'s their places in the queue (A-11)', async ($, on) => {
    const hold = [1, 2, 3, 4, 5].map(n => ({ id: `hub/h${n}`, title: `Hold ${n}`, state: 'queued' }))
    const w = world(on, { rows: QUEUE, waiting: [{ ...WAITING, hold }], taps: ['More', SKIP, 'More', SKIP, 'More', SKIP, 'hub/next', 'Move', 'More', SKIP] })
    for (const command of ['k-hold', 'k-start', 'k-queue', 'k-queue']) await run($, command)
    expect(w.asked[1]?.question).toBe('Tasks you can put on hold: (4 to 5 of 5)\n1. hub/h4: queued\n2. hub/h5: queued\nWhich task?')
    expect(w.asked[3]?.question).toBe('Tasks this session can work on: (4 to 5 of 5)\n1. hub/proposed: proposed\n2. weather/asks-owner: awaiting owner\nWhich task?')
    expect(w.asked[5]?.question).toBe('The queue in order, then the parked tasks: (4 to 5 of 5)\n4. hub/later: queued. Later on.\nhub/parked: parked. Waits outside.\nWhich task?')
    expect(w.asked.map(a => a.question).join('\n')).not.toMatch(/\(type /)
    expect(w.runs).toEqual([])
  })

  test('Back is the lowest choice of every dialog after the command\'s first, below More and Cancel: a list\'s page, a pick\'s page, an item, a reason and one with nothing else to offer (A-11\'s E-1, E-5)', async ($, on) => {
    const brief = briefOf([{ name: 'Queued', lines: [1, 2, 3, 4, 5].map(n => `hub/q${n}: queued, queue ${n}`) }])
    const taps = ['More', 'hub/t4', SKIP, 'hub/t2', SKIP, ID, 'Hold', SKIP, 'Queued', SKIP, 'hub/next', 'Move', SKIP]
    const w = world(on, { rows: QUEUE, waiting: [SEVEN], brief: { exitCode: 0, stdout: JSON.stringify(brief), stderr: '' }, taps })
    for (const command of ['k-approve', 'k-approve', 'k-hold', 'k-board', 'k-queue']) await run($, command)
    expect(w.asked.map(a => a.labels)).toEqual([
      ['hub/t1', 'hub/t2', 'hub/t3', 'More'],
      ['hub/t4', 'hub/t5', 'More', 'Back'],
      ['Approve hub/t4', 'Back'],
      ['hub/t1', 'hub/t2', 'hub/t3', 'More'],
      // A refused task's item offers no verb: Cancel, so the dialog is not padded with Yes and No, then Back.
      ['Cancel', 'Back'],
      [ID, 'hub/sync-notes'],
      ['Hold', 'Back'],
      ['Cancel', 'Back'],
      // A command's first dialog has no Back: its one choice is padded with Cancel alone.
      ['Queued', 'Cancel'],
      ['hub/q1', 'hub/q2', 'More', 'Back'],
      [ID, 'hub/sync-notes', 'hub/next', 'More'],
      ['Move', 'Park hub/next', 'Back'],
      ['Earlier', 'Later', 'More', 'Back'],
    ])
    expect(w.runs).toEqual([])
  })

  test('a task id starting with a digit (the repo "2048") is listed, picked and approved through the dialog, and typed it is an id, not a number (finding 2)', async ($, on) => {
    const approve = [{ id: '2048/tiles', title: 'Tiles slide', why: null }, { id: 'hub/proposed', title: 'Asks for approval', why: null }]
    const w = world(on, { waiting: [{ ...WAITING, approve }], taps: ['2048/tiles', 'Approve 2048/tiles'] })
    await run($, 'k-approve')
    expect(w.asked).toEqual([
      { header: 'Approve', question: 'Waiting for you to approve:\n1. 2048/tiles: proposed\n2. hub/proposed: proposed\nWhich task?', labels: ['2048/tiles', 'hub/proposed'] },
      { header: 'Approve', question: '2048/tiles: Tiles slide.\nState: proposed.\nk would approve it now.\nApprove it?', labels: ['Approve 2048/tiles', 'Back'] },
    ])
    await run($, 'k-approve', '2048/tiles')
    expect(verbs(w.runs)).toEqual([['approve', '2048/tiles', '--via', 'mod'], ['approve', '2048/tiles', '--via', 'mod']])
  })

  test('from Remote Control, /k-approve\'s and /k-amendments\' dialogs run their verb by id, and every answer says it came from the phone', async ($, on) => {
    const w = world(on, { taps: ['hub/proposed', 'Approve hub/proposed', `${ID} A-3`, `Approve ${ID} A-3`, `${ID} A-4`, SKIP], verb: { exitCode: 0, stdout: 'hub/proposed: queued, place 3\n', stderr: '' } })
    const bridge: PromptOrigin = { kind: 'bridge' }
    expect(await run($, 'k-approve', '', bridge)).toBe('hub/proposed: queued, place 3\n(typed in Remote Control)')
    expect(await run($, 'k-amendments', '', bridge)).toBe('hub/proposed: queued, place 3\n\n(typed in Remote Control)')
    const skipped = await run($, 'k-amendments', '', bridge)
    expect(skipped).toMatch(/^Nothing ran: skipped\.\n\n2 amendments wait for your approval:\n/)
    expect(skipped).toMatch(/\n\n\(typed in Remote Control\)$/)
    expect(w.asked.map(a => a.header)).toEqual(['Approve', 'Approve', 'Amendments', 'Amendments', 'Amendments', 'Amendments'])
    expect(verbs(w.runs)).toEqual([['approve', 'hub/proposed', '--via', 'mod'], ['approve', ID, '--amendment', 'A-3', '--via', 'mod']])
  })

  test('/k-accept: "Accept <id>" for one k would accept; one stopped only by open checklist items takes a reason typed in the free-text row, shown above "Accept <id> with open items" (AC-9)', async ($, on) => {
    const w = world(on, { taps: ['weather/was-reviewed', 'Accept weather/was-reviewed', ID, 'Accept with open items', 'read on the phone', 'Back', ' read on the phone ', `Accept ${ID} with open items`] })
    await run($, 'k-accept')
    expect(w.asked[0]).toEqual({
      header: 'Accept',
      question: `Waiting for you to accept:\n1. weather/was-reviewed: reviewed\n2. ${ID}: awaiting owner\nWhich task?`,
      labels: ['weather/was-reviewed', ID],
    })
    expect(w.asked[1]?.labels).toEqual(['Accept weather/was-reviewed', 'Back'])
    await run($, 'k-accept')
    const text = `${ID}: The last forecast stays readable offline.\nState: awaiting owner.\nReview: review.md, needs owner (E-1).\nNot yet:\nchecklist.md has 1 unticked item(s):\n- [ ] E-1 On the oldest phone. (review.md)`
    expect(w.asked[3]).toEqual({ header: 'Accept', question: `${text}\nOnly open checklist items stop it. Accept it with them open?`, labels: ['Accept with open items', 'Back'] })
    const reason = { header: 'Accept', question: `${text}\nType the reason in the free-text row: why accept it with these items open?`, labels: ['Cancel', 'Back'] }
    expect(w.asked[4]).toEqual(reason)
    expect(w.asked[5]).toEqual({ header: 'Accept', question: `${text}\nReason: read on the phone\nAccept it with these items open, for that reason?`, labels: [`Accept ${ID} with open items`, 'Back'] })
    expect(w.asked[6]).toEqual(reason)
    expect(verbs(w.runs)).toEqual([
      ['accept', 'weather/was-reviewed', '--via', 'mod'],
      ['accept', ID, '--checklist-open', 'read on the phone', '--via', 'mod'],
    ])
  })

  test('/k-amendments: one k would approve offers "Approve <id> A-n" and Decline; one it would refuse, Decline alone, which takes a reason and runs k amend decline (AC-8)', async ($, on) => {
    const w = world(on, { taps: [`${ID} A-3`, `Approve ${ID} A-3`, `${ID} A-4`, 'Decline', 'covered by AC-1 already', `Decline ${ID} A-4`] })
    await run($, 'k-amendments')
    expect(w.asked[0]).toEqual({
      header: 'Amendments',
      question: [
        'Waiting for your approval:',
        `1. ${ID} A-3: Age line in words`,
        `2. ${ID} A-4: replaces E-1`,
        'Which amendment?',
      ].join('\n'),
      labels: [`${ID} A-3`, `${ID} A-4`],
    })
    expect(w.asked[1]).toEqual({
      header: 'Amendments',
      question: [
        `${ID} A-3: Age line in words. Proposed 2026-11-06 by session s1, changes 2 lines.`,
        'Task: The last forecast stays readable offline.',
        'Why:',
        'The age line needs its words. The old one was a time alone.',
        'Changes:',
        '- replace E-1: A forecast older than a day says "yesterday".',
        '- replace D-1: Keep the last three days.',
        'k would approve it now.',
        'Approve it, or decline it?',
      ].join('\n'),
      labels: [`Approve ${ID} A-3`, 'Decline', 'Back'],
    })
    await run($, 'k-amendments')
    expect(w.asked[3]?.labels).toEqual(['Decline', 'Back'])
    expect(w.asked[4]?.question).toMatch(/\nType the reason in the free-text row: why decline it\?$/)
    expect(w.asked[5]).toMatchObject({ question: expect.stringMatching(/\nReason: covered by AC-1 already\nDecline it, for that reason\?$/), labels: [`Decline ${ID} A-4`, 'Back'] })
    expect(verbs(w.runs)).toEqual([
      ['approve', ID, '--amendment', 'A-3', '--via', 'mod'],
      ['amend', 'decline', ID, 'A-4', '--why', 'covered by AC-1 already'],
    ])
  })

  test('no dialog\'s question shows a markdown mark: the backticks and ** a title or a Why carries are left out, in every dialog (S-10)', async ($, on) => {
    const why = 'Says `/k-queue` and **bold** first.'
    const amendments = AMENDMENTS.map(x => ({ ...x, why, name: 'Run `k` **now**', title: 'The `last` forecast, **offline**' }))
    const approve = [{ id: 'hub/proposed', title: 'Asks `k approve` for **this**', why: null }]
    const w = world(on, { waiting: [{ ...WAITING, amendments, approve }], taps: ['hub/proposed', SKIP, `${ID} A-3`, 'Decline', 'why', SKIP] })
    await run($, 'k-approve')
    await run($, 'k-amendments')
    expect(w.asked.length).toBe(6)
    expect(w.asked[0]?.question).toBe('Waiting for you to approve:\n1. hub/proposed: proposed\nWhich task?')
    expect(w.asked[1]?.question).toBe('hub/proposed: Asks k approve for this.\nState: proposed.\nk would approve it now.\nApprove it?')
    expect(w.asked[2]?.question).toBe(`Waiting for your approval:\n1. ${ID} A-3: Run k now\n2. ${ID} A-4: Run k now\nWhich amendment?`)
    expect(w.asked[3]?.question).toMatch(/: Run k now\. Proposed 2026-11-06 by session s1, changes 2 lines\.\nTask: The last forecast, offline\.\n/)
    for (const a of w.asked) expect(a.question).not.toMatch(/`|\*\*/)
  })

  test('no dialog names kirunak: its words are the item\'s and the mod\'s, never the plugin\'s name (AC-12)', async ($, on) => {
    const w = world(on, { taps: ['hub/proposed', SKIP, ID, 'Accept with open items', 'why', SKIP, `${ID} A-4`, 'Decline', 'why', SKIP] })
    for (const command of ['k-approve', 'k-accept', 'k-amendments']) await run($, command)
    expect(w.asked.length).toBe(10)
    // An id or a path may hold the word; the dialog's own words never do.
    for (const a of w.asked) expect([a.header, a.question, ...a.labels].join('\n').replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })

  test('no dialog or answer of /k-hold, /k-start or /k-queue names kirunak (AC-12)', async ($, on) => {
    const walk: [string, (string | null)[]][] = [
      ['k-hold', [ID, 'Hold', 'why', SKIP]],
      ['k-start', [ID, SKIP]],
      ['k-queue', ['hub/next', 'Move', 'More', 'More', 'End of the queue', SKIP]],
      ['k-queue', ['More', 'hub/parked', SKIP]],
      ['k-queue', [ID, 'Move', 'hub/sync-notes', SKIP]],
      ['k-queue', ['hub/next', 'Park hub/next']],
    ]
    const w = world(on, { rows: QUEUE, taps: walk.flatMap(([, taps]) => taps), verb: { exitCode: 0, stdout: ' 1  hub/sync-notes\n', stderr: '' } })
    const answers: string[] = []
    for (const [command] of walk) answers.push(await run($, command, '', { kind: 'bridge' }))
    expect([w.asked.length, w.runs.length]).toEqual([21, 1])
    for (const a of w.asked) expect([a.header, a.question, ...a.labels].join('\n').replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
    for (const a of answers) expect(a.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })

  test('k checks the item again as the verb runs, and its refusal is the answer; a number typed after the dialog still takes the list as shown (E-2, AC-3)', async ($, on) => {
    const w = world(on, { taps: ['hub/proposed', 'Approve hub/proposed'], verb: { exitCode: 1, stdout: '', stderr: 'k: hub/proposed was approved on 2026-11-07\n' } })
    expect(await run($, 'k-approve')).toBe('/k-approve refused:\nk: hub/proposed was approved on 2026-11-07')
    await run($, 'k-approve', '1')
    expect(verbs(w.runs)).toEqual([['approve', 'hub/proposed', '--via', 'mod'], ['approve', 'hub/proposed', '--via', 'mod']])
  })
})

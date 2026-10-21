import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ID, QUEUE, WAITING, world } from './world'

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
      { header: 'Approve', question: 'Waiting for you to approve:\n1. hub/proposed: Asks for approval. Can approve.\nWhich task?', labels: ['hub/proposed', 'Cancel'] },
      { header: 'Approve', question: 'hub/proposed: Asks for approval.\nk would approve it now.\nApprove it?', labels: ['Approve hub/proposed', 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['approve', 'hub/proposed', '--via', 'mod']])
  })

  test('a long list comes in pages of three and More, later pages under Back, numbered as the app numbers them; a task k would refuse offers no Approve (E-1, E-4, E-5)', async ($, on) => {
    const w = world(on, { waiting: [SEVEN], taps: ['More', 'More', 'Back', 'Back', 'hub/t2', 'Back', 'More', 'More', 'hub/t7', 'Approve hub/t7'] })
    await run($, 'k-approve')
    const [one, two, three] = [w.asked[0], w.asked[1], w.asked[2]]
    expect(one).toEqual({ header: 'Approve', question: 'Waiting for you to approve: (1 to 3 of 7)\n1. hub/t1: Task 1. Can approve.\n2. hub/t2: Task 2. Not yet: task.md fails k check: AC-1 has no source.\n3. hub/t3: Task 3. Can approve.\nWhich task?', labels: ['hub/t1', 'hub/t2', 'hub/t3', 'More'] })
    expect(two).toEqual({ header: 'Approve', question: 'Waiting for you to approve: (4 to 5 of 7)\n1. hub/t4: Task 4. Can approve.\n2. hub/t5: Task 5. Can approve.\nWhich task?', labels: ['hub/t4', 'hub/t5', 'Back', 'More'] })
    expect(three?.labels).toEqual(['hub/t6', 'hub/t7', 'Back'])
    // Back shows the dialog before again: page two, then page one.
    expect([w.asked[3], w.asked[4]]).toEqual([two, one])
    expect(w.asked[5]).toEqual({ header: 'Approve', question: 'hub/t2: Task 2.\nNot yet:\ntask.md fails k check: AC-1 has no source\nk would refuse it now. Back to the list?', labels: ['Back', 'Cancel'] })
    expect(w.asked[6]).toEqual(one)
    expect(verbs(w.runs)).toEqual([['approve', 'hub/t7', '--via', 'mod']])
  })

  test('a task id starting with a digit (the repo "2048") is listed, picked and approved through the dialog, and typed it is an id, not a number (finding 2)', async ($, on) => {
    const approve = [{ id: '2048/tiles', title: 'Tiles slide', why: null }, { id: 'hub/proposed', title: 'Asks for approval', why: null }]
    const w = world(on, { waiting: [{ ...WAITING, approve }], taps: ['2048/tiles', 'Approve 2048/tiles'] })
    await run($, 'k-approve')
    expect(w.asked).toEqual([
      { header: 'Approve', question: 'Waiting for you to approve:\n1. 2048/tiles: Tiles slide. Can approve.\n2. hub/proposed: Asks for approval. Can approve.\nWhich task?', labels: ['2048/tiles', 'hub/proposed'] },
      { header: 'Approve', question: '2048/tiles: Tiles slide.\nk would approve it now.\nApprove it?', labels: ['Approve 2048/tiles', 'Back'] },
    ])
    await run($, 'k-approve', '2048/tiles')
    expect(verbs(w.runs)).toEqual([['approve', '2048/tiles', '--via', 'mod'], ['approve', '2048/tiles', '--via', 'mod']])
  })

  test('/k-accept: "Accept <id>" for one k would accept; one stopped only by open checklist items takes a reason typed in the free-text row, shown above "Accept <id> with open items" (AC-9)', async ($, on) => {
    const w = world(on, { taps: ['weather/was-reviewed', 'Accept weather/was-reviewed', ID, 'Accept with open items', 'read on the phone', 'Back', ' read on the phone ', `Accept ${ID} with open items`] })
    await run($, 'k-accept')
    expect(w.asked[0]).toEqual({
      header: 'Accept',
      question: `Waiting for you to accept:\n1. weather/was-reviewed: Reviewed and met. Can accept.\n2. ${ID}: The last forecast stays readable offline. Not yet: checklist.md has 1 unticked item(s).\nWhich task?`,
      labels: ['weather/was-reviewed', ID],
    })
    expect(w.asked[1]?.labels).toEqual(['Accept weather/was-reviewed', 'Back'])
    await run($, 'k-accept')
    const text = `${ID}: The last forecast stays readable offline.\nReview: review.md, needs owner (E-1).\nNot yet:\nchecklist.md has 1 unticked item(s):\n- [ ] E-1 On the oldest phone. (review.md)`
    expect(w.asked[3]).toEqual({ header: 'Accept', question: `${text}\nOnly open checklist items stop it. Accept it with them open?`, labels: ['Accept with open items', 'Back'] })
    const reason = { header: 'Accept', question: `${text}\nType the reason in the free-text row: why accept it with these items open?`, labels: ['Back', 'Cancel'] }
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
        `1. ${ID} A-3, proposed 2026-11-06: The age line needs its words. Changes 2 lines.`,
        `2. ${ID} A-4, proposed 2026-11-06: E-1 is covered by AC-1. Changes 1 line. Not yet: with A-4 applied fails k check: line 9: aspect offline: in (E-1) names E-1, which the task does not have`,
        'Which amendment?',
      ].join('\n'),
      labels: [`${ID} A-3`, `${ID} A-4`],
    })
    expect(w.asked[1]).toEqual({
      header: 'Amendments',
      question: `${ID} A-3, proposed 2026-11-06: The age line needs its words. Changes 2 lines.\nTask: The last forecast stays readable offline.\nApprove it, or decline it?`,
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
      ['k-queue', ['hub/next', 'Move', 'More', 'End of the queue', SKIP]],
      ['k-queue', ['More', 'hub/parked', SKIP]],
      ['k-queue', [ID, 'Move', 'hub/sync-notes', SKIP]],
      ['k-queue', ['hub/next', 'Park hub/next']],
    ]
    const w = world(on, { rows: QUEUE, taps: walk.flatMap(([, taps]) => taps), verb: { exitCode: 0, stdout: ' 1  hub/sync-notes\n', stderr: '' } })
    const answers: string[] = []
    for (const [command] of walk) answers.push(await run($, command, '', { kind: 'bridge' }))
    expect([w.asked.length, w.runs.length]).toEqual([20, 1])
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

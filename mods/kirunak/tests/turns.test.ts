import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { AMENDMENTS, ID, READY, WAITING, world } from './world'

const run = async ($: Engine, command: string, args = '', origin: PromptOrigin = { kind: 'composer' }): Promise<string> =>
  (await $.command.run({ command, args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

// k's arguments after `node <k>`.
const verbs = (runs: string[][]) => runs.map(argv => argv.slice(2))

// The prompts the mod submitted as turns of the session's own, once the command answered and the clock's timer ran.
async function turns(w: ReturnType<typeof world>): Promise<string[]> {
  await w.clock.advance(10)
  expect(w.submitted.map(s => s.origin)).toEqual(w.submitted.map(() => ({ kind: 'plugin', name: 'kirunak' })))
  return w.submitted.map(s => s.text)
}

const REVIEWED = 'hub/stale-tiles: Review & merge runs as pid 4242; its log is /w/hub/kirunak/bugs/stale-tiles/review.log, and k bugs shows its result\n'
const REFUSED = { exitCode: 1, stdout: '', stderr: `k: ${ID}: the latest review is not met (AC-2)\n` }
const end = ($: Engine) => $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })

// The turn after a verb k took, and after one it refused (AC-13, AC-14).
const took = (did: string, where: string, said: string, next: string) => `The owner ${did} ${where}, and kirunak took it: ${said}\nSay so in one line, then ${next}`
const refused = (tried: string, where: string, said: string, verb: string, again: string) =>
  `The owner tried to ${tried} ${where}, and kirunak refused it:\n${said}\nSay in one line what failed and kirunak's reason, then work on what blocked it. Ask the owner for what only they can do, such as a check on a device. Never run \`k ${verb}\` yourself: the owner runs ${again} again once it can pass.`
const HANDOFF = 'go on with the k-done skill from its handoff, step 4 (load it with the Skill tool if it is not loaded).'
const APPROVED = 'go on with the work that waited for the approval.'

describe('the turn after an owner\'s verb (kirunak-bugs AC-11 to AC-14)', () => {
  test('Review & merge k took: once /k-bugs answered, a turn says the review started, waits for its process in one background command, then says its result (AC-11)', async ($, on) => {
    const w = world(on, { taps: ['hub/stale-tiles', 'Review & merge'], verb: { exitCode: 0, stdout: REVIEWED, stderr: '' } })
    await run($, 'k-bugs')
    expect(w.submitted).toEqual([])
    expect(await turns(w)).toEqual([[
      'The owner tapped Review & merge on the bug hub/stale-tiles in /k-bugs, and kirunak started it: a fresh Opus session reviews its fix as pid 4242, its log at /w/hub/kirunak/bugs/stale-tiles/review.log.',
      'Say in one line that the review of hub/stale-tiles started. Then run this one command with Bash in the background (run_in_background), and do not poll it or sleep: `while kill -0 4242 2>/dev/null; do sleep 20; done; tail -n 5 /w/hub/kirunak/bugs/stale-tiles/review.log`',
      'When it ends, read what it printed and `k bugs`, and tell the owner the result in plain words: the fix merged into master, not pushed, and the bug closed, with the merge\'s commit; or what the review found, with its review file; or the conflict, with its files. Never run `k bug review` yourself.',
    ].join('\n')])
    expect(w.toasts).toEqual([])
  })

  test('Quad Damage k took: a turn says the run started with its marked bugs, waits for its pid in one background command, then prints its summary and sends its push line, never as a k run stop (gulnya/quad-damage AC-13)', async ($, on) => {
    const said = 'Quad Damage runs as pid 5150\nlog: /h/bugs/quad-damage/2026-11-07-2340/run.log\nfolder: /h/a folder\nbugs marked: hub/stale-tiles\n'
    const w = world(on, { bugs: [[{ ...READY, quadDamage: true }]], taps: ['Quad Damage', 'Quad Damage'], verb: { exitCode: 0, stdout: said, stderr: '' } })
    await run($, 'k-bugs')
    expect(await turns(w)).toEqual([[
      'The owner tapped Quad Damage in /k-bugs, and kirunak started the run as pid 5150, its log at /h/bugs/quad-damage/2026-11-07-2340/run.log: it fixes and reviews the marked bug (hub/stale-tiles) one at a time, unattended, and pushes nothing.',
      'Say in one line that Quad Damage started, with 1 marked bug waiting. Then run this one command with Bash in the background (run_in_background), and do not poll it or sleep: `while kill -0 5150 2>/dev/null; do sleep 60; done; k bugs quad-damage --summary \'/h/a folder\'`',
      'When it ends, write to the owner the summary it printed, its lines as they are, one line a bug, without its `kirunak-push:` line. Then send the text after `kirunak-push:` with PushNotification, exactly as written. Never run `k bugs quad-damage` yourself without --status or --summary, nor `k bug review`.',
    ].join('\n')])
  })

  test('a Quad Damage whose answer names no pid still gets its turn, its summary left to k bugs quad-damage --summary', async ($, on) => {
    const w = world(on, { bugs: [[{ ...READY, quadDamage: true }]], taps: ['Quad Damage'], verb: { exitCode: 0, stdout: 'Quad Damage started\n', stderr: '' } })
    await run($, 'k-bugs')
    expect(await turns(w)).toEqual(['The owner tapped Quad Damage in /k-bugs, and kirunak started the run: Quad Damage started\nSay in one line that Quad Damage started, and that `k bugs quad-damage --status` shows where it is and `k bugs quad-damage --summary` its summary once it ends. Never run `k bugs quad-damage` yourself without --status or --summary, nor `k bug review`.'])
  })

  test('a Review & merge whose answer names no process still gets its turn, its result left to /k-bugs', async ($, on) => {
    const w = world(on, { taps: ['hub/stale-tiles', 'Review & merge'], verb: { exitCode: 0, stdout: 'hub/stale-tiles: Review & merge started\n', stderr: '' } })
    await run($, 'k-bugs')
    expect(await turns(w)).toEqual(['The owner tapped Review & merge on the bug hub/stale-tiles in /k-bugs, and kirunak started it: hub/stale-tiles: Review & merge started\nSay in one line that the review of hub/stale-tiles started, and that /k-bugs or `k bugs` shows its result once it ends. Never run `k bug review` yourself.'])
  })

  test('a Review & merge k refused gets no turn: the answer already says why', async ($, on) => {
    const w = world(on, { taps: ['hub/stale-tiles', 'Review & merge'], verb: { exitCode: 1, stdout: '', stderr: 'k: hub/stale-tiles: a Review & merge of it runs already, as pid 4242\n' } })
    await run($, 'k-bugs')
    expect(await turns(w)).toEqual([])
    expect(verbs(w.runs)).toEqual([['bug', 'review', 'hub/stale-tiles', '--detach', '--via', 'mod']])
  })

  test('/k-start k took, picked or typed: a turn starts work on the task from where its progress left off, as "Work on <id>" does (AC-12)', async ($, on) => {
    const w = world(on, { taps: [ID, `Start ${ID}`] })
    await run($, 'k-start')
    await run($, 'k-start', 'hub/sync-notes')
    expect(await turns(w)).toEqual([
      `The owner picked ${ID} in /k-start, and kirunak made it this session's task.\nStart work on it now, from the last line of its progress.md, as "Work on ${ID}" does.`,
      'The owner typed /k-start hub/sync-notes, and kirunak made it this session\'s task.\nStart work on it now, from the last line of its progress.md, as "Work on hub/sync-notes" does.',
    ])
    expect(verbs(w.runs)).toEqual([['start', ID, '--via', 'mod', '--session', 'sess-1'], ['start', 'hub/sync-notes', '--via', 'mod', '--session', 'sess-1']])
  })

  test('a /k-start k refused gets no turn (O-3: no task starts by itself)', async ($, on) => {
    const w = world(on, { verb: { exitCode: 1, stdout: '', stderr: `k: ${ID} is on hold since 2026-11-07\n` } })
    await run($, 'k-start', ID)
    expect(await turns(w)).toEqual([])
  })

  test('/k-accept, /k-approve and /k-resume k took on this session\'s task: a turn says what the owner did, then goes on, after an accept with the handoff (AC-13)', async ($, on) => {
    const w = world(on, { taps: ['hub/proposed', 'Approve hub/proposed'], task: 'hub/proposed', verb: { exitCode: 0, stdout: 'hub/proposed: queued, queue place 3 (sha 1a2b3c4d, commit 9f8e7d6)\n', stderr: '' } })
    await run($, 'k-approve')
    await run($, 'k-accept', 'hub/proposed')
    await run($, 'k-accept', 'hub/proposed --checklist-open "checked on the phone"')
    await run($, 'k-resume', 'hub/proposed')
    const said = 'hub/proposed: queued, queue place 3 (sha 1a2b3c4d, commit 9f8e7d6)'
    expect(await turns(w)).toEqual([
      took('approved hub/proposed', 'with a tap in /k-approve', said, APPROVED),
      took('accepted hub/proposed as done', 'by typing /k-accept', said, HANDOFF),
      took('accepted hub/proposed as done with its open checklist items', 'by typing /k-accept', said, HANDOFF),
      took('took hub/proposed off hold', 'by typing /k-resume', said, 'go on with the work on it, from the last line of its progress.md.'),
    ])
    expect(w.toasts).toEqual([])
  })

  test('/k-accept, /k-approve and /k-resume k refused on this session\'s task: a turn says what failed with kirunak\'s reason and works on what blocked it (AC-14)', async ($, on) => {
    const w = world(on, { verb: REFUSED })
    await run($, 'k-accept', ID)
    await run($, 'k-approve', ID)
    await run($, 'k-resume', ID)
    const said = `k: ${ID}: the latest review is not met (AC-2)`
    expect(await turns(w)).toEqual([
      refused(`accept ${ID} as done`, 'by typing /k-accept', said, 'accept', '/k-accept'),
      refused(`approve ${ID}`, 'by typing /k-approve', said, 'approve', '/k-approve'),
      refused(`take ${ID} off hold`, 'by typing /k-resume', said, 'resume', '/k-resume'),
    ])
  })

  test('a verb that never finished gets the failure turn, with what the mod knows of it (AC-14)', async ($, on) => {
    const w = world(on, { verbFails: 'timed out after 600000 ms' })
    await run($, 'k-accept', ID)
    const [turn] = await turns(w)
    expect(turn).toMatch(new RegExp(`^The owner tried to accept ${ID} as done by typing /k-accept, and kirunak refused it:\\nk did not finish \\([^\\n]*timed out after 600000 ms\\); \`k list --all\` says whether it took\\.\\nSay in one line what failed`))
  })

  test('another session\'s task, or none, gets no turn after a verb, taken or refused', async ($, on) => {
    const w = world(on, { task: 'weather/was-reviewed' })
    await run($, 'k-accept', ID)
    await run($, 'k-approve', ID)
    await run($, 'k-resume', 'hub/paused')
    expect(await turns(w)).toEqual([])
    expect(verbs(w.runs).map(v => v[0])).toEqual(['accept', 'approve', 'resume'])
  })

  test('a hold, a dry run and a queue verb get no turn, on this session\'s task too', async ($, on) => {
    const w = world(on)
    await run($, 'k-hold', `${ID} the owner is away`)
    await run($, 'k-accept', `${ID} --dry-run`)
    await run($, 'k-approve', `${ID} --dry-run`)
    await run($, 'k-start', `${ID} --dry-run`)
    expect(await turns(w)).toEqual([])
    expect(verbs(w.runs).map(v => v[0])).toEqual(['hold', 'accept', 'approve', 'start'])
  })

  test('a task whose intake this session ran (its own `k intake` or `k amend` call that did not fail) gets the turn; a call refused notes nothing, and session.end forgets it (AC-13)', async ($, on) => {
    const w = world(on, { task: null, verb: { exitCode: 0, stdout: 'hub/mine: queued, queue place 2\n', stderr: '' } })
    on('tool.call', { tool: 'Bash' }, ($, e) => (e.command.includes('--refuse') ? { deny: 'refused' } : { result: { stdout: '', stderr: '', interrupted: false } }))
    await run($, 'k-approve', 'hub/mine')
    await $.tool.call({ tool: 'Bash', command: 'k intake start hub/mine --refuse' })
    await run($, 'k-approve', 'hub/mine')
    expect(await turns(w)).toEqual([])
    await $.tool.call({ tool: 'Bash', command: 'cd /w/hub && k intake start hub/mine --from openspec/changes/mine' })
    await $.tool.call({ tool: 'Bash', command: 'node ~/sources/kirunak/bin/k.mjs amend new weather/amended --why "words"' })
    await $.tool.call({ tool: 'Bash', command: 'k list hub/listed; echo k intake start' })
    await run($, 'k-approve', 'hub/mine')
    await run($, 'k-approve', 'weather/amended --amendment A-2')
    await run($, 'k-approve', 'hub/listed')
    await end($)
    await run($, 'k-approve', 'hub/mine')
    expect(await turns(w)).toEqual([
      took('approved hub/mine', 'by typing /k-approve', 'hub/mine: queued, queue place 2', APPROVED),
      took('approved the amendment A-2 of weather/amended', 'by typing /k-approve', 'hub/mine: queued, queue place 2', 'go on with the work that waited for it, under the task as amended.'),
    ])
  })

  test('an amendment k waiting names as this session\'s (`by: session <id>`) gets the turn after /k-amendments approves it (AC-13)', async ($, on) => {
    const mine = { ...WAITING, amendments: AMENDMENTS.map(a => ({ ...a, by: 'session sess-1' })) }
    const w = world(on, { task: null, waiting: [mine], taps: [`${ID} A-3`, `Approve ${ID} A-3`] })
    await run($, 'k-amendments')
    expect(await turns(w)).toEqual([took(`approved the amendment A-3 of ${ID}`, 'with a tap in /k-amendments', `${ID}: done`, 'go on with the work that waited for it, under the task as amended.')])
    expect(verbs(w.runs)).toEqual([['approve', ID, '--amendment', 'A-3', '--via', 'mod']])
    await end($)
  })

  test('an amendment another session proposed, on a task not this session\'s, gets no turn after /k-amendments approves it', async ($, on) => {
    const w = world(on, { task: null, taps: [`${ID} A-3`, `Approve ${ID} A-3`] })
    await run($, 'k-amendments')
    expect(await turns(w)).toEqual([])
    expect(verbs(w.runs)).toEqual([['approve', ID, '--amendment', 'A-3', '--via', 'mod']])
  })
})

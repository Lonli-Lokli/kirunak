import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { BugRow, QuadDamageStatus } from '../hooks/bugs'

import { bug, BUGS, FOUND, NO_FIX, READY, world } from './world'

const run = async ($: Engine, args = '', origin: PromptOrigin = { kind: 'composer' }): Promise<string> =>
  (await $.command.run({ command: 'k-bugs', args, origin, presentation: { isFullscreen: false, columns: 120 } })).text ?? ''

const SKIP = '[No preference]'
// k's arguments after `node <k>`.
const verbs = (runs: string[][]) => runs.map(argv => argv.slice(2))

const LINES = [
  'hub/stale-tiles: Old tiles stay after an update, fix ready, bug of weather/offline-forecast, written 2026-11-07',
  'weather/rain-gap: Rain alerts skip a gap, fix not ready: review-1.md found things to fix, written 2026-11-02',
  'hub/no-fix: no-fix, no fix yet, no date written',
]
// The list asked in one line, each bug's words its choice's line, the date in words (gulnya/mobile-dialogs AC-14, AC-23).
const LIST = 'Bugs, a fix ready first, then the oldest: Which bug?'
const LABELS = ['hub/stale-tiles', 'weather/rain-gap', 'hub/no-fix']
const DESC: Record<string, string> = {
  'hub/stale-tiles': 'Old tiles stay after an update, fix ready, bug of weather/offline-forecast, written today',
  'weather/rain-gap': 'Rain alerts skip a gap, fix not ready: review-1.md found things to fix, written Nov 2',
  'hub/no-fix': 'no-fix, no fix yet, no date written',
}
// The answer's list when nothing ran.
const TEXT = `3 bugs, a fix ready first, then the oldest:\n\n${LINES.map((l, i) => `${i + 1}. **${l.replace(/^([^:]+):/, '$1**:')}`).join('\n')}\n\n/k-bugs shows one whole, to review and merge its fix, start a fix or drop it.`
// The bug with its fix ready, whole: its head, its file below the front matter, the marks left out, then what Review &
// merge does, in the dialog's own text.
const HEAD = 'hub/stale-tiles: Old tiles stay after an update.\nBug of weather/offline-forecast, written 2026-11-07.\nFix ready: bug/stale-tiles in hub, 2 commits ahead of master.'
const WHOLE = `${HEAD}\n\nWhat was found\n\n- The tile cache keeps no version. [file hub/src/Tiles.kt]\n\nFix written\n\n- The cache is keyed by version. [commit 3f2a9c1]\n\nQuestions\n\n1. Is the old cache cleared at once?\n   Proposed: yes, on the first start after an update.\n\nReview & merge: a fresh Opus session reviews bug/stale-tiles; only when it finds nothing is the fix merged into hub's master, never pushed, and the bug closed.\nReview and merge its fix, start a task to fix it, or drop it?`
const REVIEWED = 'hub/stale-tiles: Review & merge runs as pid 4242; its log is /w/hub/kirunak/bugs/stale-tiles/review.log, and k bugs shows its result\n'
// A review running since 11:50 on this machine's clock, whatever its zone.
const REVIEWING: BugRow = { ...READY, reviewing: { pid: 4242, started: '2026-11-07T11:50:00' } }

const many = (n: number): BugRow[] => Array.from({ length: n }, (_, i) => bug(`hub/b${i + 1}`, { title: `Bug ${i + 1}`, written: `2026-11-0${i + 1}` }))

describe('/k-bugs (kirunak-bugs AC-6, D-1)', () => {
  test('no bugs says so, with no dialog; anything typed after the command is refused; a k that fails says so', async ($, on) => {
    const w = world(on, { bugs: [[], null] })
    expect(await run($)).toBe('No bugs: no repo holds one.')
    expect(await run($, 'all')).toBe('/k-bugs takes nothing, not all.')
    expect(await run($)).toBe('/k-bugs refused:\nk: the workspace did not load')
    expect([w.asked, w.runs]).toEqual([[], []])
  })

  test('the bugs numbered in k bugs\' order, a fix ready first, each line saying its fix: ready, what a review found, or none; Skip runs nothing and answers with the list', async ($, on) => {
    const w = world(on, { taps: [SKIP] })
    expect(await run($)).toBe(`Nothing ran: skipped.\n\n${TEXT}`)
    expect(w.asked).toEqual([{ header: 'Bugs', question: LIST, labels: LABELS }])
    expect(w.lines[0]).toEqual(DESC)
    expect(await run($, '', { kind: 'bridge' })).toBe(`Nothing ran: dismissed.\n\n${TEXT}\n\n(typed in Remote Control)`)
    expect([w.bugReads, w.runs]).toEqual([2, []])
  })

  test('a bug in review says so, from when, on its line', async ($, on) => {
    const w = world(on, { bugs: [[REVIEWING]], taps: [SKIP] })
    expect(await run($)).toBe('Nothing ran: skipped.\n\n1 bug, a fix ready first, then the oldest:\n\n1. **hub/stale-tiles**: Old tiles stay after an update, in review since 2026-11-07 11:50, bug of weather/offline-forecast, written 2026-11-07\n\n/k-bugs shows one whole, to review and merge its fix, start a fix or drop it.')
    expect(w.runs).toEqual([])
  })

  test('more than fit come in pages of three and More, later pages under Back, numbered as the app numbers them', async ($, on) => {
    const w = world(on, { bugs: [many(5)], taps: ['More', 'Back', SKIP] })
    await run($)
    const [one, two] = [w.asked[0], w.asked[1]]
    expect(one).toEqual({ header: 'Bugs', question: 'Bugs, a fix ready first, then the oldest (1 to 3 of 5): Which bug?', labels: ['hub/b1', 'hub/b2', 'hub/b3', 'More'] })
    expect(two).toEqual({ header: 'Bugs', question: 'Bugs, a fix ready first, then the oldest (4 to 5 of 5): Which bug?', labels: ['hub/b4', 'hub/b5', 'Back'] })
    expect(w.lines.slice(0, 2)).toEqual([
      { 'hub/b1': 'Bug 1, no fix yet, written Nov 1', 'hub/b2': 'Bug 2, no fix yet, written Nov 2', 'hub/b3': 'Bug 3, no fix yet, written Nov 3', More: 'the next ones' },
      { 'hub/b4': 'Bug 4, no fix yet, written Nov 4', 'hub/b5': 'Bug 5, no fix yet, written Nov 5', Back: 'the dialog before' },
    ])
    expect(w.asked[2]).toEqual(one)
    expect(w.runs).toEqual([])
  })

  test('a bug picked shows whole from its file; Review & merge only while its fix is ready and no review runs, what it does in the text above; Back shows the list again; a file that cannot be read says so', async ($, on) => {
    const w = world(on, { bugs: [[...BUGS, { ...REVIEWING, id: 'hub/in-review', slug: 'in-review', path: '/w/hub/kirunak/bugs/in-review.md' }]], taps: ['hub/stale-tiles', 'Back', 'weather/rain-gap', 'Back', 'hub/in-review', 'Back', 'hub/no-fix', SKIP] })
    await run($)
    expect(w.asked[1]).toEqual({ header: 'Bugs', question: WHOLE, labels: ['Review & merge', 'Start fix', 'Drop', 'Back'] })
    expect(w.asked[2]).toEqual(w.asked[0])
    expect(w.asked[3]).toEqual({ header: 'Bugs', question: 'weather/rain-gap: Rain alerts skip a gap.\nWritten 2026-11-02.\nFix not ready: review-1.md found things to fix on bug/rain-gap in weather.\nThe review: /w/weather/kirunak/bugs/rain-gap/review-1.md\n\nWhat was found\n\n- An alert in the gap is lost. [file weather/src/Alerts.kt]\nStart a task to fix it, or drop it?', labels: ['Start fix', 'Drop', 'Back'] })
    expect(w.asked[5]).toEqual({ header: 'Bugs', question: 'hub/in-review: Old tiles stay after an update.\nBug of weather/offline-forecast, written 2026-11-07.\nIn Review & merge since 2026-11-07 11:50: bug/stale-tiles in hub.\nIts file could not be read: /w/hub/kirunak/bugs/in-review.md\nStart a task to fix it, or drop it?', labels: ['Start fix', 'Drop', 'Back'] })
    expect(w.asked[7]).toEqual({ header: 'Bugs', question: 'hub/no-fix: no-fix.\nNo date written.\nNo fix yet.\nIts file could not be read: /w/hub/kirunak/bugs/no-fix.md\nStart a task to fix it, or drop it?', labels: ['Start fix', 'Drop', 'Back'] })
    expect(w.runs).toEqual([])
  })

  test('Review & merge runs k bug review <id> --detach --via mod, the owner\'s verb, and answers that a fresh Opus session reviews it, merges only with no finding, never pushes, and where the result shows (D-1)', async ($, on) => {
    const w = world(on, { taps: ['hub/stale-tiles', 'Review & merge'], verb: { exitCode: 0, stdout: REVIEWED, stderr: '' } })
    expect(await run($)).toBe(`A fresh Opus session reviews the fix of hub/stale-tiles now. Only when it finds nothing is the fix merged into master, never pushed, and the bug closed; a finding or a conflict merges nothing and is written beside the bug.\n/k-bugs or \`k bugs\` shows the result.\n\n${REVIEWED.trim()}`)
    expect(verbs(w.runs)).toEqual([['bug', 'review', 'hub/stale-tiles', '--detach', '--via', 'mod']])
    expect(w.submitted).toEqual([])
  })

  test('a Review & merge k refuses (a review running, the fix no longer ready) answers in k\'s own words', async ($, on) => {
    const w = world(on, { taps: ['hub/stale-tiles', 'Review & merge'], verb: { exitCode: 1, stdout: '', stderr: 'k: hub/stale-tiles: a Review & merge of it runs already, as pid 4242\n' } })
    expect(await run($)).toBe('/k-bugs refused:\nk: hub/stale-tiles: a Review & merge of it runs already, as pid 4242')
    expect(verbs(w.runs)).toEqual([['bug', 'review', 'hub/stale-tiles', '--detach', '--via', 'mod']])
  })

  test('Start fix reads the bugs again and submits a prompt of its own that names the bug, the k-intake skill and k intake start; it runs no verb', async ($, on) => {
    const w = world(on, { taps: ['weather/rain-gap', 'Start fix'] })
    expect(await run($)).toBe('The intake from weather/rain-gap starts next in this session, with the k-intake skill.')
    // Submitted once the command answered: the engine refuses a submit from inside its hook.
    expect(w.submitted).toEqual([])
    await w.clock.advance(10)
    expect(w.toasts).toEqual([])
    expect(w.submitted).toEqual([{
      text: 'The owner tapped Start fix on the bug weather/rain-gap in /k-bugs. Start the intake from it now: first load the k-intake skill with the Skill tool (skill "k-intake"), then follow its "Starting from a bug (Start fix)": run `k intake start weather/rain-gap --from kirunak/bugs/rain-gap.md`, that moves the bug to kirunak/tasks/rain-gap/bug.md, read it there (it is at /w/weather/kirunak/bugs/rain-gap.md until then) and the notes.md it writes, then ask the owner first one question that holds every proposed answer in its own text, then each open question alone, as the skill says.',
      origin: { kind: 'plugin', name: 'kirunak' },
    }])
    expect([w.bugReads, w.runs]).toEqual([2, []])
  })

  test('Start fix on a bug gone since the list, one whose review started since, or with a k that fails runs nothing and says so by the id tapped, never another', async ($, on) => {
    const since = [FOUND, { ...NO_FIX, id: 'hub/stale-tiles-2', slug: 'stale-tiles-2' }]
    const w = world(on, { bugs: [BUGS, since, BUGS, null, BUGS, [REVIEWING]], taps: ['hub/stale-tiles', 'Start fix', 'hub/stale-tiles', 'Start fix', 'hub/stale-tiles', 'Start fix'] })
    expect(await run($)).toBe('Nothing ran: hub/stale-tiles is no longer a bug. It was dropped, merged, or its intake started, since the list was shown.')
    expect(await run($)).toBe('Nothing ran: k bugs did not answer, so hub/stale-tiles could not be found again: k: the workspace did not load')
    expect(await run($)).toBe('Nothing ran: hub/stale-tiles is in review since 2026-11-07 11:50; its fix can be started once that review ends.')
    await w.clock.advance(10)
    expect([w.submitted, w.runs]).toEqual([[], []])
  })

  const DROP = ['hub/stale-tiles', 'Drop', 'Fixed by hand', 'Drop hub/stale-tiles']

  test('Drop takes the reason typed in the free-text row, then "Drop <id>" under it runs k bug drop by id, saying the fix branch stays, and answers k\'s line', async ($, on) => {
    const said = 'hub/stale-tiles: dropped in 5b7e2d0; its fix branch bug/stale-tiles is kept in hub'
    const w = world(on, { taps: [...DROP], verb: { exitCode: 0, stdout: `${said}\n`, stderr: '' } })
    expect(await run($)).toBe(said)
    expect(w.asked.slice(2)).toEqual([
      { header: 'Bugs', question: `${HEAD}\nType the reason in the free-text row: why drop it?`, labels: ['Cancel', 'Back'] },
      { header: 'Bugs', question: `${HEAD}\nIts fix branch bug/stale-tiles stays in hub.\nReason: Fixed by hand\nDrop it, in a commit that carries that reason?`, labels: ['Drop hub/stale-tiles', 'Back'] },
    ])
    expect(verbs(w.runs)).toEqual([['bug', 'drop', 'hub/stale-tiles', '--why', 'Fixed by hand']])
  })

  test('Drop skipped, dismissed, cancelled, with an empty reason, or skipped under its reason: nothing runs and the answer says why', async ($, on) => {
    const cases: [(string | null)[], string][] = [
      [['hub/no-fix', 'Drop', SKIP], 'skipped'],
      [['hub/no-fix', 'Drop', null], 'dismissed'],
      [['hub/no-fix', 'Drop', 'Cancel'], 'cancelled'],
      [['hub/no-fix', 'Drop', '   '], 'no reason was typed'],
      [['hub/no-fix', 'Drop', 'Not a bug', SKIP], 'skipped'],
    ]
    const w = world(on, { taps: cases.flatMap(([taps]) => taps) })
    for (const [, why] of cases) expect(await run($)).toBe(`Nothing ran: ${why}.\n\n${TEXT}`)
    expect(w.asked[w.asked.length - 1]?.question).toBe('hub/no-fix: no-fix.\nNo date written.\nNo fix yet.\nReason: Not a bug\nDrop it, in a commit that carries that reason?')
    expect(w.runs).toEqual([])
  })

  test('from any origin but the owner\'s it is refused before k is read; no answer names kirunak, which the engine does', async ($, on) => {
    const w = world(on, { bugs: [BUGS, BUGS, BUGS, BUGS, BUGS, []], taps: ['hub/stale-tiles', 'Review & merge', 'weather/rain-gap', 'Start fix', SKIP, 'hub/no-fix', 'Drop', 'Not a bug', 'Drop hub/no-fix'], verb: { exitCode: 0, stdout: REVIEWED, stderr: '' } })
    expect(await run($, '', { kind: 'plugin', name: 'other' })).toBe('/k-bugs runs only from your own prompt or from Remote Control; this one came from the plugin other, so nothing ran.')
    expect([w.bugReads, w.asked]).toEqual([0, []])
    const answers = [await run($), await run($, '', { kind: 'bridge' }), await run($), await run($), await run($), await run($, 'x')]
    expect(answers[4]).toBe('No bugs: no repo holds one.')
    // A path or an id may hold the word; the mod's own words never do.
    for (const text of answers) expect(text.replace(/\S*kirunak\/\S*/g, '')).not.toMatch(/kirunak/i)
  })
})

// Quad Damage (gulnya/quad-damage S-5): two bugs marked `quad-damage: yes`, k's answer once it started the run, and the
// run's status while it lives, on the bug with its fix ready, fixing its first try since 23:41, or waiting for the
// 5-hour window until 01:15.
const MARKED: BugRow[] = [{ ...READY, quadDamage: true }, { ...FOUND, quadDamage: true }, NO_FIX]
const STARTED = 'Quad Damage runs as pid 5150\nlog: /h/bugs/quad-damage/2026-11-07-2340/run.log\nfolder: /h/bugs/quad-damage/2026-11-07-2340\nbugs marked: hub/stale-tiles, weather/rain-gap\n'
const FIXING = { phase: 'fixing' as const, try: 1, since: '2026-11-07T23:41:00+00:00', waitUntil: null }
const ON_READY: BugRow[] = [{ ...MARKED[0] as BugRow, reviewing: { pid: 5150, started: '2026-11-07T23:41:00+00:00' }, quadDamageRun: FIXING }, MARKED[1] as BugRow, NO_FIX]
const LIVE: QuadDamageStatus = { run: { pid: 5150, bug: 'hub/stale-tiles' }, line: 'Quad Damage runs: hub/stale-tiles, fixing (try 1) since 23:41' }
const QD_LINE = 'fixes and reviews the 2 marked bugs one at a time, unattended; nothing is pushed'

const STOP_LINE = 'ends the run now, the bug it is on left waiting'
const STOPPED = 'Quad Damage stopped: the owner stopped it; its summary: /h/bugs/quad-damage/2026-11-07-2340/summary.md\n'

describe('Quad Damage in /k-bugs (gulnya/quad-damage AC-1, AC-12, AC-17, E-3, E-4, D-1)', () => {
  test('while a marked bug waits and no run lives, Quad Damage is the list\'s first row; with none marked, or a k whose status fails with none marked, it is not', async ($, on) => {
    const w = world(on, { bugs: [MARKED, BUGS], quadDamage: [null], taps: [SKIP, SKIP] })
    await run($)
    expect(w.asked[0]).toEqual({ header: 'Bugs', question: 'Bugs, a fix ready first, then the oldest: Quad Damage, or which bug?', labels: ['Quad Damage', ...LABELS] })
    expect(w.lines[0]).toEqual({ 'Quad Damage': QD_LINE, ...DESC })
    await run($)
    expect(w.asked[1]).toEqual({ header: 'Bugs', question: LIST, labels: LABELS })
    expect([w.quadReads, w.runs]).toEqual([2, []])
  })

  test('its tap runs k bugs quad-damage --via mod, the owner\'s verb, and answers that the run started and how many marked bugs wait; then a turn waits for its progress lines and writes them, then prints and pushes its summary (AC-1, AC-13, AC-16)', async ($, on) => {
    const w = world(on, { bugs: [MARKED], taps: ['Quad Damage'], verb: { exitCode: 0, stdout: STARTED, stderr: '' } })
    expect(await run($)).toBe(`Quad Damage started with 2 marked bugs waiting: it fixes and reviews them one at a time, unattended, and merges a fix into master only when its review finds nothing; nothing is pushed.\n/k-bugs, \`k waiting\` and the board show the bug it is on; each step it takes is written here as a short line, and when it ends, its summary is written here and sent to your phone.\n\n${STARTED.trim()}`)
    expect(verbs(w.runs)).toEqual([['bugs', 'quad-damage', '--via', 'mod']])
    expect(w.submitted).toEqual([])
    await w.clock.advance(10)
    expect(w.submitted.map(x => x.origin)).toEqual([{ kind: 'plugin', name: 'kirunak' }])
    const turn = w.submitted[0]?.text ?? ''
    expect(turn).toContain('`k bugs quad-damage --progress /h/bugs/quad-damage/2026-11-07-2340 --after 0` with Bash in the background (run_in_background)')
    expect(turn).toContain('first run the command after its `kirunak-next:` line the same way, then write to the owner the lines')
    expect(turn).toContain('send the text after `kirunak-push:` with PushNotification, exactly as written, then write its summary lines')
    expect(turn.indexOf('--after 0` with Bash in the background')).toBeLessThan(turn.indexOf('say in one line that Quad Damage started'))
    expect(turn).not.toContain('kill -0')
    expect(turn).not.toContain('k run stopped for the owner')
  })

  test('a second Quad Damage while one runs is refused in k\'s own words, and gets no turn (E-3)', async ($, on) => {
    const why = 'k: Quad Damage runs already: pid 5150, started 2026-11-07 23:40, on hub/stale-tiles (fixing, try 1); a second one waits until it ends, and k bugs quad-damage --status shows it'
    const w = world(on, { bugs: [MARKED], quadDamage: [null], taps: ['Quad Damage'], verb: { exitCode: 1, stdout: '', stderr: `${why}\n` } })
    expect(await run($)).toBe(`/k-bugs refused:\n${why}`)
    await w.clock.advance(10)
    expect([verbs(w.runs), w.submitted]).toEqual([[['bugs', 'quad-damage', '--via', 'mod']], []])
  })

  test('while a run lives: its line above the list and Stop Quad Damage first, no Quad Damage row; the bug it is on says so, its phase or its wait, and offers no Review & merge, Start fix or Drop (AC-12, E-4)', async ($, on) => {
    const waiting: QuadDamageStatus = { ...LIVE, line: 'Quad Damage waits for the 5-hour window until 01:15' }
    const onWait: BugRow[] = [{ ...ON_READY[0] as BugRow, quadDamageRun: { phase: 'waiting', try: 1, since: null, waitUntil: '2026-11-08T01:15:00+00:00' } }, MARKED[1] as BugRow]
    const w = world(on, { bugs: [ON_READY, onWait], quadDamage: [LIVE, waiting], taps: ['hub/stale-tiles', 'Back', SKIP, SKIP] })
    expect(await run($)).toBe(`Nothing ran: skipped.\n\n${LIVE.line}.\n\n3 bugs, a fix ready first, then the oldest:\n\n1. **hub/stale-tiles**: Old tiles stay after an update, Quad Damage is on it (fixing, try 1), bug of weather/offline-forecast, written 2026-11-07\n2. **${LINES[1]?.replace(': ', '**: ')}\n3. **${LINES[2]?.replace(': ', '**: ')}\n\n/k-bugs shows one whole, to review and merge its fix, start a fix or drop it.`)
    // The run's line stays above the list's one line; each row's words are its choice's line.
    expect(w.asked[0]?.question).toBe(`${LIVE.line}.\nBugs, a fix ready first, then the oldest: Stop Quad Damage, or which bug?`)
    expect(w.lines[0]).toEqual({ 'Stop Quad Damage': STOP_LINE, 'hub/stale-tiles': 'Old tiles stay after an update, Quad Damage is on it (fixing, try 1), bug of weather/offline-forecast, written today', 'weather/rain-gap': DESC['weather/rain-gap'], 'hub/no-fix': DESC['hub/no-fix'] })
    expect(w.asked[0]?.labels).toEqual(['Stop Quad Damage', ...LABELS])
    expect(w.asked[1]?.labels).toEqual(['Cancel', 'Back'])
    expect(w.asked[1]?.question.split('\n')[2]).toBe('Quad Damage is on it: fixing, try 1, since 23:41, on bug/stale-tiles in hub.')
    expect(w.asked[1]?.question.split('\n').slice(-1)).toEqual(['Review & merge, Start fix and Drop wait until Quad Damage moves on. Back to the list?'])
    expect(w.asked[1]?.question).not.toContain('Review & merge: a fresh Opus session')
    await run($)
    expect(w.asked[3]?.question).toBe('Quad Damage waits for the 5-hour window until 01:15.\nBugs, a fix ready first, then the oldest: Stop Quad Damage, or which bug?')
    expect([w.lines[3]?.['Stop Quad Damage'], w.lines[3]?.['hub/stale-tiles']]).toEqual([STOP_LINE, 'Old tiles stay after an update, Quad Damage is on it (waiting for the 5-hour window until 01:15), bug of weather/offline-forecast, written today'])
    expect(w.runs).toEqual([])
  })

  test('Stop Quad Damage opens one confirm naming the bug it is on and what a stop does; Cancel runs nothing (AC-17)', async ($, on) => {
    const w = world(on, { bugs: [ON_READY], quadDamage: [LIVE], taps: ['Stop Quad Damage', 'Cancel'] })
    expect(await run($)).toMatch(/^Nothing ran: cancelled\./)
    expect(w.asked[1]).toEqual({
      header: 'Bugs',
      question: [`${LIVE.line}.`, '',
        'Stop Quad Damage ends the session it runs for hub/stale-tiles at once; a merge already under way is let finish. Then hub/stale-tiles waits with what its branch holds, and the bugs left are not reached.',
        'Nothing is pushed. Its summary follows in the chat that started the run, and goes to your phone.', 'Stop Quad Damage now?'].join('\n'),
      labels: ['Stop Quad Damage', 'Cancel', 'Back'],
    })
    await w.clock.advance(10)
    expect([w.runs, w.submitted]).toEqual([[], []])
  })

  test('its confirm names the 5-hour wait, a merge under way, or the run between bugs', async ($, on) => {
    const at = (run: NonNullable<QuadDamageStatus['run']>, line: string): QuadDamageStatus => ({ run, line })
    const w = world(on, {
      bugs: [ON_READY, ON_READY, ON_READY],
      quadDamage: [
        at({ pid: 5150, bug: 'hub/stale-tiles', phase: 'waiting', waitUntil: '2026-11-08T01:15:00+00:00' }, 'Quad Damage waits for the 5-hour window until 01:15'),
        at({ pid: 5150, bug: 'hub/stale-tiles', phase: 'merging' }, 'Quad Damage runs: hub/stale-tiles, merging since 23:58'),
        at({ pid: 5150, bug: null }, 'Quad Damage runs, between bugs, since 23:40'),
      ],
      taps: ['Stop Quad Damage', SKIP, 'Stop Quad Damage', SKIP, 'Stop Quad Damage', SKIP],
    })
    await run($)
    await run($)
    await run($)
    const said = (n: number) => w.asked[n]?.question.split('\n').slice(0, 3)
    expect(said(1)).toEqual(['Quad Damage waits for the 5-hour window until 01:15.', '', 'Stop Quad Damage ends its wait for the 5-hour window at once; hub/stale-tiles waits, and the bugs left are not reached.'])
    expect(said(3)).toEqual(['Quad Damage runs: hub/stale-tiles, merging since 23:58.', '', 'The merge of hub/stale-tiles is under way and is let finish; then the run ends, and the bugs left are not reached.'])
    expect(said(5)).toEqual(['Quad Damage runs, between bugs, since 23:40.', '', 'Stop Quad Damage ends the run before it takes another bug; the bugs left are not reached.'])
    expect(w.runs).toEqual([])
  })

  test('its confirm runs k bugs quad-damage --stop --via mod, the owner\'s verb, and answers that the run stops and where its summary follows; no turn after it (AC-17)', async ($, on) => {
    const w = world(on, { bugs: [ON_READY], quadDamage: [LIVE], taps: ['Stop Quad Damage', 'Stop Quad Damage'], verb: { exitCode: 0, stdout: STOPPED, stderr: '' } })
    expect(await run($)).toBe(`Quad Damage stops: the session it was in is ended, a merge already under way is let finish, the bug it was on waits and the bugs left are not reached. Its summary follows in the chat that started the run, and goes to your phone.\n\n${STOPPED.trim()}`)
    expect(verbs(w.runs)).toEqual([['bugs', 'quad-damage', '--stop', '--via', 'mod']])
    await w.clock.advance(10)
    expect(w.submitted).toEqual([])
  })

  test('Start fix on a bug the run took since the list was shown runs nothing and says the run is on it (E-4)', async ($, on) => {
    const w = world(on, { bugs: [MARKED, ON_READY], taps: ['hub/stale-tiles', 'Start fix'] })
    expect(await run($)).toBe('Nothing ran: Quad Damage is on hub/stale-tiles (fixing, try 1); its fix can be started once the run moves on.')
    await w.clock.advance(10)
    expect([w.submitted, w.runs]).toEqual([[], []])
  })
})

import type { EngineInterface } from 'claude-code'

import { firstLine, reason } from './commands'
import { appendDialogLog } from './log'

// The turns of its own the mod gives the session after an owner's verb (gulnya/kirunak-bugs AC-11 to AC-14): a prompt
// it submits once the command has answered, as Start intake's and Start fix's are, that says what the owner did and
// what to do now. The verb itself runs only on the owner's gesture (owner.ts); a turn runs no verb, and tells the
// session never to run one.
// - Review & merge k took (AC-11): say the review started, wait for its process in the background, then say its result.
// - Quad Damage k took (gulnya/quad-damage AC-1, AC-13, AC-16): say the run started, wait in the background for each
//   line of its progress and write it, then print its summary, one line a bug, and send its push line to the owner's
//   phone.
// - /k-start k took (AC-12), picked or typed: start work on the task, from where its progress left off.
// - /k-approve's Approve and start on a task from a bug (asilak/kirunak-worktrees-lsof-windows AC-14, E-3), whoever's
//   task it was: both took, say so and go on with the task's plan from its first step, as the /k-start turn does; the
//   approval took and k start refused, say it is approved, not started, with k's reason. A refused approval ran no
//   k start, and gets the refusal's turn below (AC-15).
// - /k-approve (a task or an amendment), /k-accept and /k-resume on this session's task or one whose intake it ran
//   (AC-13, AC-14): what the owner did and the work that waited, or what failed, with kirunak's reason, and the work
//   that blocked it. Another session's task, a decline, a hold, a queue verb and a dry run get none.
// A `claude -p` run or a k run step's session never runs an owner's verb (their origin is refused), so they get none.

// The engine refuses a submit from inside a command.run hook (it would wait on the turn the hook holds: measured under
// `claude plugin test`), so a timer of the clock's submits it once the hook has answered; the prompt then waits for the
// session to be idle. One the engine refuses, or a prompt.submit hook drops (the submit answers `{ drop: <why> }`, measured
// under `claude plugin test`), toasts why, after `failed`, and, for an owner's command (`command`), leaves a row in
// dialogs.jsonl too: the toast shows only in the terminal, never on the phone (gulnya/approval-turn-missing AC-3).
const SUBMIT_AFTER_MS = 1
export function submitLater($: EngineInterface, text: string, failed: string, command?: string): void {
  $.clock.after(SUBMIT_AFTER_MS, () => {
    void submitOrSay($, text, failed, command)
  })
}
async function submitOrSay($: EngineInterface, text: string, failed: string, command: string | undefined): Promise<void> {
  let why: string
  try {
    const drop = ((await $.prompt.submit({ text })) as { drop?: unknown } | null | undefined)?.drop
    if (drop === undefined) return
    why = `dropped: ${String(drop)}`
  } catch (err) {
    why = reason(err)
  }
  await $.ui.toast(`${failed}: ${why}`)
  if (command !== undefined) await logNoTurn($, command, why)
}

// A turn due that did not start, as a row of the dialog log in a dialog's shape (no choices, no tap, `end` "no turn"),
// so the owner, and kirunak-docs-promo's reader, see why (gulnya/approval-turn-missing AC-3).
async function logNoTurn($: EngineInterface, command: string, why: string): Promise<void> {
  await appendDialogLog($, (session, now) => ({ t: now, session, command, header: 'No turn', text: [why], question: `The turn after /${command} did not start`, choices: [], tap: null, tAnswer: now, end: 'no turn' }))
}

// The tasks whose intake this session ran, or an amendment of: its own Bash calls of `k intake <verb> <id>` and `k amend
// new|check <id>` that did not fail, and the amendments k waiting names as this session's (`by: session <id>`). kirunak
// records no intake's session, so the mod keeps them in its own memory: a reload, a resume in a new process and
// session.end forget them, and then only the session's own task (k status) gets a turn.
const ran = new Set<string>()
const RAN = /(?:^|[\s;&|(])(?:k|\S*\/k\.mjs)\s+(?:intake\s+(?:start|aspects|question|answer|check)|amend\s+(?:new|check))\s+([A-Za-z0-9][A-Za-z0-9._-]*\/[a-z0-9-]{1,40})(?![\w./-])/g
export function noteRan(command: string): void {
  for (const m of command.matchAll(RAN)) ran.add(m[1] as string)
}
export function noteAuthors(rows: readonly { id: string; by: string | null }[], session: string): void {
  for (const x of rows) if (session && x.by === `session ${session}`) ran.add(x.id)
}
export const forgetRan = (): void => ran.clear()

// The verb a turn ran: the command's name, the checkout's k, k's arguments, whether the dialog's last tap chose it,
// whether k took it, and what k said (its state line, or its reason); `then`, the verb run after it once k took it
// (Approve and start's k start), whether k took that and what k said.
export type Told = { name: string; k: string; argv: readonly string[]; tapped: boolean; ok: boolean; said: string; then?: { argv: readonly string[]; ok: boolean; said: string } }

// The turn after the verb, if it gets one. A turn due that cannot start (k status failed, the session's id unread) is
// never swallowed: told answers why, for the command's answer, and leaves a row in dialogs.jsonl; null when the turn
// was submitted or none is due (gulnya/approval-turn-missing AC-3).
export async function told($: EngineInterface, t: Told): Promise<string | null> {
  try {
    const text = await turnText($, t)
    if (text !== null) submitLater($, text, `The turn after /${t.name} did not start`, t.name)
    return null
  } catch (err) {
    const why = reason(err)
    await logNoTurn($, t.name, why)
    return why
  }
}

// What a verb k took did, ahead of k's state line in the command's answer, so the owner on the phone knows it took
// without the turn (gulnya/approval-turn-missing AC-2); null for a verb without one, and a dry run.
export function doneLine(argv: readonly string[]): string | null {
  const [verb, id = ''] = argv
  if (argv.includes('--dry-run') || (verb !== 'approve' && verb !== 'accept' && verb !== 'resume')) return null
  const { did } = deedOf(verb, id, argv)
  return `${did.charAt(0).toUpperCase()}${did.slice(1)}.`
}

async function turnText($: EngineInterface, { name, k, argv, tapped, ok, said, then }: Told): Promise<string | null> {
  if (argv.includes('--dry-run')) return null
  const [verb, id = ''] = argv
  if (verb === 'approve' && ok && then !== undefined) return approveStartPrompt(id, name, said, then)
  if (verb === 'bug') return argv[1] === 'review' && ok ? reviewPrompt(argv[2] ?? '', said) : null
  // Stop Quad Damage hands the model nothing: the run's own session writes its summary (AC-17).
  if (verb === 'bugs') return argv[1] === 'quad-damage' && !argv.includes('--stop') && ok ? quadDamagePrompt(said) : null
  if (verb === 'start') return ok ? startPrompt(id, tapped) : null
  if (verb !== 'approve' && verb !== 'accept' && verb !== 'resume') return null
  if (!(await mine($, k, id))) return null
  const deed = deedOf(verb, id, argv)
  const where = tapped ? `with a tap in /${name}` : `by typing /${name}`
  if (ok) return `The owner ${deed.did} ${where}, and kirunak took it: ${said}\nSay so in one line, then ${deed.next}`
  return [
    `The owner tried to ${deed.tried} ${where}, and kirunak refused it:`,
    said,
    `Say in one line what failed and kirunak's reason, then work on what blocked it. Ask the owner for what only they can do, such as a check on a device. Never run \`k ${verb}\` yourself: the owner runs ${deed.again} again once it can pass.`,
  ].join('\n')
}

// This session's task (k start's record, as k status reads it), or one whose intake it ran (above).
async function mine($: EngineInterface, k: string, id: string): Promise<boolean> {
  if (ran.has(id)) return true
  const r = await $.process.run(['node', k, 'status', '--json', '--session', await $.session.id()])
  // A k status that failed cannot tell: told says so, never a silent "not mine" (gulnya/approval-turn-missing AC-3).
  if (r.exitCode !== 0) throw new Error(`k status failed: ${firstLine(r)}`)
  return (JSON.parse(r.stdout) as { session?: { task?: string | null } | null }).session?.task === id
}

function deedOf(verb: 'approve' | 'accept' | 'resume', id: string, argv: readonly string[]): { did: string; tried: string; again: string; next: string } {
  const at = argv.indexOf('--amendment')
  const amendment = at < 0 ? null : (argv[at + 1] ?? null)
  if (verb === 'approve' && amendment !== null) {
    return { did: `approved the amendment ${amendment} of ${id}`, tried: `approve the amendment ${amendment} of ${id}`, again: '/k-amendments', next: 'go on with the work that waited for it, under the task as amended.' }
  }
  if (verb === 'approve') return { did: `approved ${id}`, tried: `approve ${id}`, again: '/k-approve', next: 'go on with the work that waited for the approval.' }
  if (verb === 'accept') {
    const open = argv.includes('--checklist-open') ? ' with its open checklist items' : ''
    return { did: `accepted ${id} as done${open}`, tried: `accept ${id} as done`, again: '/k-accept', next: 'go on with the k-done skill from its handoff, step 4 (load it with the Skill tool if it is not loaded).' }
  }
  return { did: `took ${id} off hold`, tried: `take ${id} off hold`, again: '/k-resume', next: 'go on with the work on it, from the last line of its progress.md.' }
}

// /k-start k took: this session's task now, its work started at once, as "Work on <id>" starts it.
const startPrompt = (id: string, tapped: boolean): string =>
  [
    `${tapped ? `The owner picked ${id} in /k-start` : `The owner typed /k-start ${id}`}, and kirunak made it this session's task.`,
    `Start work on it now, from the last line of its progress.md, as "Work on ${id}" does.`,
  ].join('\n')

// Approve and start in /k-approve (asilak/kirunak-worktrees-lsof-windows AC-14, E-3): k took the approval, then k
// start took the task as this session's, or refused it, the task left approved and queued, nothing undone.
function approveStartPrompt(id: string, name: string, said: string, then: { ok: boolean; said: string }): string {
  const head = `The owner tapped Approve and start on ${id} in /${name}`
  if (then.ok) {
    return [
      `${head}, and kirunak took both: it approved ${id} and made it this session's task.`,
      said,
      then.said,
      `Say so in one line, then start work on it now with its plan, from its first step, as "Work on ${id}" does.`,
    ].join('\n')
  }
  return [
    `${head}: kirunak approved ${id}, not started: ${then.said}`,
    `The task stays approved and queued, and nothing was undone. Say in one line that ${id} is approved, not started, and kirunak's reason. Never run \`k start\` yourself: the owner starts it with /k-start.`,
  ].join('\n')
}

// A word the shell takes as it is, or one quoted.
const sh = (s: string): string => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

// Review & merge k took: k's answer names the process and its log (`<id>: Review & merge runs as pid <n>; its log is
// <path>, and k bugs shows its result`). The session waits for the process in one background command, never polling,
// and says the result its log and k bugs give; an answer without them leaves the result to /k-bugs.
const RUNS = /runs as pid (\d+); its log is (.+?), and k bugs shows/
function reviewPrompt(id: string, said: string): string {
  const head = `The owner tapped Review & merge on the bug ${id} in /k-bugs, and kirunak started it`
  const never = 'Never run `k bug review` yourself.'
  const m = RUNS.exec(said)
  if (m === null) return `${head}: ${said}\nSay in one line that the review of ${id} started, and that /k-bugs or \`k bugs\` shows its result once it ends. ${never}`
  const [, pid, log] = m as unknown as [string, string, string]
  return [
    `${head}: a fresh Opus session reviews its fix as pid ${pid}, its log at ${log}.`,
    `Say in one line that the review of ${id} started. Then run this one command with Bash in the background (run_in_background), and do not poll it or sleep: \`while kill -0 ${pid} 2>/dev/null; do sleep 20; done; tail -n 5 ${sh(log)}\``,
    `When it ends, read what it printed and \`k bugs\`, and tell the owner the result in plain words: the fix merged into master, not pushed, and the bug closed, with the merge's commit; or what the review found, with its review file; or the conflict, with its files. ${never}`,
  ].join('\n')
}

// Quad Damage k took: k's answer names the run's pid, its log, its folder and the bugs marked (`Quad Damage runs as pid
// <n>`, `log: <path>`, `folder: <path>`, `bugs marked: <ids>`). The session waits in one background command at a time,
// never polling, `k bugs quad-damage --progress <folder> --after <n>`, which ends at the run's next progress lines
// (AC-16): it starts the wait their `kirunak-next:` line names, then writes them as they are. The lines come last, so
// no turn ends on a tool call, which the engine answers by asking for visible output and the session by writing a line
// again (gulnya/quad-damage S-11). The last wait prints the summary instead, one line a bug, and a `kirunak-push:` line
// whose text, the summary cut to a push and starting "Quad Damage", the session sends with PushNotification as it is
// before it writes the summary (AC-13). An answer without the folder leaves the run to the owner's own read.
const QUAD = /Quad Damage runs as pid (\d+)/
function quadDamagePrompt(said: string): string {
  const head = 'The owner tapped Quad Damage in /k-bugs, and kirunak started the run'
  const never = 'Never run `k bugs quad-damage` yourself without --status, --summary or --progress, nor `k bug review`.'
  const pid = QUAD.exec(said)?.[1]
  const line = (name: string): string | undefined => new RegExp(`^${name}: (.+)$`, 'm').exec(said)?.[1]?.trim()
  const [log, folder, marked] = [line('log'), line('folder'), line('bugs marked')]
  if (folder === undefined) {
    return `${head}: ${said}\nSay in one line that Quad Damage started, and that \`k bugs quad-damage --status\` shows where it is and \`k bugs quad-damage --summary\` its summary once it ends. ${never}`
  }
  const bugs = marked ? marked.split(', ').filter(Boolean) : []
  return [
    `${head}${pid === undefined ? '' : ` as pid ${pid}`}${log ? `, its log at ${log}` : ''}: it fixes and reviews the ${bugs.length === 1 ? 'marked bug' : 'marked bugs'}${bugs.length ? ` (${bugs.join(', ')})` : ''} one at a time, unattended, and pushes nothing.`,
    `Run \`k bugs quad-damage --progress ${sh(folder)} --after 0\` with Bash in the background (run_in_background), and do not poll it or sleep. Then say in one line that Quad Damage started${bugs.length ? `, with ${bugs.length} marked ${bugs.length === 1 ? 'bug' : 'bugs'} waiting` : ', and how many marked bugs wait'}, and nothing else: that line ends your turn.`,
    'Each time it ends, first run the command after its `kirunak-next:` line the same way, then write to the owner the lines it printed exactly as they are, adding nothing, without its `kirunak-next:` line: those lines end your turn, with nothing before or after them. When it prints no `kirunak-next:` line, the run has ended: send the text after `kirunak-push:` with PushNotification, exactly as written, then write its summary lines as they are, without its `kirunak-push:` line, and nothing after them. ' + never,
  ].join('\n')
}

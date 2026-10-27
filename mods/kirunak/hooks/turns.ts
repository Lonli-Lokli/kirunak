import type { EngineInterface } from 'claude-code'

import { reason } from './commands'

// The turns of its own the mod gives the session after an owner's verb (gulnya/kirunak-bugs AC-11 to AC-14): a prompt
// it submits once the command has answered, as Start intake's and Start fix's are, that says what the owner did and
// what to do now. The verb itself runs only on the owner's gesture (owner.ts); a turn runs no verb, and tells the
// session never to run one.
// - Review & merge k took (AC-11): say the review started, wait for its process in the background, then say its result.
// - /k-start k took (AC-12), picked or typed: start work on the task, from where its progress left off.
// - /k-approve (a task or an amendment), /k-accept and /k-resume on this session's task or one whose intake it ran
//   (AC-13, AC-14): what the owner did and the work that waited, or what failed, with kirunak's reason, and the work
//   that blocked it. Another session's task, a decline, a hold, a queue verb and a dry run get none.
// A `claude -p` run or a k run step's session never runs an owner's verb (their origin is refused), so they get none.

// The engine refuses a submit from inside a command.run hook (it would wait on the turn the hook holds: measured under
// `claude plugin test`), so a timer of the clock's submits it once the hook has answered; the prompt then waits for the
// session to be idle. One the engine refuses toasts why, after `failed`.
const SUBMIT_AFTER_MS = 1
export function submitLater($: EngineInterface, text: string, failed: string): void {
  $.clock.after(SUBMIT_AFTER_MS, () => {
    void $.prompt.submit({ text }).catch(err => $.ui.toast(`${failed}: ${reason(err)}`))
  })
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
// whether k took it, and what k said (its state line, or its reason).
export type Told = { name: string; k: string; argv: readonly string[]; tapped: boolean; ok: boolean; said: string }

// The turn after the verb, if it gets one; it never changes the command's answer.
export async function told($: EngineInterface, t: Told): Promise<void> {
  try {
    const text = await turnText($, t)
    if (text !== null) submitLater($, text, `The turn after /${t.name} did not start`)
  } catch {
    // No turn: the answer the owner reads already says what k did.
  }
}

async function turnText($: EngineInterface, { name, k, argv, tapped, ok, said }: Told): Promise<string | null> {
  if (argv.includes('--dry-run')) return null
  const [verb, id = ''] = argv
  if (verb === 'bug') return argv[1] === 'review' && ok ? reviewPrompt(argv[2] ?? '', said) : null
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
  return r.exitCode === 0 && (JSON.parse(r.stdout) as { session?: { task?: string | null } | null }).session?.task === id
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

import type { EngineInterface } from 'claude-code'

// The dialog log's file (kirunak-docs-promo S-1 §3): <state>/dialogs.jsonl, where the state folder is $KIRUNAK_HOME
// else ~/.kirunak, as k finds it. One JSON line appended a row; a log that cannot be written is left unwritten, and
// never changes an answer.
export async function appendDialogLog($: EngineInterface, row: (session: string, now: number) => Record<string, unknown>): Promise<void> {
  try {
    const [state, home, session, now] = await Promise.all([$.env.get('KIRUNAK_HOME'), $.env.get('HOME'), $.session.id(), $.clock.now()])
    const dir = state || (home ? `${home}/.kirunak` : null)
    if (!dir) return
    const path = `${dir}/dialogs.jsonl`
    const before = await $.fs.read(path).then(t => String(t), () => '')
    await $.fs.write(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${JSON.stringify(row(session, now))}\n`)
  } catch {
    // An unwritable state folder: the row goes unrecorded.
  }
}

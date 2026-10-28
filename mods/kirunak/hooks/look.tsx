import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On } from 'claude-code'

import type { KirunakChip, KirunakDialog, KirunakSection } from '../types'
import { BACK, NEXT } from './drafts'
import { DIALOG_ROWS, foldLines, FREE, iconOf, messageParts, parts, rowsOf, STATES, stateOf, treeRows } from './looks'
import type { FoldLine, ProgressRow } from './looks'

// The mod's look on the phone and the desktop app (gulnya/mobile-dialogs D-1, D-2): its dialogs drawn as a head, a
// chip and their first lines, the rest behind Show all, and Quad Damage's progress lines drawn as rows. The terminal
// and VS Code draw as they did, each choice's line under it alone (AC-14, AC-18).
//
// The call hook writes every choice's line into the mod's own AskUserQuestion call, so the engine, every surface and
// the phone (which draws no tree, S-2) get them as the tool's own descriptions (AC-14, AC-17); it changes nothing else,
// and leaves a call the model raised, or one of another mod, as it came.
//
// The dialog hook draws and never answers (owner.ts's head): it draws only a dialog `talk()` wrote to kirunak.dialog
// with a look and asked with the same question, so a dialog the model raised, or one of another mod, draws as the
// engine draws it. Its buttons write kirunak.fold alone, which part of the look is open; they neither answer the
// dialog nor run a verb, and the dialog's choices stay the engine's own, below the look (the engine's node, last).

// The dialog open now, as talk() wrote it (owner.ts), and the part of its look unfolded; both declared where read.
const dialogState = atom({ plugin: 'kirunak', key: 'dialog' } as const, null)
const foldState = atom({ plugin: 'kirunak', key: 'fold' } as const, null)
// A draft's first question, its parts as Start intake wrote them (owner.ts's showIntake), which the model asks in a
// turn of its own (gulnya/mobile-dialogs AC-15, E-3).
const intakeState = atom({ plugin: 'kirunak', key: 'intake' } as const, null)

// The mod's dialog a question is: the one talk() has open, else a part of a draft's first question, asked exactly as
// written; `part` for the latter. Any other question is none of the mod's.
async function dialogOf($: EngineInterface, question: string): Promise<{ dialog: KirunakDialog; part: boolean } | null> {
  const open: KirunakDialog | null = await read($, dialogState)
  if (open !== null && open.question === question) return { dialog: open, part: false }
  const parts: KirunakDialog[] | null = await read($, intakeState)
  const found = parts?.find(p => p.question === question)
  return found === undefined ? null : { dialog: found, part: true }
}

// A Quad Damage line as a row (AC-11 to AC-13), in a message and in /k-bugs' head (AC-12) alike: its time dim, its
// stage's chip (the icon, its alt the stage, and the word), its bug's id in bold, its words as written. A line with no
// time or no id draws without it, left out of the children so the row's gap counts only what is drawn (AC-19).
type RowParts = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg'>
function progressRow({ Box, Text, Svg }: RowParts, r: ProgressRow, key: string) {
  const { fill, ink } = STATES[stateOf(r.chip.stage)]
  const drawn = [
    r.time === null ? null : <Text key="time" dimColor>{r.time}</Text>,
    <Box key="chip" flexDirection="row" alignItems="center" gap={1} backgroundColor={fill} paddingX={1}>
      <Svg source={iconOf(r.chip.stage)} alt={r.chip.stage} width={18} height={18} />
      <Text color={ink}>{r.chip.word}</Text>
    </Box>,
    r.id === null ? null : <Text key="id" weight="bold">{`${r.id}:`}</Text>,
    <Text key="words">{r.words}</Text>,
  ].filter(x => x !== null)
  return (
    <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
      {drawn}
    </Box>
  )
}

// A question as the tool's schema has it; the call hook gives every option its line.
type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

export function looks(on: On): void {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const [q, ...others] = e.questions as Question[]
    const found = q === undefined ? null : await dialogOf($, q.question)
    if (q === undefined || found === null) return next(e)
    const { dialog, part } = found
    const options = q.options.map(o => ({ ...o, description: dialog.described[o.label] ?? o.description ?? '' }))
    // A part of a draft's first question stays while the owner moves between its parts with Next and Back; any other
    // answer, a refusal or a dismissal, takes the whole question away, so a question asked later in the same words is
    // the engine's to draw (E-3).
    let answer: unknown = null
    try {
      const out = await next({ ...e, questions: [{ ...q, options }, ...others] } as typeof e)
      answer = (out.result as { answers?: Record<string, unknown> } | undefined)?.answers?.[q.question] ?? null
      return out
    } finally {
      if (part && answer !== NEXT && answer !== BACK) {
        await update($, intakeState, () => null).catch(() => {
          // The question stays drawn until another dialog of the mod's opens.
        })
      }
    }
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const [q, ...others] = e.props.questions as Question[]
    const dialog = q === undefined ? null : ((await dialogOf($, q.question))?.dialog ?? null)
    // The terminal and VS Code draw the whole question as the engine does, the lines under the choices the call hook
    // wrote (AC-14, AC-18); a dialog with no look draws so everywhere.
    if (q === undefined || dialog === null || dialog.look === null) return next(e)
    if (e.surface === 'terminal' || e.surface === 'vscode') return next(e)
    // The phone and the desktop app ask its last line, the look above it showing the rest (AC-1), the choices and
    // their lines as they came.
    const engine = await next({ ...e, props: { ...e.props, questions: [{ ...q, question: dialog.ask }, ...others] } })
    const fold = await read($, foldState)
    const open = fold !== null && fold.dialog === dialog.id ? fold.part : null
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const look = dialog.look

    const foldTo = (part: number | null) => () => {
      update($, foldState, () => (part === null ? null : { dialog: dialog.id, part })).catch(() => {
        // The look stays as it is.
      })
    }
    const chip = (c: KirunakChip, key: string) => {
      const { fill, ink } = STATES[stateOf(c.stage)]
      return (
        <Box key={key} flexDirection="row" alignItems="center" gap={1} backgroundColor={fill} paddingX={1}>
          <Svg source={iconOf(c.stage)} alt={c.stage} width={18} height={18} />
          <Text color={ink}>{c.word}</Text>
        </Box>
      )
    }
    const line = (l: FoldLine, key: string) =>
      l.heading ? (
        <Text key={key} weight="semibold">
          {l.text}
        </Text>
      ) : (
        <Text key={key}>{l.text || ' '}</Text>
      )
    const sections = (s: readonly KirunakSection[], key: string) => foldLines(s).map((l, i) => line(l, `${key}-${i}`))

    const run = look.run ? progressRow({ Box, Text, Svg }, look.run, 'run') : null
    const headRows = rowsOf(look.title) + (look.chip ? rowsOf(look.chip.stage) + rowsOf(look.chip.word) : 0) + (look.line ? rowsOf(look.line) : 0) + treeRows(run)
    const shown = look.fold !== null && open !== null ? parts(foldLines(look.fold), DIALOG_ROWS - headRows - FREE) : null
    const at = shown === null ? 0 : Math.min(open ?? 0, shown.length - 1)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text size="title" weight="semibold">
            {look.title}
          </Text>
          {look.chip ? chip(look.chip, 'chip') : null}
          {look.line ? <Text dimColor>{look.line}</Text> : null}
          {run}
        </Box>
        {shown === null ? (
          <Box flexDirection="column">
            {sections(look.first, 'first')}
            {look.rows.map(r => (
              <Box key={`row-${r.id}`} flexDirection="row" flexWrap="wrap" gap={1}>
                {chip(r.chip, `chip-${r.id}`)}
                <Text weight="bold">{r.id}</Text>
                <Text>{r.words}</Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Box flexDirection="column">
            {shown.length > 1 ? <Text dimColor>{`${at + 1} of ${shown.length}`}</Text> : null}
            {(shown[at] ?? []).map((l, i) => line(l, `part-${i}`))}
          </Box>
        )}
        {look.fold !== null && shown === null ? <Button key="kirunak-show-all" label="Show all" variant="primary" onPress={foldTo(0)} /> : null}
        {shown !== null ? (
          <Box flexDirection="row" gap={1}>
            {at === 0 ? (
              <Button key="kirunak-show-less" label="Show less" variant="secondary" onPress={foldTo(null)} />
            ) : (
              <Button key="kirunak-fold-back" label="Back" variant="secondary" onPress={foldTo(at - 1)} />
            )}
            {at < shown.length - 1 ? <Button key="kirunak-fold-next" label="Next" variant="secondary" onPress={foldTo(at + 1)} /> : null}
          </Box>
        ) : null}
        {engine}
      </Box>
    )
  })

  // Quad Damage's lines as rows (AC-11, AC-13, D-3): a reply that holds a progress line or the run's summary draws
  // each as a row and the text between them as it was, in order; a reply of none, the engine's own summary
  // (`isSummary`), and the terminal's and VS Code's drawing stay the engine's (O-2).
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || e.surface === 'terminal' || e.surface === 'vscode') return next(e)
    const found = messageParts(e.props.text)
    if (found === null) return next(e)
    const { Box, Text, Markdown, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {found.map((p, i) => ('row' in p ? progressRow({ Box, Text, Svg }, p.row, `row-${i}`) : <Markdown key={`text-${i}`} text={p.text} />))}
      </Box>
    )
  })
}

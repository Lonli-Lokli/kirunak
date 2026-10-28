import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { KirunakChip, KirunakDialog, KirunakSection } from '../types'
import { DIALOG_ROWS, foldLines, iconOf, messageParts, parts, rowsOf, STATES, stateOf } from './looks'
import type { FoldLine, ProgressRow } from './looks'

// The mod's look on the phone and the desktop app (gulnya/mobile-dialogs D-1, D-2): its dialogs drawn as a head, a
// chip and their first lines, the rest behind Show all, and Quad Damage's progress lines drawn as rows. The terminal
// and VS Code draw as they did, each choice's line under it alone (AC-14, AC-18).
//
// The dialog hook draws and never answers (owner.ts's head): it draws only a dialog `talk()` wrote to kirunak.dialog
// and asked with the same question, so a dialog the model raised, or one of another mod, draws as the engine draws it.
// Its buttons write kirunak.fold alone, which part of the look is open; they neither answer the dialog nor run a verb,
// and the dialog's choices stay the engine's own, below the look (the engine's node, last).

// The dialog open now, as talk() wrote it (owner.ts), and the part of its look unfolded; both declared where read.
const dialogState = atom({ plugin: 'kirunak', key: 'dialog' } as const, null)
const foldState = atom({ plugin: 'kirunak', key: 'fold' } as const, null)

// The rows the unfolded look keeps free besides its head and its part (AC-19, counted as looks.ts's treeRows counts
// them): the "n of m" line, Back or Show less and Next with their gap, the head chip's gap, the gap above each of the
// look's four parts (the head, the part, the buttons, the engine's node), and one to spare.
const FREE = 1 + 2 + 2 + 2 + 4 + 1

// A question as the tool's schema has it; the hook reads it and gives every option its line.
type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

export function looks(on: On): void {
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const [q, ...others] = e.props.questions as Question[]
    const dialog: KirunakDialog | null = await read($, dialogState)
    if (q === undefined || dialog === null || q.question !== dialog.question) return next(e)
    const options = q.options.map(o => ({ ...o, description: dialog.look.described[o.label] ?? o.description ?? '' }))
    // The terminal and VS Code keep the whole question; the phone and the desktop app ask its last line, the look
    // above it showing the rest (AC-1, AC-18).
    if (e.surface === 'terminal' || e.surface === 'vscode') return next({ ...e, props: { ...e.props, questions: [{ ...q, options }, ...others] } })
    const engine = await next({ ...e, props: { ...e.props, questions: [{ ...q, question: dialog.ask, options }, ...others] } })
    const fold = await read($, foldState)
    const open = fold !== null && fold.dialog === dialog.id ? fold.part : null
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const { look } = dialog

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

    const headRows = rowsOf(look.title) + (look.chip ? rowsOf(look.chip.stage) + rowsOf(look.chip.word) : 0) + (look.line ? rowsOf(look.line) : 0)
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

  // Quad Damage's progress lines as rows (AC-11, D-3): a reply that holds one draws each as a row and the text
  // between them as it was; a reply of none, a summary, and the terminal's and VS Code's drawing stay the engine's.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || e.surface === 'terminal' || e.surface === 'vscode') return next(e)
    const found = messageParts(e.props.text)
    if (found === null) return next(e)
    const { Box, Text, Markdown, Svg } = $.ui.resolve(e)
    const row = (r: ProgressRow, key: string) => {
      const { fill, ink } = STATES[stateOf(r.chip.stage)]
      return (
        <Box key={key} flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
          <Text dimColor>{r.time}</Text>
          <Box flexDirection="row" alignItems="center" gap={1} backgroundColor={fill} paddingX={1}>
            <Svg source={iconOf(r.chip.stage)} alt={r.chip.stage} width={18} height={18} />
            <Text color={ink}>{r.chip.word}</Text>
          </Box>
          <Text weight="bold">{`${r.id}:`}</Text>
          <Text>{r.words}</Text>
        </Box>
      )
    }

    return <Box flexDirection="column">{found.map((p, i) => ('row' in p ? row(p.row, `row-${i}`) : <Markdown key={`text-${i}`} text={p.text} />))}</Box>
  })
}

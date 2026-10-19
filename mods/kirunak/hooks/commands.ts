import type { PromptOrigin } from 'claude-code'

// The owner's own gestures (approval.md §5, the owner's answer of 2026-10-19): Enter at the terminal, and Remote
// Control from the phone. Every other origin is refused with a line and runs nothing.
const OWNERS: ReadonlySet<string> = new Set(['composer', 'bridge'])

export type Verb = 'approve' | 'accept' | 'hold' | 'start'

export const isOwners = (origin: PromptOrigin): boolean => OWNERS.has(origin.kind)

export function refusal(command: string, origin: PromptOrigin): string {
  const from = origin.kind === 'plugin' ? `the plugin ${origin.name}` : origin.kind
  return `/${command} runs only from your own prompt or from Remote Control; this one came from ${from}, so nothing ran.`
}

// The flags each command hands on to k, true for one that takes a value; any other is refused. `--via` is never one
// of them: the mod sets it, and k collects a repeated flag into a list.
const FLAGS: Record<Verb, Record<string, boolean>> = {
  approve: { amendment: true, first: false, before: true, after: true, 'no-queue': false, 'dry-run': false },
  accept: { 'checklist-open': true, 'dry-run': false },
  hold: { why: true, 'dry-run': false },
  start: { 'dry-run': false },
}

export const HINTS: Record<Verb, string> = {
  approve: '[<id> | <n>] [--amendment A-n] [--first | --before <id> | --after <id>] [--no-queue]',
  accept: '[<id> | <n>] [--checklist-open "<why>"]',
  hold: '<id> <why>',
  start: '<id>',
}

// lib/workspace.mjs's task id: <repo>/<slug>.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[a-z0-9-]{1,40}$/

// The words of a command line as a shell splits them: spaces apart, "double" or 'single' quotes keeping spaces. Null
// when a quote is left open.
export function words(text: string): string[] | null {
  const out: string[] = []
  let word: string | null = null
  let quote: string | null = null
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      word ??= ''
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word)
      word = null
    } else {
      word = (word ?? '') + c
    }
  }
  if (quote) return null
  if (word !== null) out.push(word)
  return out
}

// `k <verb> <id> [flags] --via mod` from what follows the command's name, or the problem that stops it.
export function argvFor(verb: Verb, text: string): { argv: string[] } | { problem: string } {
  const all = words(text)
  if (all === null) return { problem: 'a quote is left open' }
  const [id, ...rest] = all
  if (id === undefined || !ID.test(id)) return { problem: id === undefined ? 'which task? give its id, <repo>/<slug>' : `not a task id: ${id}` }
  const flags: string[] = []
  const loose: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] as string
    if (!w.startsWith('--')) {
      loose.push(w)
      continue
    }
    const eq = w.indexOf('=')
    const name = eq > 0 ? w.slice(2, eq) : w.slice(2)
    // Own names only, so `--constructor` or `--toString` is no flag of the table (review G21).
    const takes = Object.hasOwn(FLAGS[verb], name) ? FLAGS[verb][name] : undefined
    if (takes === undefined) return { problem: name === 'via' ? '--via is the mod\'s own' : `/k-${verb} takes no --${name}` }
    if (!takes) {
      if (eq > 0) return { problem: `--${name} takes no value` }
      flags.push(`--${name}`)
      continue
    }
    const value = eq > 0 ? w.slice(eq + 1) : rest[++i]
    if (value === undefined || value === '') return { problem: `--${name} needs a value` }
    flags.push(`--${name}`, value)
  }
  // A hold's reason may be the rest of the line, unquoted.
  if (verb === 'hold' && !flags.includes('--why')) {
    if (!loose.length) return { problem: 'why? /k-hold <id> <why>' }
    flags.push('--why', loose.join(' '))
  } else if (loose.length) {
    return { problem: `unexpected ${loose.join(' ')}` }
  }
  return { argv: [verb, id, ...flags, '--via', 'mod'] }
}

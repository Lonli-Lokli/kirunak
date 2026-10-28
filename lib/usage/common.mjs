// What the usage review's parts share: the weight every part counts in, and the lines a part prints.
import { existsSync, readFileSync } from 'node:fs';
import { format } from 'node:util';

// Relative weights: Opus base input = 1. Fable 2.5x Opus, Sonnet 0.6x, Haiku 0.2x (the usage review's own table, which
// k cost's prices seam refines for the handover's replay alone).
export const mult = (m) => (/fable/.test(m) ? 2.5 : /sonnet/.test(m) ? 0.6 : /haiku/.test(m) ? 0.2 : 1);
export const weight = (c) => mult(c.model) * (c.inp + 1.25 * c.cw5 + 2 * c.cw1h + 0.1 * c.cr + 5 * c.out);
export const contextOf = (c) => c.inp + c.cw5 + c.cw1h + c.cr;

// A part's printed lines, formatted as console.log formats them: log(...) adds one, text() is them all, each ending
// with a newline (what the script's stdout held).
export function printer() {
  const out = [];
  return { log: (...a) => out.push(`${format(...a)}\n`), text: () => out.join('') };
}

// A kirunak log of JSON lines ($KIRUNAK_HOME/events.jsonl, escalate.log, compact.log): its rows, a line that is not
// JSON left out, [] when it is missing or cannot be read.
export function jsonLines(file) {
  let text;
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

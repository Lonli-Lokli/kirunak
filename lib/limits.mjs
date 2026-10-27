import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { oneLine } from './drafts.mjs';
import { expandHome } from './home.mjs';

// The limits log (gulnya/quad-damage AC-9, AC-10): a reading of the plan's windows (the runner's `limits()`) appended
// to the log a status line keeps, when the workspace names it as `bugs.limitsLog` (relative to the workspace module,
// or ~/...). One line a reading, tab-separated as the status line writes it: the time in UTC to the second, the week's
// use and the 5-hour window's, each a whole percent cut at the point, and the session's label ('-' when none).

// The line for a reading, without its newline.
export function limitsLine(reading, { label = '', now = new Date() } = {}) {
  const time = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [time, Math.trunc(reading.week.used), Math.trunc(reading.fiveHour.used), oneLine(label) || '-'].join('\t');
}

// Appends the reading to the workspace's log → the line written, or null: no log named, a reading that is an error
// (`{ error }`), or a write that failed, which the status line's own writes swallow too.
export function logLimits(ws, reading, { label = '', now = new Date() } = {}) {
  const log = ws?.bugs?.limitsLog;
  if (typeof log !== 'string' || !log.trim() || !reading || reading.error) return null;
  const path = resolve(dirname(ws.modulePath), expandHome(log.trim()));
  const line = limitsLine(reading, { label, now });
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  } catch {
    return null;
  }
  return line;
}

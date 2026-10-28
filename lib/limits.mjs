import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expandHome } from './home.mjs';

// The limits log (gulnya/quad-damage AC-9, AC-10; gulnya/k-usage AC-4, D-5): one line a reading of the plan's windows,
// tab-separated: the time in UTC to the second, the week's use and the 5-hour window's, each a whole percent cut at the
// point, and the session's label ('-' when none). Quad Damage appends a reading of the runner's `limits()`; kirunak's
// status line tracker (hooks/statusline-track.mjs) appends the status line's when the pair changes; `k usage` reads
// it. It imports nothing but node: modules and lib/home.mjs, since the tracker runs on every status line refresh.

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// The line for a reading, without its newline.
export function limitsLine(reading, { label = '', now = new Date() } = {}) {
  const time = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [time, Math.trunc(reading.week.used), Math.trunc(reading.fiveHour.used), oneLine(label) || '-'].join('\t');
}

// The workspace's log: the loaded workspace's `usage.limitsLog` (lib/workspace.mjs: usage.limitsLog, else
// bugs.limitsLog, its older name, else $KIRUNAK_HOME/rate-limits.log); for a workspace object with no `usage` block,
// `bugs.limitsLog` resolved against its module's folder, or ~/...; null when neither names one.
export function limitsLogOf(ws) {
  const own = ws?.usage?.limitsLog;
  if (typeof own === 'string' && own.trim()) return own;
  const log = ws?.bugs?.limitsLog;
  if (typeof log !== 'string' || !log.trim() || typeof ws?.modulePath !== 'string') return null;
  return resolve(dirname(ws.modulePath), expandHome(log.trim()));
}

function append(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
    return line;
  } catch {
    return null;
  }
}

// Appends the reading to the workspace's log → the line written, or null: no log named, a reading that is an error
// (`{ error }`), or a write that failed, which the status line's own writes swallow too.
export function logLimits(ws, reading, { label = '', now = new Date() } = {}) {
  const path = limitsLogOf(ws);
  if (!path || !reading || reading.error) return null;
  return append(path, limitsLine(reading, { label, now }));
}

// The log's last line, read from its tail, or '' (no log, an empty one, or one that cannot be read).
export function lastLine(path, tailBytes = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, tailBytes));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return lines.at(-1) ?? '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Appends the reading to the log at `path` only when its (week, 5-hour) pair differs from the last line's, as the
// status line's own edit did: one line a change, whichever session saw it first → the line written, or null (no
// change, or a write that failed).
export function logChange(path, reading, { label = '', now = new Date() } = {}) {
  const line = limitsLine(reading, { label, now });
  const pair = (l) => l.split('\t').slice(1, 3).join('\t');
  if (pair(lastLine(path)) === pair(line)) return null;
  return append(path, line);
}

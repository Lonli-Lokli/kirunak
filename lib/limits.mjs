import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expandHome } from './home.mjs';

// The limits log (gulnya/quad-damage AC-9, AC-10; gulnya/k-usage AC-4, D-5): one line a reading of the plan's windows,
// tab-separated: the time in UTC to the second, the week's use and the 5-hour window's, each a whole percent cut at the
// point, the session's label ('-' when none), then when the week and the 5-hour window reset, in UTC to the second
// ('-' when not known; a line from before gulnya/limits-log-flaps has neither column). Quad Damage appends a reading of
// the runner's `limits()`; kirunak's status line tracker (hooks/statusline-track.mjs) appends the status line's when it
// moves the log on; `k usage` reads it. It imports nothing but node: modules and lib/home.mjs, since the tracker runs
// on every status line refresh.

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isoSecond = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const reset = (s) => (Number.isFinite(s) ? isoSecond(new Date(s * 1000)) : '-');

// The line for a reading, without its newline; a window's `resetsAt` is in epoch seconds.
export function limitsLine(reading, { label = '', now = new Date() } = {}) {
  const { week, fiveHour } = reading;
  return [isoSecond(now), Math.trunc(week.used), Math.trunc(fiveHour.used), oneLine(label) || '-',
    reset(week.resetsAt), reset(fiveHour.resetsAt)].join('\t');
}

// A log line as a reading, { week, fiveHour } each { used, resetsAt } with resetsAt null when not known, or null for a
// line that is not one.
export function readLine(line) {
  const [, week, fiveHour, , weekReset, fiveReset] = line.split('\t');
  const at = (r) => (r && r !== '-' && Number.isFinite(Date.parse(r)) ? Date.parse(r) / 1000 : null);
  if (!Number.isFinite(Number(week)) || !Number.isFinite(Number(fiveHour))) return null;
  return {
    week: { used: Number(week), resetsAt: at(weekReset) },
    fiveHour: { used: Number(fiveHour), resetsAt: at(fiveReset) },
  };
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

// One window of a reading against the log's last line → what the log holds next (gulnya/limits-log-flaps): sessions
// hold readings of different ages, so an idle one's must not take the log back. A later window, its reset over an hour
// after the logged one's (a new 5-hour window resets five hours after the last at the least), is taken as it is; an
// earlier window, or the same one behind or level, keeps the log's. With either reset not known, a fall by more than
// half is a new window. A window with no figure (-1) never overwrites one that had.
function ahead(was, now) {
  if (!was) return now;
  if (now.used < 0) return was;
  if (was.used < 0) return now;
  if (was.resetsAt !== null && now.resetsAt !== null) {
    if (now.resetsAt > was.resetsAt + 3600) return now;
    if (now.resetsAt < was.resetsAt - 3600) return was;
  } else if (now.used < was.used / 2) return now;
  return now.used > was.used ? { used: now.used, resetsAt: was.resetsAt ?? now.resetsAt } : was;
}

// Appends the reading to the log at `path` only when it moves the log on: each window's whole percent rises, or its
// window is a new one; the line holds the log's figure for a window the reading is behind in → the line written, or
// null (nothing moved on, or a write that failed).
export function logChange(path, reading, { label = '', now = new Date() } = {}) {
  const whole = (w) => ({ used: Math.trunc(w.used), resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null });
  const was = readLine(lastLine(path));
  const next = { week: ahead(was?.week, whole(reading.week)), fiveHour: ahead(was?.fiveHour, whole(reading.fiveHour)) };
  if (was && next.week === was.week && next.fiveHour === was.fiveHour) return null;
  return append(path, limitsLine(next, { label, now }));
}

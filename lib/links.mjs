import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// links.jsonl, the append-only log of the sessions' tasks (gulnya/usage-improve-11-22 AC-1, E-1): k start appends
// { session, task, since } (lib/handoff.mjs), a /clear's carry the same for the new id (hooks/compact-clear.mjs), and
// the release { session, task, until } before it deletes the live file (plugins/handoff-notes.mjs). The live file
// sessions/<id>.json goes at the release; the log stays, so k usage still joins the calls made before it.

export const linksPath = (home) => join(home, 'sessions', 'links.jsonl');

export function appendLink(home, record) {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  appendFileSync(linksPath(home), JSON.stringify(record) + '\n');
}

const time = (x) => (typeof x === 'string' ? Date.parse(x) : NaN);

// → { links: [{ session, task, since, until }], skipped }: since and until in ms (NaN when the line has none), in the
// file's order. A line that is not a JSON object, lacks a session or a task, or has neither time is skipped and
// counted (E-1); a blank line is neither. No file: no links.
export function readLinks(home) {
  let text;
  try {
    text = readFileSync(linksPath(home), 'utf8');
  } catch {
    return { links: [], skipped: 0 };
  }
  const links = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      x = null;
    }
    const ok = x && typeof x === 'object' && !Array.isArray(x) && typeof x.session === 'string' && x.session &&
      typeof x.task === 'string' && x.task;
    const since = ok ? time(x.since) : NaN, until = ok ? time(x.until) : NaN;
    if (!ok || (!Number.isFinite(since) && !Number.isFinite(until))) {
      skipped++;
      continue;
    }
    links.push({ session: x.session, task: x.task, since, until });
  }
  return { links, skipped };
}

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kirunakHome } from '../lib/home.mjs';

// The core's default `handoff` (review.md §4, plugins.md §2): the handoff goes to the task's handoff.md,
// and release lets go of the session's own kirunak state. Writes nothing outside $KIRUNAK_HOME.

export const WHAT =
  'The handoff for whoever picks this task up next, in a fresh session: the state now (what works, what was ' +
  'verified and how), what is still open, the next step, the owner\'s decisions with their dates, and where things ' +
  'are (files, branches, logs, devices). Nothing git already records: no list of commits or diffs.';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// A guard queue line belongs to the session when it is JSON naming it, or starts with its id.
const ownLine = (line, session) => {
  try {
    const j = JSON.parse(line);
    if (j && typeof j === 'object') return j.session === session;
  } catch {}
  return line.trim().split(/\s+/)[0] === session;
};

export default function handoffNotes(ws) {
  const home = () => ws?.home || kirunakHome();
  return {
    name: 'handoff-notes',
    version: '1',
    provides: {
      handoff: {
        targets({ task }) {
          return [{ where: join(task.dir, 'handoff.md'), what: WHAT }];
        },
        release({ session }) {
          const out = [];
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session || '')) return [{ resource: 'kirunak', line: 'nothing held' }];
          const sessionFile = join(home(), 'sessions', `${session}.json`);
          if (existsSync(sessionFile)) {
            unlinkSync(sessionFile);
            out.push({ resource: 'session', line: `cleared session ${session}` });
          }
          const claimsFile = join(home(), 'guard', 'claims.json');
          const claims = existsSync(claimsFile) ? readJson(claimsFile) : null;
          if (Array.isArray(claims)) {
            const mine = claims.filter((c) => c?.by === session);
            if (mine.length) {
              writeFileSync(claimsFile, JSON.stringify(claims.filter((c) => c?.by !== session), null, 2) + '\n');
              for (const c of mine) out.push({ resource: c.resource, line: `released claim ${c.resource}` });
            }
          }
          const queueFile = join(home(), 'guard', 'queue');
          if (existsSync(queueFile)) {
            const lines = readFileSync(queueFile, 'utf8').split('\n').filter((l) => l.trim());
            const mine = lines.filter((l) => ownLine(l, session));
            if (mine.length) {
              const rest = lines.filter((l) => !ownLine(l, session));
              writeFileSync(queueFile, rest.length ? rest.join('\n') + '\n' : '');
              for (const l of mine) out.push({ resource: 'guard queue', line: `left the guard queue: ${l.trim()}` });
            }
          }
          return out.length ? out : [{ resource: 'kirunak', line: 'nothing held' }];
        },
      },
    },
  };
}

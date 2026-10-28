// The handover's replay (gulnya/fresh-session-per-step S-2, AC-10), part 1: the constants, the window's main-session
// calls, and the steps each session started, from every repo's progress.md (readTasks).
import { RE } from '../tasks.mjs';

// The model's facts (fresh-session-per-step evidence/S-1-facts.md §3): threshold = window − min(max output, 20,000) − 13,000.
export const OFFSET = 20000 + 13000;
export const MID_WINDOW = 500000; // D-2: the owner's autoCompactWindow since 2026-10-18
export const T_MID = MID_WINDOW - OFFSET; // 467,000: where today's sessions compact, and the mid-step limit's threshold
export const CANDIDATES = Array.from({ length: 9 }, (_, i) => 100000 + 25000 * i);
export const IDLE = 200000; // idle compaction's own size (S-1 facts §3): a real one below the limit is replayed where the context still reaches it
export const HOOK_CHARS = 30000; // what the SessionStart hook puts back: task.md, plan.md, progress.md, up to about 30,000 characters
export const FALLBACK_CPT = 3.5; // characters per token, only if the transcripts give too few samples

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const k = (x) => `${Math.round(x / 1000)}k`;

// `rows` are calls.jsonl's rows, `tasks` readTasks's. The main sessions' calls in the window (subagents and synthetic
// calls left out), each session's steps (copies: the replay times them to the second), and the step lines without a date.
export function readWindow(rows, tasks, FROM, TO) {
  rows = rows.filter((r) => !r.sub && r.ts >= FROM && r.ts < TO && r.model !== '<synthetic>');
  let undated = 0;
  const intervals = [];
  for (const t of tasks.values()) {
    for (const l of t.lines) if (!RE.test(l) && /\bS-\d+[a-z]? (started|finished|failed)\b/.test(l)) undated++;
    for (const iv of t.steps) intervals.push({ named: iv.named, task: t.id, step: iv.step, start: iv.start, end: iv.end, endMinute: iv.endMinute });
  }
  // A step line's id is a full session id, a short one, or a name ending in one (katyafm-settings-fc223c79).
  const sessionIds = [...new Set(rows.map((r) => r.session))];
  const resolveId = (n) => {
    if (sessionIds.includes(n)) return n;
    const hex = (n.match(/[0-9a-f]{8}/g) || []).pop();
    const hits = hex ? sessionIds.filter((s) => s.startsWith(hex)) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  const bySession = new Map();
  for (const iv of intervals) {
    const id = iv.named && resolveId(iv.named);
    if (!id) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(iv);
  }
  return { rows, bySession, undated };
}

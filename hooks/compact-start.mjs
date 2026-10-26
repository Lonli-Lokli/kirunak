import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearFire, sessionFile, taskOf, within } from './compact-clear.mjs';
import {
  boundarySeen, CAP, cut, EXPECT_S, expectPath, isId, labelOf, lastOf, logLine, PARTS, PARTS_S, planFor, PRUNE_DAYS,
  readJson, stateText, taskDir, updateRecord, waitingLines,
} from './compact-rules.mjs';

// The task put back (design/orchestrator.md §5, R5.1-R5.5): SessionStart after `compact` and after `clear`, one entry
// per part (`--part state|task|plan|progress`), each at most CAP characters after its label; after `clear` only when
// hooks/compact-clear.mjs joins the new id to the old one's task. hooks/kirunak-compact.mjs loads this module for
// SessionStart alone, so the PreCompact hook pays nothing for it. A k run step never reaches it (R4.1, E-6).
//
// The four entries of one SessionStart run in parallel, so one of them, `state`, decides and writes: it consumes
// `expect` or cleared.json and records what it decided in compact/<session>.json (`fire`, `joined`); the other three
// read the same records and take that decision when they come after it.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const K_MS = 8_000;


// R5.2, R5.4: the main session's compaction (an automatic or manual one the PreCompact hook let through, `expect`
// recent; else the main transcript's own boundary, once: the state part records its time as `fire.boundaryAt`, and
// the same boundary seen again is an agent's compaction within EXPECT_S of the main's) or an agent's, which gets
// nothing. The state part decides and writes under the record's lock (R6.6).
function compactFire(home, input, part, now) {
  const path = expectPath(home, input.session_id);
  const decision = (rec) => {
    const expect = within(rec.expect?.at, EXPECT_S, now) ? rec.expect : null;
    const fire = part !== 'state' && rec.fire?.source === 'compact' && within(rec.fire.at, PARTS_S, now) ? rec.fire : null;
    const boundary = part === 'state' || (!expect && !fire) ? boundarySeen(input.transcript_path, now.getTime()) : null;
    const again = boundary != null && boundary === rec.fire?.boundaryAt;
    const put = expect ? true : fire ? fire.put === true : boundary != null && !again;
    const why = expect ? `expect ${expect.why}` : fire ? fire.why : again ? 'boundary already put back' : boundary ? 'boundary seen' : "not the main's";
    return { put, why, boundary };
  };
  let d;
  if (part === 'state') {
    updateRecord(path, (rec) => {
      d = decision(rec);
      const rest = { ...rec };
      delete rest.expect;
      // R1.4: the main's compaction ends the hold the first block's record measures from.
      if (d.put) delete rest.blocked;
      const boundaryAt = d.boundary ?? rec.fire?.boundaryAt ?? null;
      return { ...rest, fire: { at: now.toISOString(), source: 'compact', put: d.put, why: d.why, boundaryAt } };
    });
  } else d = decision(readJson(path) ?? {});
  const { put, why, boundary } = d;
  const s = readJson(sessionFile(home, input.session_id));
  return { put, why, boundary, task: taskOf(s), previous: Array.isArray(s?.previous) ? s.previous : [] };
}


// R5.5: compact/*.json untouched for PRUNE_DAYS days go; compact.log stays.
function prune(home, now) {
  const dir = join(home, 'compact');
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of names) {
    try {
      if (now.getTime() - statSync(join(dir, n)).mtimeMs > PRUNE_DAYS * 86_400_000) unlinkSync(join(dir, n));
    } catch {
      // the same
    }
  }
}

// `node <kirunak>/bin/k.mjs <args>` with K_MS to answer: { out } or { failed: its first stderr line }.
function k(args, cwd) {
  return new Promise((done) => {
    execFile(process.execPath, [join(ROOT, 'bin', 'k.mjs'), ...args], {
      timeout: K_MS, encoding: 'utf8', maxBuffer: 8 << 20, cwd: cwd && existsSync(cwd) ? cwd : undefined,
    }, (err, stdout, stderr) => {
      if (!err) done({ out: stdout });
      else done({ failed: err.killed ? `no answer in ${K_MS / 1000} s` : String(stderr).split('\n').find((l) => l.trim()) ?? err.message });
    });
  });
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// One file as a part's body: its path, then the text `shape` fits into what CAP leaves.
function fileBody(path, shape) {
  const text = readText(path);
  if (text == null) return `the file ${path}: none yet`;
  const head = `the file ${path}:\n`;
  return head + shape(text, CAP - head.length);
}

// The step states the plan part keeps blocks by (lib/steps.mjs stepStates); none when they cannot be read, so every
// block is kept and the part cut.
async function statesOf(dir, root, planText, progress) {
  try {
    const [{ stepStates }, { parsePlan }] = await Promise.all([import('../lib/steps.mjs'), import('../lib/plan.mjs')]);
    return stepStates({ dir, root }, parsePlan(planText), progress, null);
  } catch {
    return new Map();
  }
}

// The state part's facts (R5.1): the task's title, the chain's running steps with their starts, k status and k
// waiting run in parallel, the agents still running and the shell tasks of the last Stop, from the escalation
// records of this id (and the old one after /clear).
async function stateBody(home, input, fire, dir, source) {
  const id = input.session_id;
  const progress = readText(join(dir, 'progress.md')) ?? '';
  const [{ events, runningBy }, status, waiting] = await Promise.all([
    import('../lib/steps.mjs'), k(['status', '--session', id], input.cwd), k(['waiting', '--json'], input.cwd),
  ]);
  const chain = [...new Set(fire.previous)].filter((x) => isId(x) && x !== id);
  const starts = new Map();
  for (const e of events(progress)) if (e.verb === 'started' || e.verb === 'resumed') starts.set(e.step, `${e.date} ${e.time}`);
  const running = runningBy(progress, [id, ...chain], dir).map((step) => ({ step, since: starts.get(step) ?? null }));
  const title = /^---\n[\s\S]*?^title:\s*(.+)$/m.exec(readText(join(dir, 'task.md')) ?? '')?.[1]?.trim() ?? null;
  let lines;
  try {
    lines = waiting.failed ? null : waitingLines(JSON.parse(waiting.out ?? ''), fire.task);
  } catch {
    lines = null;
  }
  const records = [id, ...(source === 'clear' && isId(fire.from) ? [fire.from] : [])].map((x) => readJson(join(home, 'escalate', `${x}.json`)));
  const agents = records.flatMap((r) => Object.entries(r?.agents && typeof r.agents === 'object' ? r.agents : {}))
    .filter(([aid, a]) => isId(aid) && a && a.ended == null)
    .map(([aid, a]) => ({ id: aid, type: a.type, description: a.description, outputFile: a.outputFile, at: a.at, by: a.by }));
  const snap = records.find((r) => Array.isArray(r?.tasks?.list))?.tasks;
  return stateText({
    source, from: fire.from, task: fire.task, title, dir, session: id, chain, running, home,
    status: status.failed ? { failed: status.failed } : status.out,
    waiting: waiting.failed ? { failed: waiting.failed } : lines ?? { failed: 'its answer was not JSON' },
    agents, shells: snap ? { at: snap.at, list: snap.list.filter((x) => x?.type === 'shell') } : null,
  });
}

// SessionStart after `compact` or `clear`: the part's text with its label, or null when nothing is put back (another
// source, an agent's compaction, a session with no task, a task whose folder cannot be found). The state part logs the
// decision and prunes.
export async function onStart(input, home, part, now = new Date()) {
  const source = input.source;
  if (!PARTS.includes(part) || (source !== 'compact' && source !== 'clear') || !isId(input.session_id)) return null;
  // An agent's own event names it (hooks.md): never an agent's context (E-6).
  if (input.agent_id) return null;
  if (part === 'state') prune(home, now);
  const fire = source === 'compact' ? compactFire(home, input, part, now) : await clearFire(home, input, part, now);
  const config = fire.put && fire.task ? readJson(join(home, 'escalate', 'config.json')) : null;
  const dir = config ? taskDir(config, fire.task) : null;
  let text = null;
  if (dir) {
    const file = (name) => join(dir, name);
    if (part === 'task') text = fileBody(file('task.md'), (t, cap) => cut(t, cap, file('task.md')));
    if (part === 'progress') text = fileBody(file('progress.md'), (t, cap) => lastOf(t, cap, file('progress.md')));
    if (part === 'plan') {
      const planText = readText(file('plan.md')) ?? '';
      const states = await statesOf(dir, config.repos[fire.task.split('/')[0]], planText, readText(file('progress.md')) ?? '');
      text = fileBody(file('plan.md'), (t, cap) => planFor(t, states, file('plan.md'), cap));
    }
    if (part === 'state') text = await stateBody(home, input, fire, dir, source);
    text = `${labelOf(part, source)}\n${text}`;
  }
  if (part === 'state') {
    const why = !fire.put ? fire.why : !fire.task ? 'no task' : !dir ? 'task folder unknown' : fire.why;
    logLine(home, {
      ts: now.toISOString(), event: 'SessionStart', session: input.session_id, source, put: !!text, why,
      boundary: fire.boundary ?? null, task: fire.task ?? null, from: fire.from ?? null, chars: text?.length ?? null,
    });
  }
  return text;
}

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { idsOf } from './task.mjs';

// The plan (orchestrator.md §1): front matter (task, blocked-by), then one block per step:
// `### S-n <title> [<kind>[, <model>[, <effort>]]]` and its `key: value` lines. Free to change (R8);
// `check` guards the coverage and the inputs. k run's stop past the top rung appends `[escalate]` to the header and
// writes `failures:`, every failure report of the step (gulnya/enforced-escalation S-2 design R2.7); an older
// plan's `[escalate: fable, xhigh]` still parses, and means the same: stopped, the owner's session decides.

export const KINDS = ['agent', 'heavy', 'review', 'owner', 'sync'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// `task` and `diff` are the two named inputs: the frozen file, and the patch k step start writes.
export const NAMED_INPUTS = ['task', 'diff'];

const HEADER = /^###\s+(S-[A-Za-z0-9-]+)\s+(.*?)\s*\[([^\]]*)\]\s*(\[escalate(?::\s*([^\]]*))?\])?\s*$/;
const FIELD = /^([a-z][a-z-]*):\s*(.*)$/;
const LISTS = ['covers', 'inputs', 'outputs', 'needs', 'failures'];
const TEXTS = ['brief', 'command', 'what', 'device'];
const FIELDS = new Set([...LISTS, ...TEXTS, 'budget', 'max-minutes']);
const UNIT = { call: 'calls', calls: 'calls', minute: 'minutes', minutes: 'minutes', usd: 'usd' };

const list = (s) => String(s ?? '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);

// '100 calls, 40 minutes, 3 USD' → { calls: 100, minutes: 40, usd: 3 }; a part it cannot read is in `bad`.
export function parseBudget(text) {
  const out = {};
  const bad = [];
  for (const part of list(text)) {
    const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(part);
    const unit = m && UNIT[m[2].toLowerCase()];
    if (unit) out[unit] = Number(m[1]);
    else bad.push(part);
  }
  return { ...out, bad };
}

// parsePlan(text) → { front: { task, blockedBy }, steps: [step], problems: [{ line, problem }] }
// step: { id, title, kind, model, effort, escalate: null | { model, effort }, line, covers, inputs, outputs, needs,
//         failures, budget: { calls?, minutes?, usd? }, brief, command, what, device, maxMinutes }
export function parsePlan(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const front = { task: null, blockedBy: [] };
  const problems = [];
  const add = (line, problem) => problems.push({ line, problem });
  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
      if (m && m[1] === 'task') front.task = m[2].trim();
      else if (m && m[1] === 'blocked-by') front.blockedBy = list(m[2]);
    }
    i++;
  }
  const steps = [];
  let step = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('### ')) {
      step = null;
      const m = HEADER.exec(line);
      if (!m) {
        add(i + 1, 'a step is `### S-n <title> [<kind>[, <model>[, <effort>]]]`');
        continue;
      }
      const [kind, model, effort, ...extra] = m[3].split(',').map((s) => s.trim());
      if (!KINDS.includes(kind)) add(i + 1, `${m[1]}: unknown kind ${kind || '(none)'}; the kinds are ${KINDS.join(', ')}`);
      if (effort && !EFFORTS.includes(effort)) add(i + 1, `${m[1]}: unknown effort ${effort}; the levels are ${EFFORTS.join(', ')}`);
      if (extra.length) add(i + 1, `${m[1]}: the bracket holds a kind, a model and an effort, no more`);
      if (steps.some((s) => s.id === m[1])) add(i + 1, `${m[1]} is defined twice`);
      let escalate = null;
      if (m[4]) {
        const [em, ee] = list(m[5]);
        escalate = { model: em || null, effort: ee || null };
      }
      step = {
        id: m[1], title: m[2], kind, model: model || null, effort: effort || null, escalate, line: i + 1,
        covers: [], inputs: [], outputs: [], needs: [], failures: [], budget: {}, brief: null, command: null, what: null, device: null, maxMinutes: null,
      };
      steps.push(step);
      continue;
    }
    if (!step || line.trim() === '') continue;
    const f = FIELD.exec(line);
    if (!f || !FIELDS.has(f[1])) {
      add(i + 1, `${step.id}: not a plan field: ${line.trim()}`);
      continue;
    }
    const [, key, value] = f;
    if (LISTS.includes(key)) step[key] = list(value);
    else if (TEXTS.includes(key)) step[key] = value.trim();
    else if (key === 'max-minutes') {
      step.maxMinutes = Number(value);
      if (!(step.maxMinutes > 0)) add(i + 1, `${step.id}: max-minutes is a number of minutes`);
    } else {
      const { bad, ...budget } = parseBudget(value);
      step.budget = budget;
      for (const b of bad) add(i + 1, `${step.id}: budget part "${b}" is not <n> calls, <n> minutes or <n> USD`);
    }
  }
  for (const s of steps) {
    for (const n of s.needs) if (!steps.some((x) => x.id === n)) add(s.line, `${s.id} needs ${n}, which the plan does not have`);
    if (s.kind === 'heavy' && !s.command) add(s.line, `${s.id} is a heavy step with no command`);
  }
  return { front, steps, problems };
}

// Where a step's path is: outputs are in the task folder; an input is in the task folder or the repo.
export function inputPath(p, rel) {
  const inTask = join(p.dir, rel);
  return existsSync(inTask) ? inTask : join(p.root, rel);
}

const produces = (output, input) => output === input || (input.endsWith('/') && output.startsWith(input));

// checkPlan(plan, parsedTask, p) → [{ line, problem }]: the grammar's problems, then what `k plan check` refuses
// (orchestrator.md §1): no review step (k accept takes only a review), an AC or E no step covers, a covered id the
// task does not have, an input no earlier step produces and no file in the repo matches.
export function checkPlan(plan, task, p) {
  const problems = [...plan.problems];
  const add = (line, problem) => problems.push({ line, problem });
  if (plan.front.task && p?.id && plan.front.task !== p.id) add(1, `the plan is for ${plan.front.task}, not ${p.id}`);
  if (!plan.steps.length) add(1, 'the plan has no step');
  else if (!plan.steps.some((s) => s.kind === 'review')) add(1, 'the plan has no review step, and k accept needs a review: add a step of kind review (outputs: review.md)');
  const ids = idsOf(task);
  const covered = new Set();
  for (const s of plan.steps) {
    for (const c of s.covers) {
      if (c === 'all') for (const x of ids) covered.add(x);
      else if (!ids.has(c)) add(s.line, `${s.id} covers ${c}, which the task does not have`);
      else covered.add(c);
    }
  }
  for (const x of [...task.sections.ac, ...task.sections.e]) {
    if (x.id && !covered.has(x.id)) add(1, `${x.id} is covered by no step`);
  }
  for (const u of unproduced(plan, p)) add(u.line, `${u.step} input ${u.input}: no earlier step produces it and no file in the repo matches`);
  return problems;
}

// The inputs no earlier step produces and no file in the task folder or the repo matches: [{ step, input, line }].
export function unproduced(plan, p) {
  const out = [];
  plan.steps.forEach((s, n) => {
    const earlier = plan.steps.slice(0, n).flatMap((x) => x.outputs);
    for (const input of s.inputs) {
      if (NAMED_INPUTS.includes(input) || earlier.some((o) => produces(o, input))) continue;
      if (!p || !existsSync(inputPath(p, input))) out.push({ step: s.id, input, line: s.line });
    }
  });
  return out;
}

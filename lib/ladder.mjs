import { EFFORTS } from './plan.mjs';

// The ladder (gulnya/enforced-escalation, S-2 design §1): a list of rungs, lowest first. A step that failed twice
// climbs it one rung at a time, and k install writes a `<model>-step` agent for every rung above the lowest. Nothing
// here names a model: every rule reads the list (AC-31, E-18).

// kirunak's default (AC-28, AC-4, D-2, D-3): Opus builds a failed Sonnet step; Fable designs a failed Opus step and a
// fresh Opus run builds it.
export const DEFAULT_LADDER = Object.freeze([
  Object.freeze({ model: 'sonnet' }),
  Object.freeze({ model: 'opus', effort: 'high', mode: 'build', attempts: 1 }),
  Object.freeze({ model: 'fable', effort: 'high', mode: 'design', attempts: 1 }),
]);

// The escalation hook's switches, under the workspace's `hook` (S-2 design R4.2): off, the block off (AC-29), the
// repeats that fire (E-6), and regexes for more commands that count.
export const DEFAULT_HOOK = Object.freeze({ enabled: true, block: true, repeats: 2, commands: Object.freeze([]) });

export const MODES = ['build', 'design'];
const ALIAS = /^[a-z][a-z0-9]*$/;
const NAME = /^[A-Za-z0-9_-]+$/;
const TTLS = ['5m', '1h'];

// The family word of a model id or alias: the word after `claude-` (`claude-opus-5-5` → opus), or the alias itself.
// A context suffix such as `[1m]` is not part of it.
export function familyOf(model) {
  const s = String(model ?? '').toLowerCase().replace(/\[.*$/, '').trim();
  return s.startsWith('claude-') ? s.slice('claude-'.length).split('-')[0] : s;
}

// The problems of a ladder, as lines; none for a good one (R1.3).
export function checkLadder(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return ['the ladder must be a non-empty list of rungs, lowest first'];
  const out = [];
  const seen = new Set();
  ladder.forEach((r, i) => {
    const n = `rung ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      out.push(`${n} is not an object such as { model: 'sonnet' }`);
      return;
    }
    if (typeof r.model !== 'string' || !ALIAS.test(r.model)) {
      out.push(`${n} needs a model alias (lower-case letters and digits, such as sonnet), not ${JSON.stringify(r.model)}`);
    } else if (seen.has(r.model)) {
      out.push(`${n} repeats the model ${r.model}`);
    } else {
      seen.add(r.model);
    }
    if (r.id !== undefined && (typeof r.id !== 'string' || familyOf(r.id) !== r.model)) {
      out.push(`${n}: id ${JSON.stringify(r.id)} is not of the ${r.model} family (claude-${r.model}-…)`);
    }
    if (r.effort !== undefined && !EFFORTS.includes(r.effort)) {
      out.push(`${n}: unknown effort ${JSON.stringify(r.effort)}; the levels are ${EFFORTS.join(', ')}`);
    }
    if (r.mode !== undefined && !MODES.includes(r.mode)) out.push(`${n}: mode must be build or design, not ${JSON.stringify(r.mode)}`);
    if (r.attempts !== undefined && !(Number.isInteger(r.attempts) && r.attempts >= 1)) {
      out.push(`${n}: attempts must be a whole number of 1 or more, not ${JSON.stringify(r.attempts)}`);
    }
    if (r.agents !== undefined && !(Array.isArray(r.agents) && r.agents.every((a) => typeof a === 'string' && NAME.test(a)))) {
      out.push(`${n}: agents must be a list of agent names (letters, digits, - and _)`);
    }
    if (r.cacheTtl !== undefined && !TTLS.includes(r.cacheTtl)) out.push(`${n}: cacheTtl must be 5m or 1h, not ${JSON.stringify(r.cacheTtl)}`);
    // The lowest rung is the step's own model: its two attempts are k run's (AC-1), and nothing climbs to it.
    if (i === 0) {
      const named = ['mode', 'attempts', 'agents'].filter((k) => r[k] !== undefined);
      if (named.length) out.push(`${n} is the lowest: it names no ${named.join(', ')} (the step's own two attempts are k run's)`);
    }
    // A design rung's build run is on the rung below it, which must build (R2.4).
    if (i > 0 && r.mode === 'design' && ladder[i - 1]?.mode === 'design') {
      out.push(`${n} designs, and so does the rung below it: a design needs a build rung directly below it`);
    }
  });
  return out;
}

// The rung a model alias or id stands on: the rung whose id it is, else the rung of its family (R1.2); null for none.
export function rungOf(ladder, modelOrId) {
  if (!modelOrId) return null;
  return ladder.find((r) => r.id && r.id === modelOrId) ?? ladder.find((r) => r.model === familyOf(modelOrId)) ?? null;
}

const indexOf = (ladder, rung) => ladder.findIndex((r) => r.model === (typeof rung === 'string' ? rung : rung?.model));

// The rung above, or null at the top.
export function above(ladder, rung) {
  const i = indexOf(ladder, rung);
  return i >= 0 && i + 1 < ladder.length ? ladder[i + 1] : null;
}

export const modeOf = (rung) => rung.mode ?? 'build';
export const attemptsOf = (rung) => rung.attempts ?? 1;
export const stepAgent = (rung) => `${rung.model}-step`;

// The agents standing on a rung: the generated `<model>-step` and the workspace's own `agents`; none on the lowest,
// which nothing climbs to.
export function agentsOf(ladder, rung) {
  const i = indexOf(ladder, rung);
  if (i <= 0) return [];
  return [stepAgent(ladder[i]), ...(ladder[i].agents ?? [])];
}

// The rung that builds a rung's attempt: itself in build mode; for a design rung, the rung directly below (R2.4).
export function buildRungFor(ladder, rung) {
  const i = indexOf(ladder, rung);
  if (i < 0) return null;
  return modeOf(ladder[i]) === 'design' && i > 0 ? ladder[i - 1] : ladder[i];
}

// One line for k doctor: `sonnet → opus (high, build) → fable (high, design)`.
export function describeLadder(ladder) {
  return ladder.map((r, i) => {
    const parts = [r.effort, i > 0 ? modeOf(r) : null, attemptsOf(r) > 1 ? `${r.attempts} attempts` : null].filter(Boolean);
    return parts.length ? `${r.model} (${parts.join(', ')})` : r.model;
  }).join(' → ');
}

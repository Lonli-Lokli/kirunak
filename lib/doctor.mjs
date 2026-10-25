import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { agentsOf, describeLadder, familyOf, rungOf, stepAgent } from './ladder.mjs';
import { configPath, escalateConfig, escalateEvents, OWN_ESCALATE } from './install.mjs';

// k doctor's lines on the ladder (gulnya/enforced-escalation S-2 design R6.4): the ladder, its agents, settings.json's
// modelSettings against it, the escalation hook's wiring, its config.json and its switches. [ok, line] pairs.

// AC-20: settings.json names no effort at all for this family; the ladder's agents carry it.
const NO_SETTINGS_EFFORT = ['fable'];

export function ladderChecks({ ws, settingsPath, agentsDir }) {
  const ladder = ws.ladder;
  const out = [[true, `ladder: ${describeLadder(ladder)}`]];
  for (const rung of ladder.slice(1)) {
    for (const name of agentsOf(ladder, rung)) out.push(agentLine(rung, name, name !== stepAgent(rung), agentsDir));
  }
  const settings = readJson(settingsPath);
  out.push(...settingsLines(ladder, settings?.modelSettings));
  out.push(hookLine(ladder, settings?.hooks));
  out.push(configLine(ws));
  if (ws.hook.enabled === false) out.push([false, `hook off (hook.enabled: false in ${ws.modulePath})`]);
  if (ws.hook.block === false) out.push([false, `block off (hook.block: false in ${ws.modulePath})`]);
  if (ws.models && 'escalate' in ws.models) {
    out.push([false, `models.escalate is no longer read: the ladder's rungs replace it; remove it from ${ws.modulePath}`]);
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// The `key: value` lines of a file's front matter, quotes taken off.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):[ \t]*(.*?)\s*$/.exec(line);
    if (kv && kv[2]) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// A rung's agent: there, its model of the rung's family and its effort the rung's. The generated one is put right by
// k install; the workspace's own (a rung's `agents`) by hand.
function agentLine(rung, name, own, agentsDir) {
  const label = `rung agent ${name}${own ? ' (the workspace\'s own)' : ''}`;
  const path = join(agentsDir, `${name}.md`);
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return [false, `${label}: ${path} is missing (${own ? `write it, or take it off the ${rung.model} rung's agents` : 'run k install'})`];
  }
  const fm = frontmatter(readFileSync(real, 'utf8'));
  const facts = `${label}: ${real === path ? path : `${path} → ${real}`}, ${fm.model ?? 'no model'}, ${fm.effort ?? 'no effort'}`;
  const fix = own ? `set it in ${real}` : 'run k install';
  if (!fm.model || familyOf(fm.model) !== rung.model) return [false, `${facts}: its model is not of the ${rung.model} family (${fix})`];
  if ((fm.effort ?? null) !== (rung.effort ?? null)) return [false, `${facts}: the ladder says ${rung.effort ?? 'no effort'} (${fix})`];
  return [true, facts];
}

// Each modelSettings entry of a rung's family (R1.2) whose effortLevel is another than the rung's: it would set that
// model's effort to another level than the ladder's.
function settingsLines(ladder, modelSettings) {
  if (!modelSettings || typeof modelSettings !== 'object') return [];
  const out = [];
  for (const [key, entry] of Object.entries(modelSettings)) {
    const level = entry?.effortLevel;
    const head = `settings.json modelSettings ${key}`;
    if (NO_SETTINGS_EFFORT.includes(familyOf(key)) && level !== undefined) {
      out.push([false, `${head}: effortLevel ${level}, but settings name no effort for ${familyOf(key)}: remove it`]);
      continue;
    }
    const rung = rungOf(ladder, key);
    if (!rung || level === undefined) continue;
    if (level === rung.effort) out.push([true, `${head}: effortLevel ${level}, as the ${rung.model} rung`]);
    else {
      out.push([false, `${head}: effortLevel ${level} disagrees with the ${rung.model} rung (${rung.effort ?? 'no effort'}): ` +
        `remove it, or set the rung's effort to ${level}`]);
    }
  }
  return out;
}

// The escalation hook on every event of escalateEvents, with its matcher.
function hookLine(ladder, hooks) {
  const events = escalateEvents(ladder);
  const bad = [];
  for (const [event, matcher] of events) {
    const list = Array.isArray(hooks?.[event]) ? hooks[event] : [];
    const block = list.find((b) => (b?.hooks || []).some((h) => typeof h?.command === 'string' && OWN_ESCALATE.test(h.command.trim())));
    if (!block) bad.push(event);
    else if (block.matcher !== matcher) bad.push(`${event} (matcher ${block.matcher ?? 'none'}, the ladder's ${matcher ?? 'none'})`);
  }
  if (bad.length) return [false, `escalation hook: not wired on ${bad.join(', ')} (run k install)`];
  return [true, `escalation hook: wired on ${events.length} events`];
}

// config.json: there, what k install would write from this workspace now, and written after the module last changed.
function configLine(ws) {
  const path = configPath(ws.home);
  const cfg = existsSync(path) ? readJson(path) : null;
  if (!cfg) return [false, `escalate/config.json: ${path} is missing or not JSON (run k install)`];
  const { written, ...rest } = cfg;
  if (!isDeepStrictEqual(rest, escalateConfig(ws))) return [false, `escalate/config.json disagrees with the workspace (run k install)`];
  if (!(Date.parse(written) >= Math.floor(statSync(ws.modulePath).mtimeMs))) {
    return [false, `escalate/config.json is older than ${ws.modulePath} (run k install)`];
  }
  return [true, 'escalate/config.json matches the workspace'];
}

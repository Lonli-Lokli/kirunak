import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { agentsOf, describeLadder, familyOf, rungOf, stepAgent } from './ladder.mjs';
import { BUGS_MATCHER, compactEvents, configPath, escalateConfig, escalateEvents, OWN_BUGS, OWN_ESCALATE, trackerCommand } from './install.mjs';
import { DEFAULT_WINDOW, isId, SLACK, windowOf, windowSetting } from '../hooks/compact-rules.mjs';
import { compactConfig, compactOf, DEFAULT_COMPACT } from './compact.mjs';
import { userWindowLines, windowChecks, windowsOf } from './compact-window.mjs';

// k doctor's lines on the ladder (plugins.md §3): the ladder, its agents, settings.json's
// modelSettings against it, the escalation hook's wiring, its config.json, push to the phone and the hook's switches.
// [ok, line] pairs.

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
  out.push(hookLine(settings?.hooks));
  out.push(configLine(ws));
  out.push(pushLine(settingsPath, settings));
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
function hookLine(hooks) {
  const events = escalateEvents();
  const bad = [];
  for (const [event, matcher] of events) {
    const list = Array.isArray(hooks?.[event]) ? hooks[event] : [];
    const block = list.find((b) => (b?.hooks || []).some((h) => typeof h?.command === 'string' && OWN_ESCALATE.test(h.command.trim())));
    if (!block) bad.push(event);
    else if (block.matcher !== matcher) bad.push(`${event} (matcher ${block.matcher ?? 'none'}, kirunak's ${matcher ?? 'none'})`);
  }
  if (bad.length) return [false, `escalation hook: not wired on ${bad.join(', ')} (run k install)`];
  return [true, `escalation hook: wired on ${events.length} events`];
}

// Push to the phone (E-16, AC-26 as amendment A-1 words it): the session sends the push of a stop for the owner only
// while `/config` has turned it on, which writes `"agentPushNotifEnabled": true` into settings.json
// (orchestrator.md §2).
function pushLine(settingsPath, settings) {
  if (settings?.agentPushNotifEnabled === true) return [true, `push to the phone: on (agentPushNotifEnabled in ${settingsPath})`];
  return [false, `push to the phone: off, agentPushNotifEnabled is not true in ${settingsPath}: ` +
    'type /config agentPushNotifEnabled=true in a session, on the phone or in the terminal'];
}

// The bugs' notice (gulnya/kirunak-bugs AC-7): kirunak-bugs.mjs on SessionStart with k install's matcher, so a
// session the owner starts or clears is told the bugs that wait. A FAIL names k install, which wires it.
export function bugsHookLine({ settingsPath }) {
  const list = readJson(settingsPath)?.hooks?.SessionStart;
  const block = (Array.isArray(list) ? list : []).find((b) => (b?.hooks || []).some((h) => typeof h?.command === 'string' && OWN_BUGS.test(h.command.trim())));
  if (!block) return [false, `bugs' notice: not wired on SessionStart in ${settingsPath} (run k install)`];
  if (block.matcher !== BUGS_MATCHER) return [false, `bugs' notice: wired on SessionStart with matcher ${block.matcher ?? 'none'}, kirunak's ${BUGS_MATCHER} (run k install)`];
  return [true, `bugs' notice: wired on SessionStart ${BUGS_MATCHER}`];
}

// The status line's tracker (orchestrator.md §5): the only writer of a session's cost and of the cache expiry the
// keeper reads. Run when settings.json's statusLine command, or a script that command names, holds its file name. A WARN,
// never a FAIL: kirunak works without it, but a task's cost then says `cost not tracked` (gulnya/cost-untracked-sessions).
export function trackerLine({ settingsPath, kirunakRoot, home = homedir() }) {
  const cmd = readJson(settingsPath)?.statusLine?.command;
  const name = 'hooks/statusline-track.mjs';
  if (typeof cmd === 'string' && cmd.includes(name)) return [true, `status line tracker: run by statusLine in ${settingsPath}`];
  const scripts = typeof cmd === 'string' ? scriptsOf(cmd, home) : [];
  const runs = scripts.find((f) => readSmall(f)?.includes(name));
  if (runs) return [true, `status line tracker: run by ${runs}`];
  const where = typeof cmd !== 'string' ? `no statusLine command in ${settingsPath}` :
    `statusLine in ${settingsPath}${scripts.length ? ` and ${scripts.join(', ')}` : ''} do not run it`;
  return ['warn', `status line tracker: ${where}, so sessions' cost is not tracked and the cache keeper cannot see them: add ` +
    `this line to the status line command, fed the same JSON on stdin, with "refreshInterval": 30: ${trackerCommand(kirunakRoot)}`];
}

// The files a command line names: each word with a slash, `~/` and `$HOME/` read as the home folder, that is a file.
function scriptsOf(cmd, home) {
  const out = [];
  for (const word of cmd.split(/\s+/)) {
    const w = word.replace(/^(["'])(.*)\1$/, '$2');
    if (!w.includes('/')) continue;
    const path = w.replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
    try {
      if (statSync(path).isFile() && !out.includes(path)) out.push(path);
    } catch {}
  }
  return out;
}

// A file's text when it is under 1 MB and can be read, else null.
function readSmall(path) {
  try {
    return statSync(path).size < 1 << 20 ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
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

// k doctor's lines on the handover (orchestrator.md §5, R8.3): the settings and the mid-step limit, the compact hook's
// wiring, the window in each root, the user's own window (named, never failed: kirunak never writes it), the window a
// session started here gets, and the window of this session's model. [ok, line] pairs.
export function compactChecks({ ws, settingsPath, env = process.env, cwd = process.cwd() }) {
  const c = compactOf(ws);
  const settings = readJson(settingsPath);
  const user = windowsOf(settings);
  const whose = isDeepStrictEqual(c, DEFAULT_COMPACT) ? "kirunak's defaults" : ws.modulePath;
  const own = c.midStepLimit === 'user';
  let limit = `${c.midStepLimit} (a ${c.midStepLimit + SLACK} window)`;
  if (own) {
    const per = user.models.map(([m, v]) => `, ${v} for ${m} (modelSettings)`).join('');
    limit = user.top || per ? `the user's own window: ${user.top ?? 'none set'}${user.top ? ` (autoCompactWindow in ${settingsPath})` : ''}${per}` :
      "the user's own window: none set, the model's own window";
  }
  const out = [[true, `compact (${whose}): handover size ${c.handoverSize}, window ${c.handoverSize + SLACK}, mid-step limit ${limit}`]];
  // R7.2's check where the value is known: with 'user', the user's window is the limit; with a number, a smaller
  // user window is only noted (it is not in force in a workspace repo).
  for (const [what, v] of [['', user.top], ...user.models.map(([m, x]) => [` for ${m}`, x])]) {
    if (!v) continue;
    if (own && v <= c.handoverSize) {
      out.push([false, `the user's own window${what} ${v} is not above the handover size ${c.handoverSize}: as the mid-step ` +
        `limit, a compaction in the middle of a step would never wait for the step boundary; set compact.midStepLimit to ` +
        `a number above ${c.handoverSize} in ${ws.modulePath}, or raise the window`]);
    } else if (!own && v < c.midStepLimit + SLACK) {
      out.push([true, `the user's own window${what} ${v} is under the mid-step limit's window ${c.midStepLimit + SLACK}: in a ` +
        'workspace repo a step is compacted in its middle later than the window would elsewhere']);
    }
  }
  out.push(compactHookLine(settings?.hooks));
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(configPath(ws.home), 'utf8'))?.compact?.window ?? null;
  } catch {}
  out.push(...windowChecks({ ws, previous, userPath: settingsPath, env }));
  out.push(...userWindowLines(settingsPath, settings, c.midStepLimit).map((line) => [true, line]));
  out.push(hereLine({ ws, settingsPath, env, cwd }));
  const model = sessionModel(ws.home, env.CLAUDE_CODE_SESSION_ID);
  if (model) {
    const w = windowOf(model);
    out.push(w === DEFAULT_WINDOW ? [false, `compact hook on ${model}: ${model} is not in the window table: the hook holds at most one request on it`] :
      [true, `compact hook on ${model}: window ${w}`]);
  }
  return out;
}

// The compact hook on each of compactEvents' blocks, with its matcher.
function compactHookLine(hooks) {
  const bad = new Set();
  for (const { event, matcher, own } of compactEvents()) {
    const list = Array.isArray(hooks?.[event]) ? hooks[event] : [];
    const block = list.find((b) => (b?.hooks || []).some((h) => typeof h?.command === 'string' && own.test(h.command.trim())));
    if (!block || block.matcher !== matcher) bad.add(`${event} ${matcher}`);
  }
  if (bad.size) return [false, `compact hook: not wired on ${[...bad].join(', ')} (run k install)`];
  return [true, 'compact hook: wired on PreCompact auto|manual, SessionEnd clear, SessionStart compact|clear (4 parts)'];
}

// The window a session started in `cwd` gets (R2.5, top-level keys: no model), and whether it is a workspace root's.
function hereLine({ ws, settingsPath, env, cwd }) {
  const w = windowSetting({ env, cwd, configDir: dirname(settingsPath), roots: compactConfig(ws).roots });
  if (w.kirunak) return [true, `here (${cwd}): the handover window ${w.window} from ${w.from.file}`];
  const what = { env: `the window ${w.window} from ${w.from.key}`, user: `the user's own window ${w.window} from ${w.from.file}`,
    none: "no window set, the model's own" }[w.from.kind] ?? `the window ${w.window} from ${w.from.file}`;
  return [true, `here (${cwd}): ${what}; not a workspace root's handover window, so the compact hook never blocks here`];
}

// This session's model, from the escalation hook's record of it (written at SessionStart and on a model switch).
function sessionModel(home, session) {
  if (!isId(session)) return null;
  const m = readJson(join(home, 'escalate', `${session}.json`))?.model;
  return typeof m === 'string' && m ? m : null;
}

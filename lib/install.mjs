import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import { register, registered, registryKey, starter } from './slapignore.mjs';
import { recordFile } from './slap.mjs';
import { agentsOf, DEFAULT_HOOK, DEFAULT_LADDER, modeOf, stepAgent } from './ladder.mjs';
import { PARTS } from '../hooks/compact-rules.mjs';
import { compactConfig, compactOf } from './compact.mjs';
import { planWindows, printWindows, runWindows, userWindowLines } from './compact-window.mjs';
import { DEFAULT_USAGE } from './usage/week.mjs';
import { hookCommand, hookIn, pathOf, readText } from './os.mjs';

// `k install` (build-order.md, "What the owner wires, once"): the PreToolUse block, the cache keeper's SessionStart
// block and the line for the status line command (orchestrator.md §5), the bugs' notice on a session's start
// (SessionStart on startup|clear, gulnya/kirunak-bugs AC-7), the worktree lock's release on every SessionEnd
// (approval.md §4), the skill links, the escalation hook's blocks, the
// rung agents, the builder agent when the workspace has a `builder` entry, and the hook's config.json written from the
// workspace's ladder (plugins.md §3), the compact hook's blocks
// and the handover window in each workspace repo's own .claude/settings.local.json (orchestrator.md §5, R8.1, R8.2;
// never in the user's settings file), and with
// `git` a repo's pre-commit hook, its SLAP hook (prepare-commit-msg), its commit-msg hook (no new work on an accepted
// task, approval.md §3), a starter `.slapignore` when it has none (left for the owner to approve, R23), its place
// in the registry `k slapignore approve --all` reads, and kirunak/tasks/.gitignore for raw run output, completed when
// the repo has one (gulnya/close-leaves-untracked-step-files AC-3, E-1).
// Everything is checked before anything is written.

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const SKILLS = ['k-intake', 'k-done', 'k-board-page', 'k-draft', 'k-bug', 'k-go-on', 'usage-review', 'k-heavy'];
// Each hook's command as k install writes it on any platform, `\` or `/` (lib/os.mjs hookCommand).
export const OWN_FREEZE = hookCommand('kirunak-freeze.mjs');
const OWN_SESSION = hookCommand('kirunak-session.mjs');
export const OWN_BUGS = hookCommand('kirunak-bugs.mjs');
export const BUGS_MATCHER = 'startup|clear';
export const OWN_ESCALATE = hookCommand('kirunak-escalate.mjs');
// The stale-session hook (gulnya/k-usage AC-3, D-4), on UserPromptSubmit beside the escalation hook.
export const OWN_STALE = hookCommand('kirunak-stale.mjs');
// The timeout of every hook block but the compact hook's, whose blocks carry their own (compactEvents).
export const HOOK_TIMEOUT = 10;
// The worktree lock's release (approval.md §4): on every SessionEnd, /clear included, so no matcher, within 5 s.
export const OWN_UNLOCK = hookCommand('kirunak-unlock.mjs');
export const UNLOCK_TIMEOUT = 5;
// The freeze hook also refuses a scheduled prompt or a message that would type /k-go-on (approval.md §7), and reads
// Monitor's command as a Bash command.
export const FREEZE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Monitor|Skill|CronCreate|ScheduleWakeup|SendMessage';
// The line that marks a rung agent or the builder as k install's: a file without it is the owner's, and is not
// overwritten unasked.
export const MARKER = '<!-- kirunak: generated from the ladder -->';
const AGENT_TEMPLATE = new URL('../templates/rung-agent.md', import.meta.url);

const quote = (p) => (/^[\w./@%+=:,-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, '\\$1')}"`);

// The line the user's status line command runs for kirunak's tracker; k install prints it and k doctor names it.
export const trackerCommand = (root, platform = process.platform) => `node ${quote(pathOf(platform).join(root, 'hooks', 'statusline-track.mjs'))}`;

function readSettings(path) {
  if (!existsSync(path)) return { text: null, json: {} };
  const text = readFileSync(path, 'utf8');
  try {
    const json = text.trim() ? JSON.parse(text) : {};
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    return { text, json };
  } catch (e) {
    throw refuse(`${path} is not a JSON object (${e.message}); fix it, or wire the hook by hand from \`k install --print\``);
  }
}

const indentOf = (text) => /\n([ \t]+)"/.exec(text || '')?.[1] ?? '  ';

// One hook block's change to the settings: { changed, json, block, note }. A block of ours from another checkout, or
// with another matcher or timeout, is pointed here and given this matcher and timeout, never added twice; the note
// names a timeout it changed (gulnya/kirunak-install-hook-timeouts). Copies of our hook after the first, which an
// install that did not know its own command added (bug asilak/kirunak-install-hook-paths-windows), are folded into
// it: each is taken out of its block, and a block left with no hook goes; every other hook stays as it is.
function planBlock(json, path, event, block, own) {
  const { command, timeout } = block.hooks[0];
  const hooks = json.hooks ?? {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw refuse(`${path}: "hooks" is not an object`);
  const list = hooks[event] ?? [];
  if (!Array.isArray(list)) throw refuse(`${path}: "hooks.${event}" is not a list`);
  const ours = (h) => typeof h?.command === 'string' && own.test(h.command.trim());
  let first = null;
  let copies = 0;
  const kept = [];
  for (const b of list) {
    if (Array.isArray(b?.hooks) && b.hooks.some(ours)) {
      b.hooks = b.hooks.filter((h) => {
        if (!ours(h)) return true;
        copies++;
        first ??= { b, h };
        return first.h === h;
      });
      if (!b.hooks.length) continue;
    }
    kept.push(b);
  }
  if (!first) {
    const next = { ...json, hooks: { ...hooks, [event]: [...list, block] } };
    return { changed: true, json: next, block, note: `added the kirunak ${event} hook to ${path}` };
  }
  hooks[event] = kept;
  const folded = copies > 1 ? `folded ${copies} copies of the kirunak ${event} hook in ${path} into one` : '';
  const { b, h } = first;
  if (h.command === command && b.matcher === block.matcher && h.timeout === timeout) {
    return { changed: copies > 1, json, block, note: folded || `${path} already has the kirunak ${event} hook` };
  }
  const was = h.timeout === timeout ? '' : `, its timeout from ${h.timeout === undefined ? 'none' : `${h.timeout} s`} to ${timeout} s`;
  h.command = command;
  h.timeout = timeout;
  if (block.matcher === undefined) delete b.matcher;
  else b.matcher = block.matcher;
  const matcher = block.matcher === undefined ? '' : ` (matcher ${block.matcher})`;
  const updated = `updated the kirunak ${event} hook in ${path} to ${command}${matcher}${was}`;
  return { changed: true, json, block, note: folded ? `${folded}; ${updated}` : updated };
}

// The status line's tracker is a line in the user's own status line command, which k install does not write.
function statusLineNote(json, path, tracker) {
  const cmd = json.statusLine?.command;
  if (typeof cmd === 'string' && hookIn('statusline-track.mjs').test(cmd)) return `${path}: the status line already runs kirunak's tracker`;
  return `for the cache keeper, add this line to your status line command (statusLine in ${path}, or the script it ` +
    `runs), fed the same JSON on stdin, and set its "refreshInterval": 30: ${tracker}`;
}

// A skill link: 'ok' (already ours), 'make', or a refusal line naming what is in the way.
function planLink(link, target) {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return 'make';
  }
  if (st.isSymbolicLink()) {
    const to = resolve(dirname(link), readlinkSync(link));
    let same = to === resolve(target);
    try {
      same ||= realpathSync(link) === realpathSync(target);
    } catch {}
    if (same) return 'ok';
    return `${link} is a link to ${to}, not to ${target}`;
  }
  return `${link} is a skill of the same name that is not kirunak's link`;
}

// The escalation hook's events and matchers (approval.md §7), the same for every ladder; PostToolUseFailure's
// edit tools take back the flag of an edit that did not apply (O-2). SubagentStop's `.+` is every named agent, whose
// end the agent records keep: a regular expression that does not match the empty string keeps out Claude Code's
// internal agents, whose `agent_type` is empty; which agents lift a block is the hook's check, not the matcher's.
// Stop closes the main session's turn.
export function escalateEvents() {
  return [
    ['PostToolUseFailure', 'Bash|Edit|Write|MultiEdit|NotebookEdit'],
    ['PostToolUse', 'Agent'],
    ['SubagentStop', '.+'],
    ['UserPromptSubmit', undefined],
    ['UserPromptExpansion', undefined],
    ['SessionStart', 'startup|resume|clear'],
    ['PostModelSwitch', undefined],
    ['Stop', undefined],
  ];
}

// The compact hook's blocks (orchestrator.md §5, R8.1): PreCompact holds an automatic compaction until the step
// boundary; SessionEnd on /clear hands the task to the next session id; SessionStart after a compaction or /clear puts
// the task back, one block per part, since one hook's additionalContext is cut at 10,000 characters (hooks.md). Each
// block has its own `own` pattern, so one part's block is never taken for another's.
export function compactEvents() {
  const own = (part) => hookCommand('kirunak-compact.mjs', part ? ` --part ${part}` : '');
  return [
    { event: 'PreCompact', matcher: 'auto|manual', part: null, timeout: 10, own: own(null) },
    { event: 'SessionEnd', matcher: 'clear', part: null, timeout: 5, own: own(null) },
    ...PARTS.map((part) => ({ event: 'SessionStart', matcher: 'compact|clear', part, timeout: 20, own: own(part) })),
  ];
}

// What the escalation hook reads in place of the workspace, which it cannot import in its time (R4.2), without the
// time it was written. Without a workspace (k install before k init), kirunak's default ladder and switches.
export function escalateConfig(ws = null) {
  const ladder = ws?.ladder ?? DEFAULT_LADDER;
  return {
    workspace: ws?.modulePath ?? null,
    ladder: ladder.map((r, i) => ({
      model: r.model, id: r.id ?? null, effort: r.effort ?? null, mode: i ? modeOf(r) : null, agents: agentsOf(ladder, r),
    })),
    hook: { ...DEFAULT_HOOK, ...ws?.hook },
    repos: Object.fromEntries((ws?.repos ?? []).map((r) => [r.name, r.root])),
    compact: compactConfig(ws),
    // The stale-session hook's thresholds and the tracker's limits log (gulnya/k-usage AC-3, AC-4): the workspace's
    // usage.stale and usage.limitsLog, resolved; without a workspace, the defaults and no log (the tracker's own).
    usage: { stale: { ...(ws?.usage?.stale ?? DEFAULT_USAGE.stale) }, limitsLog: ws?.usage?.limitsLog ?? null },
  };
}

export const configPath = (home) => join(home, 'escalate', 'config.json');

// How a rung's agent works: it builds the step, or designs it for the session to build (the owner's rule of
// 2026-10-13 that the design rung designs and reviews only).
const MODE_TEXT = {
  build: {
    sentence: 'It takes the step itself',
    body: 'Take the step: read every failure report, do the step, and report what changed.',
  },
  design: {
    sentence: 'Design and review only: it returns a design the calling session builds from',
    body: 'Design and review only: return a design the calling session builds from (the files, the rules with their ' +
      'sources, the tests that prove it, the numbers to check). Write no production code. When you cannot settle the ' +
      'step, say plainly what is missing.',
  },
};

// A template's text with its {{slots}} filled. A line that is only an empty slot (an effort, autoCompactWindow or
// cacheTtl the rung does not set) is left out.
function fillTemplate(template, fill) {
  return readText(template).split('\n')
    .filter((l) => !/^\{\{\w+\}\}$/.test(l) || fill[l.slice(2, -2)])
    .join('\n')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
}

// The frontmatter slots of an agent standing on a rung: its id or model, effort, autoCompactWindow and cacheTtl.
const rungSlots = (rung) => ({
  model: rung.id ?? rung.model,
  effort: rung.effort ? `effort: ${rung.effort}` : '',
  window: rung.autoCompactWindow ? `autoCompactWindow: ${rung.autoCompactWindow}` : '',
  experimental: rung.cacheTtl ? `experimental:\n  cacheTtl: ${rung.cacheTtl}` : '',
});

// The text of the agent for the rung at index i of the ladder, from templates/rung-agent.md (R6.1).
export function rungAgentText(ladder, i) {
  const rung = ladder[i];
  const below = ladder[i - 1].model;
  const mode = MODE_TEXT[modeOf(rung)];
  return fillTemplate(AGENT_TEMPLATE, {
    name: stepAgent(rung),
    description: JSON.stringify(`One rung up from ${below} on this workspace's ladder: a session hands it a step kirunak ` +
      `counted failing twice. ${mode.sentence}. Generated by k install from the ladder; edit the ladder, not this file.`),
    ...rungSlots(rung),
    below,
    body: mode.body,
  });
}

// The builder agent (gulnya/builder-from-ladder AC-1, AC-2): written when the workspace has a `builder` entry, on the
// model and effort of the rung it names, with its tools, its words from templates/builder-agent.md.
export const BUILDER = 'builder';
const BUILDER_TEMPLATE = new URL('../templates/builder-agent.md', import.meta.url);
const listOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

export function builderAgentText(ladder, builder) {
  const rung = ladder.find((r) => r.model === builder.rung);
  return fillTemplate(BUILDER_TEMPLATE, { ...rungSlots(rung), rung: rung.model, tools: builder.tools.join(', '), toolList: listOf(builder.tools) });
}

// One generated agent's plan: write (none there), already (the same text), rewrite (ours, older), replace (the
// owner's, with --replace-agents), or a refusal line. A link is written through, so `real` is the file that changes.
function planAgent(agentsDir, name, text, replace) {
  const path = join(agentsDir, `${name}.md`);
  const at = (real, plan) => ({ name, path, real, text, plan });
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return at(path, 'write');
  }
  let real = path;
  if (st.isSymbolicLink()) {
    try {
      real = realpathSync(path);
    } catch {
      return at(path, `${path} is a link to ${resolve(dirname(path), readlinkSync(path))}, which does not exist`);
    }
  }
  const old = readFileSync(real, 'utf8');
  if (old === text) return at(real, 'already');
  if (old.includes(MARKER)) return at(real, 'rewrite');
  if (replace) return at(real, 'replace');
  return at(real, `${real} is an agent kirunak did not write (no "${MARKER}" line); pass --replace-agents to overwrite it`);
}

const AGENT_VERBS = { write: 'wrote', rewrite: 'rewrote', replace: 'replaced' };
const whereOf = (a) => (a.real === a.path ? a.path : `${a.path} → ${a.real}`);

// The repo's hooks folder as git uses it (core.hooksPath, worktrees), never assumed to be .git/hooks.
function hooksDir(repo) {
  const gitDir = join(repo, '.git');
  if (!existsSync(gitDir)) throw refuse(`${repo} is not a git repository (no .git)`);
  return resolve(repo, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo, encoding: 'utf8' }).trim());
}

// Whether a hook's line runs kirunak's hook `name` from this checkout, however the line spells the path
// (gulnya/kirunak-install-dry-run AC-1, E-1, E-2): a line that, its leading spaces dropped, starts with `#` never runs;
// else, with `"` and `'` dropped and `${HOME}`, `$HOME` and a `~` that starts a word read as `userHome`, it holds
// `<kirunakRoot>/hooks/<name>` as a word of its own (at the line's start or after a space, `(`, `;`, `&` or `|`, and
// followed by the end, a space, `;`, `)`, `&` or `|`), so another checkout or a path inside a longer one is not ours.
export function runsKirunakHook(line, kirunakRoot, name, userHome) {
  const l = line.trimStart();
  if (l.startsWith('#')) return false;
  const read = l.replace(/["']/g, '')
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => userHome)
    .replace(/(^|[\s(;&|])~(?=\/|[\s;)&|]|$)/g, (_, before) => `${before}${userHome}`);
  const target = `${kirunakRoot}/hooks/${name}`;
  for (let at = read.indexOf(target); at >= 0; at = read.indexOf(target, at + 1)) {
    const before = at ? read[at - 1] : ' ';
    const after = read[at + target.length] ?? ' ';
    if (/[\s(;&|]/.test(before) && /[\s;)&|]/.test(after)) return true;
  }
  return false;
}

// One plan per hook: write it (none there, or one kirunak wrote before that differs), already (it runs ours), or add
// (the repo's own hook: print the line). Whether the whole file is kirunak's own, to be rewritten, is decided by the
// literal absolute path kirunak writes, on a line that is not a comment; a line that runs ours through $HOME or ~ only
// makes the hook "already", so a hook of the owner's is never rewritten (gulnya/kirunak-install-dry-run E-4), and a
// commented-out line of ours is the owner's switching it off, never ours (E-2).
function planHook(hook, name, write, line, kirunakRoot, userHome) {
  if (!existsSync(hook)) return { hook, write };
  const text = readFileSync(hook, 'utf8');
  if (text === write) return { hook, already: true };
  const lines = text.split('\n');
  const literal = (l) => !l.trimStart().startsWith('#') && l.includes(`${kirunakRoot}/hooks/${name}`);
  if (lines.every((l) => !l.trim() || l === '#!/bin/sh' || l.startsWith('PATH="$PATH":') || literal(l))) return { hook, write, updated: true };
  if (lines.some((l) => l.trim() === line || runsKirunakHook(l, kirunakRoot, name, userHome))) return { hook, already: true };
  return { hook, add: line };
}

// Raw run output in a repo's task folders stays out of git (gulnya/close-leaves-untracked-step-files AC-3), as niva
// has it (game-minesweeper bd58b693). Only kirunak/tasks/.gitignore: a repo's root .gitignore is never touched.
export const TASKS_IGNORE = `# Raw run output stays on disk, never in git: each step's report or results.md is the evidence.
# Xcode result bundles: thousands of files and 100+ MB each; read with xcresulttool.
*.xcresult/
# Gradle's test results and reports, copied in whole (JUnit XML, binary output, --profile HTML).
*/steps/**/xml/
*/steps/**/*Test/
*/steps/**/profile-*/
*/steps/**/*profile*.html
# Build, test and device logs and captured console output.
*/steps/**/*.log
*/steps/**/*.out
`;
const ignorePatterns = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// The repo's kirunak/tasks/.gitignore: written whole when there is none; else only the pattern lines it lacks
// appended, the owner's lines and comments kept (E-1); none lacking, kept untouched. A line is compared as git reads
// it: a CRLF line's '\r' dropped, then its trailing spaces, its leading ones kept (a line '  *.log' ignores nothing,
// so it is lacking).
function planTasksIgnore(repo) {
  const file = join(repo, 'kirunak', 'tasks', '.gitignore');
  if (!existsSync(file)) return { file, write: TASKS_IGNORE, whole: true };
  const old = readFileSync(file, 'utf8');
  const have = new Set(old.split('\n').map((l) => l.replace(/\r$/, '').replace(/ +$/, '')));
  const missing = ignorePatterns(TASKS_IGNORE).filter((l) => !have.has(l));
  if (!missing.length) return { file };
  return { file, missing, write: `${old}${old && !old.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n` };
}

// A git client that reads no shell profile (a GUI) may have no node on PATH: the hooks add the folder of the node that
// ran `k install` at PATH's end, so a node already on PATH still comes first.
function planGit(repo, kirunakRoot, nodePath, userHome) {
  const dir = hooksDir(repo);
  const fallback = `PATH="$PATH":${quote(dirname(nodePath))}`;
  const node = (name) => `node ${quote(join(kirunakRoot, 'hooks', name))}`;
  return [
    planHook(join(dir, 'pre-commit'), 'git-pre-commit.mjs', `#!/bin/sh\n${fallback}\n${node('git-pre-commit.mjs')} || exit 1\n`,
      `${fallback} ${node('git-pre-commit.mjs')} || exit 1`, kirunakRoot, userHome),
    planHook(join(dir, 'prepare-commit-msg'), 'git-prepare-commit-msg.mjs',
      `#!/bin/sh\n${fallback}\nexec ${node('git-prepare-commit-msg.mjs')} "$@"\n`,
      `${fallback} ${node('git-prepare-commit-msg.mjs')} "$@" || exit 1`, kirunakRoot, userHome),
    planHook(join(dir, 'commit-msg'), 'git-commit-msg.mjs',
      `#!/bin/sh\n${fallback}\nexec ${node('git-commit-msg.mjs')} "$@"\n`,
      `${fallback} ${node('git-commit-msg.mjs')} "$@" || exit 1`, kirunakRoot, userHome),
  ].map((p) => ({ repo, ...p }));
}

// install({ settingsPath, kirunakRoot, skillsDir, agentsDir, replaceAgents, ws, git, print, home, nodePath, now, platform,
// userHome }) → { actions: [string] }. `ws` is the loaded workspace, whose ladder and hook switches it writes; null for
// none yet. `platform` writes the hooks' commands with its own separator, so a test can be win32. `userHome` is the
// home folder a repo's hook means by $HOME or ~ (runsKirunakHook), never KIRUNAK_HOME (`home`).
export function install({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  kirunakRoot = ROOT,
  skillsDir = join(homedir(), '.claude', 'skills'),
  agentsDir = join(homedir(), '.claude', 'agents'),
  replaceAgents = false,
  ws = null,
  git = null,
  print = false,
  home = kirunakHome(),
  nodePath = process.execPath,
  now = new Date(),
  platform = process.platform,
  userHome = homedir(),
} = {}) {
  const path = pathOf(platform);
  const root = path.resolve(kirunakRoot);
  const hook = (name) => ({ type: 'command', command: `node ${quote(path.join(root, 'hooks', name))}`, timeout: HOOK_TIMEOUT });

  const settings = readSettings(settingsPath);
  const s = planBlock(structuredClone(settings.json), settingsPath, 'PreToolUse', { matcher: FREEZE_MATCHER, hooks: [hook('kirunak-freeze.mjs')] }, OWN_FREEZE);
  const ss = planBlock(s.json, settingsPath, 'SessionStart', { matcher: 'resume', hooks: [hook('kirunak-session.mjs')] }, OWN_SESSION);
  const bs = planBlock(ss.json, settingsPath, 'SessionStart', { matcher: BUGS_MATCHER, hooks: [hook('kirunak-bugs.mjs')] }, OWN_BUGS);
  const ladder = ws?.ladder ?? DEFAULT_LADDER;
  let json = bs.json;
  const es = escalateEvents().map(([event, matcher]) => {
    const block = matcher === undefined ? { hooks: [hook('kirunak-escalate.mjs')] } : { matcher, hooks: [hook('kirunak-escalate.mjs')] };
    const p = planBlock(json, settingsPath, event, block, OWN_ESCALATE);
    json = p.json;
    return { event, ...p };
  });
  const st = planBlock(json, settingsPath, 'UserPromptSubmit', { hooks: [hook('kirunak-stale.mjs')] }, OWN_STALE);
  json = st.json;
  const cs = compactEvents().map(({ event, matcher, part, timeout, own }) => {
    const command = `node ${quote(path.join(root, 'hooks', 'kirunak-compact.mjs'))}${part ? ` --part ${part}` : ''}`;
    const p = planBlock(json, settingsPath, event, { matcher, hooks: [{ type: 'command', command, timeout }] }, own);
    json = p.json;
    return { event, ...p };
  });
  const unlock = { type: 'command', command: `node ${quote(path.join(root, 'hooks', 'kirunak-unlock.mjs'))}`, timeout: UNLOCK_TIMEOUT };
  const us = { event: 'SessionEnd', ...planBlock(json, settingsPath, 'SessionEnd', { hooks: [unlock] }, OWN_UNLOCK) };
  json = us.json;
  const agents = ladder.slice(1).map((r, i) => planAgent(agentsDir, stepAgent(r), rungAgentText(ladder, i + 1), replaceAgents));
  if (ws?.builder) agents.push(planAgent(agentsDir, BUILDER, builderAgentText(ladder, ws.builder), replaceAgents));
  const config = configPath(home);
  const configText = JSON.stringify({ written: now.toISOString(), ...escalateConfig(ws) }, null, 2) + '\n';
  // The window in each root's own local file (R8.2), never in settingsPath; `previous` is what k install last wrote.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(config, 'utf8'))?.compact?.window ?? null;
  } catch {}
  const windows = planWindows({ ws, previous, userPath: settingsPath });
  // The user's own window and its per-model values in settingsPath: named as theirs, kept as they are.
  const yours = userWindowLines(settingsPath, settings.json, compactOf(ws).midStepLimit);
  const tracker = statusLineNote(settings.json, settingsPath, trackerCommand(root, platform));
  const links = SKILLS.map((name) => {
    const target = path.join(root, 'skills', name);
    const link = join(skillsDir, name);
    return { name, target, link, plan: planLink(link, target) };
  });
  const gitRepos = (Array.isArray(git) ? git : git ? [git] : []).map((r) => resolve(r));
  const repos = gitRepos.flatMap((r) => planGit(r, root, nodePath, userHome));
  // `key` is the repo as the registry holds it, the key register() uses (gulnya/kirunak-install-dry-run E-3).
  const starters = gitRepos.map((r) => ({ repo: r, file: join(r, '.slapignore'), key: registryKey(r) }))
    .map((x) => ({ ...x, text: existsSync(x.file) ? null : starter(x.repo) }));
  const records = recordFile(home);
  const alreadyRegistered = (x) => `${x.key} is already registered in ${records}`;
  const ignores = gitRepos.map(planTasksIgnore);
  const blocked = [
    ...links.filter((l) => l.plan !== 'ok' && l.plan !== 'make'),
    ...agents.filter((a) => !['write', 'rewrite', 'replace', 'already'].includes(a.plan)),
  ];

  if (print) {
    const actions = [];
    actions.push(s.changed ? `would add to ${settingsPath} hooks.PreToolUse: ${JSON.stringify(s.block)}` : s.note);
    for (const l of links) {
      if (l.plan === 'ok') actions.push(`${l.link} already links to ${l.target}`);
      else if (l.plan === 'make') actions.push(`would link ${l.link} -> ${l.target}`);
      else actions.push(`would refuse: ${l.plan}; move it or remove it, then run k install again`);
    }
    actions.push(st.changed ? `would add to ${settingsPath} hooks.UserPromptSubmit: ${JSON.stringify(st.block)}` : st.note);
    for (const e of [...es, ...cs, us]) actions.push(e.changed ? `would set in ${settingsPath} hooks.${e.event}: ${JSON.stringify(e.block)}` : e.note);
    for (const a of agents) {
      if (AGENT_VERBS[a.plan]) actions.push(`would ${a.plan} ${whereOf(a)}:\n${a.text}`);
      else if (a.plan === 'already') actions.push(`${whereOf(a)} is already the ${a.name} agent the ladder makes`);
      else actions.push(`would refuse: ${a.plan}`);
    }
    actions.push(`would write ${config}:\n${configText}`, ...printWindows(windows), ...yours);
    for (const r of repos) {
      if (r.write) actions.push(`would ${r.updated ? 'rewrite' : 'write'} ${r.hook} (mode 755): ${JSON.stringify(r.write)}`);
      else if (r.already) actions.push(`${r.hook} already runs kirunak's hook`);
      else actions.push(`add this line to ${r.hook}: ${r.add}`);
    }
    for (const x of starters) {
      actions.push(x.text ? `would write ${x.file}, a starter for the owner to approve:\n${x.text}` : `${x.file} is there; kept`);
      actions.push(registered(home, x.repo) ? alreadyRegistered(x) : `would register ${x.key} in ${records}`);
    }
    for (const g of ignores) {
      if (g.whole) actions.push(`would write ${g.file}, raw run output kept out of git, for you to commit:\n${g.write}`);
      else if (g.write) actions.push(`would add to ${g.file} the lines it lacks, its own kept, for you to commit:\n${g.missing.join('\n')}`);
      else actions.push(`${g.file} has every raw-output line; kept`);
    }
    actions.push(bs.changed ? `would add to ${settingsPath} hooks.SessionStart: ${JSON.stringify(bs.block)}` : bs.note);
    actions.push(ss.changed ? `would add to ${settingsPath} hooks.SessionStart: ${JSON.stringify(ss.block)}` : ss.note, tracker);
    return { actions };
  }

  if (blocked.length) {
    throw refuse(`${blocked.map((l) => l.plan).join('; ')}. Nothing was written; move or remove it, then run k install again`);
  }

  const actions = [];
  if (s.changed || ss.changed || bs.changed || es.some((e) => e.changed) || st.changed || cs.some((e) => e.changed) || us.changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(json, null, indentOf(settings.text)) + '\n');
  }
  actions.push(s.note);
  for (const l of links) {
    if (l.plan === 'make') {
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(l.target, l.link, 'dir');
      actions.push(`linked ${l.link} -> ${l.target}`);
    } else {
      actions.push(`${l.link} already links to ${l.target}`);
    }
  }
  actions.push(...es.map((e) => e.note), st.note, ...cs.map((e) => e.note), us.note);
  for (const a of agents) {
    if (AGENT_VERBS[a.plan]) {
      mkdirSync(dirname(a.real), { recursive: true });
      writeFileSync(a.real, a.text);
      actions.push(`${AGENT_VERBS[a.plan]} the ${a.name} agent: ${whereOf(a)}`);
    } else {
      actions.push(`${whereOf(a)} is already the ${a.name} agent the ladder makes`);
    }
  }
  // Written every time, so its time is newer than the workspace module's for k doctor.
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, configText);
  actions.push(`wrote ${config}`, ...runWindows(windows), ...yours);
  for (const r of repos) {
    if (r.write) {
      mkdirSync(dirname(r.hook), { recursive: true });
      writeFileSync(r.hook, r.write);
      chmodSync(r.hook, 0o755);
      actions.push(`${r.updated ? 'rewrote' : 'wrote'} ${r.hook}`);
    } else if (r.already) {
      actions.push(`${r.hook} already runs kirunak's hook`);
    } else {
      actions.push(`${r.hook} is the repo's own hook; add this line to it: ${r.add}`);
    }
  }
  for (const x of starters) {
    if (x.text) {
      writeFileSync(x.file, x.text);
      actions.push(`wrote ${x.file}: ask the owner to read it and type \`! k slapignore approve ${x.repo}\`, then commit it`);
    } else {
      actions.push(`${x.file} is there; kept`);
    }
    actions.push(register(home, x.repo) ? `registered ${x.key} in ${records}` : alreadyRegistered(x));
  }
  for (const g of ignores) {
    if (g.write) {
      mkdirSync(dirname(g.file), { recursive: true });
      writeFileSync(g.file, g.write);
      actions.push(g.whole ? `wrote ${g.file}, raw run output kept out of git: commit it`
        : `added to ${g.file} the lines it lacked (${g.missing.join(' ')}), its own kept: commit it`);
    } else {
      actions.push(`${g.file} has every raw-output line; kept`);
    }
  }
  actions.push(bs.note, ss.note, tracker);
  return { actions };
}

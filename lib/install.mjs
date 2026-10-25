import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import { register, starter } from './slapignore.mjs';
import { recordFile } from './slap.mjs';
import { agentsOf, DEFAULT_HOOK, DEFAULT_LADDER, modeOf, stepAgent } from './ladder.mjs';

// `k install` (build-order.md, "What the owner wires, once"): the PreToolUse block, the cache keeper's SessionStart
// block and the line for the status line command (orchestrator.md §5), the skill links, the escalation hook's blocks, the
// rung agents and the hook's config.json written from the workspace's ladder (gulnya/enforced-escalation S-2 design
// §6), and with `git` a repo's pre-commit hook, its SLAP hook (prepare-commit-msg), a starter `.slapignore` when it has
// none (left for the owner to approve, R23) and its place in the registry `k slapignore approve --all` reads.
// Everything is checked before anything is written.

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const SKILLS = ['k-intake', 'k-done', 'k-board-page', 'k-draft'];
const OWN = /hooks\/kirunak-freeze\.mjs["']?$/;
const OWN_SESSION = /hooks\/kirunak-session\.mjs["']?$/;
export const OWN_ESCALATE = /hooks\/kirunak-escalate\.mjs["']?$/;
// The freeze hook also refuses a scheduled prompt or a message that would type /k-go-on (S-2 design R5.2).
export const FREEZE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill|CronCreate|SendMessage';
// The line that marks a rung agent as k install's: a file without it is the owner's, and is not overwritten unasked.
export const MARKER = '<!-- kirunak: generated from the ladder -->';
const AGENT_TEMPLATE = new URL('../templates/rung-agent.md', import.meta.url);

const quote = (p) => (/^[\w./@%+=:,-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, '\\$1')}"`);

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
// with another matcher, is pointed here and given this matcher, never added twice.
function planBlock(json, path, event, block, own) {
  const command = block.hooks[0].command;
  const hooks = json.hooks ?? {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw refuse(`${path}: "hooks" is not an object`);
  const list = hooks[event] ?? [];
  if (!Array.isArray(list)) throw refuse(`${path}: "hooks.${event}" is not a list`);
  for (const b of list) {
    for (const h of b?.hooks || []) {
      if (typeof h?.command !== 'string' || !own.test(h.command.trim())) continue;
      if (h.command === command && b.matcher === block.matcher) return { changed: false, json, block, note: `${path} already has the kirunak ${event} hook` };
      h.command = command;
      if (block.matcher === undefined) delete b.matcher;
      else b.matcher = block.matcher;
      const matcher = block.matcher === undefined ? '' : ` (matcher ${block.matcher})`;
      return { changed: true, json, block, note: `updated the kirunak ${event} hook in ${path} to ${command}${matcher}` };
    }
  }
  const next = { ...json, hooks: { ...hooks, [event]: [...list, block] } };
  return { changed: true, json: next, block, note: `added the kirunak ${event} hook to ${path}` };
}

// The status line's tracker is a line in the user's own status line command, which k install does not write.
function statusLineNote(json, path, tracker) {
  const cmd = json.statusLine?.command;
  if (typeof cmd === 'string' && cmd.includes('hooks/statusline-track.mjs')) return `${path}: the status line already runs kirunak's tracker`;
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

// The escalation hook's events and matchers (S-2 design R4.1, R6.3); SubagentStop's names the agents of every rung
// above the lowest, the ones whose end lifts a block.
export function escalateEvents(ladder) {
  return [
    ['PostToolUseFailure', 'Bash'],
    ['PostToolUse', 'Agent'],
    ['SubagentStop', ladder.flatMap((r) => agentsOf(ladder, r)).join('|')],
    ['UserPromptSubmit', undefined],
    ['UserPromptExpansion', undefined],
    ['SessionStart', 'startup|resume|clear'],
    ['PostModelSwitch', undefined],
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

// The text of the agent for the rung at index i of the ladder, from templates/rung-agent.md (R6.1). A template line
// that is only an empty slot (an effort or cacheTtl the rung does not set) is left out.
export function rungAgentText(ladder, i) {
  const rung = ladder[i];
  const below = ladder[i - 1].model;
  const mode = MODE_TEXT[modeOf(rung)];
  const fill = {
    name: stepAgent(rung),
    description: JSON.stringify(`One rung up from ${below} on this workspace's ladder: a session hands it a step kirunak ` +
      `counted failing twice. ${mode.sentence}. Generated by k install from the ladder; edit the ladder, not this file.`),
    model: rung.id ?? rung.model,
    effort: rung.effort ? `effort: ${rung.effort}` : '',
    experimental: rung.cacheTtl ? `experimental:\n  cacheTtl: ${rung.cacheTtl}` : '',
    below,
    body: mode.body,
  };
  return readFileSync(AGENT_TEMPLATE, 'utf8').split('\n')
    .filter((l) => !/^\{\{\w+\}\}$/.test(l) || fill[l.slice(2, -2)])
    .join('\n')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k] ?? '');
}

// One rung agent's plan: write (none there), already (the same text), rewrite (ours, older), replace (the owner's,
// with --replace-agents), or a refusal line. A link is written through, so `real` is the file that changes.
function planAgent(agentsDir, ladder, i, replace) {
  const name = stepAgent(ladder[i]);
  const path = join(agentsDir, `${name}.md`);
  const text = rungAgentText(ladder, i);
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

// One plan per hook: write it (none there, or one kirunak wrote before that differs), already (it runs ours), or add
// (the repo's own hook: print the line).
function planHook(hook, name, write, line, kirunakRoot) {
  if (!existsSync(hook)) return { hook, write };
  const text = readFileSync(hook, 'utf8');
  if (text === write) return { hook, already: true };
  const lines = text.split('\n');
  const runsOurs = (l) => l.includes(`${kirunakRoot}/hooks/${name}`);
  if (lines.every((l) => !l.trim() || l === '#!/bin/sh' || l.startsWith('PATH="$PATH":') || runsOurs(l))) return { hook, write, updated: true };
  if (lines.some((l) => l.trim() === line || runsOurs(l))) return { hook, already: true };
  return { hook, add: line };
}

// A git client that reads no shell profile (a GUI) may have no node on PATH: the hooks add the folder of the node that
// ran `k install` at PATH's end, so a node already on PATH still comes first.
function planGit(repo, kirunakRoot, nodePath) {
  const dir = hooksDir(repo);
  const fallback = `PATH="$PATH":${quote(dirname(nodePath))}`;
  const node = (name) => `node ${quote(join(kirunakRoot, 'hooks', name))}`;
  return [
    planHook(join(dir, 'pre-commit'), 'git-pre-commit.mjs', `#!/bin/sh\n${fallback}\n${node('git-pre-commit.mjs')} || exit 1\n`,
      `${fallback} ${node('git-pre-commit.mjs')} || exit 1`, kirunakRoot),
    planHook(join(dir, 'prepare-commit-msg'), 'git-prepare-commit-msg.mjs',
      `#!/bin/sh\n${fallback}\nexec ${node('git-prepare-commit-msg.mjs')} "$@"\n`,
      `${fallback} ${node('git-prepare-commit-msg.mjs')} "$@" || exit 1`, kirunakRoot),
  ].map((p) => ({ repo, ...p }));
}

// install({ settingsPath, kirunakRoot, skillsDir, agentsDir, replaceAgents, ws, git, print, home, nodePath, now })
// → { actions: [string] }. `ws` is the loaded workspace, whose ladder and hook switches it writes; null for none yet.
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
} = {}) {
  const root = resolve(kirunakRoot);
  const hook = (name) => ({ type: 'command', command: `node ${quote(join(root, 'hooks', name))}`, timeout: 10 });

  const settings = readSettings(settingsPath);
  const s = planBlock(structuredClone(settings.json), settingsPath, 'PreToolUse', { matcher: FREEZE_MATCHER, hooks: [hook('kirunak-freeze.mjs')] }, OWN);
  const ss = planBlock(s.json, settingsPath, 'SessionStart', { matcher: 'resume', hooks: [hook('kirunak-session.mjs')] }, OWN_SESSION);
  const ladder = ws?.ladder ?? DEFAULT_LADDER;
  let json = ss.json;
  const es = escalateEvents(ladder).map(([event, matcher]) => {
    const block = matcher === undefined ? { hooks: [hook('kirunak-escalate.mjs')] } : { matcher, hooks: [hook('kirunak-escalate.mjs')] };
    const p = planBlock(json, settingsPath, event, block, OWN_ESCALATE);
    json = p.json;
    return { event, ...p };
  });
  const agents = ladder.slice(1).map((_, i) => planAgent(agentsDir, ladder, i + 1, replaceAgents));
  const config = configPath(home);
  const configText = JSON.stringify({ written: now.toISOString(), ...escalateConfig(ws) }, null, 2) + '\n';
  const tracker = statusLineNote(settings.json, settingsPath, `node ${quote(join(root, 'hooks', 'statusline-track.mjs'))}`);
  const links = SKILLS.map((name) => {
    const target = join(root, 'skills', name);
    const link = join(skillsDir, name);
    return { name, target, link, plan: planLink(link, target) };
  });
  const gitRepos = (Array.isArray(git) ? git : git ? [git] : []).map((r) => resolve(r));
  const repos = gitRepos.flatMap((r) => planGit(r, root, nodePath));
  const starters = gitRepos.map((r) => ({ repo: r, file: join(r, '.slapignore') }))
    .map((x) => ({ ...x, text: existsSync(x.file) ? null : starter(x.repo) }));
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
    for (const e of es) actions.push(e.changed ? `would set in ${settingsPath} hooks.${e.event}: ${JSON.stringify(e.block)}` : e.note);
    for (const a of agents) {
      if (AGENT_VERBS[a.plan]) actions.push(`would ${a.plan} ${whereOf(a)}:\n${a.text}`);
      else if (a.plan === 'already') actions.push(`${whereOf(a)} is already the ${a.name} agent the ladder makes`);
      else actions.push(`would refuse: ${a.plan}`);
    }
    actions.push(`would write ${config}:\n${configText}`);
    for (const r of repos) {
      if (r.write) actions.push(`would ${r.updated ? 'rewrite' : 'write'} ${r.hook} (mode 755): ${JSON.stringify(r.write)}`);
      else if (r.already) actions.push(`${r.hook} already runs kirunak's hook`);
      else actions.push(`add this line to ${r.hook}: ${r.add}`);
    }
    for (const x of starters) {
      actions.push(x.text ? `would write ${x.file}, a starter for the owner to approve:\n${x.text}` : `${x.file} is there; kept`);
      actions.push(`would register ${x.repo} in ${recordFile(home)}`);
    }
    actions.push(ss.changed ? `would add to ${settingsPath} hooks.SessionStart: ${JSON.stringify(ss.block)}` : ss.note, tracker);
    return { actions };
  }

  if (blocked.length) {
    throw refuse(`${blocked.map((l) => l.plan).join('; ')}. Nothing was written; move or remove it, then run k install again`);
  }

  const actions = [];
  if (s.changed || ss.changed || es.some((e) => e.changed)) {
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
  actions.push(...es.map((e) => e.note));
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
  actions.push(`wrote ${config}`);
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
    if (register(home, x.repo)) actions.push(`registered ${x.repo} in ${recordFile(home)}`);
  }
  actions.push(ss.note, tracker);
  return { actions };
}

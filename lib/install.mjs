import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { refuse } from './errors.mjs';
import { kirunakHome } from './home.mjs';
import { register, starter } from './slapignore.mjs';
import { recordFile } from './slap.mjs';

// `k install` (build-order.md, "What the owner wires, once"): the PreToolUse block, the cache keeper's SessionStart
// block and the line for the status line command (orchestrator.md §5), the skill links, and with `git` a repo's pre-commit hook, its SLAP hook (prepare-commit-msg), a starter `.slapignore` when it has
// none (left for the owner to approve, R23) and its place in the registry `k slapignore approve --all` reads.
// Everything is checked before anything is written.

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SKILLS = ['k-intake', 'k-done'];
const OWN = /hooks\/kirunak-freeze\.mjs["']?$/;
const OWN_SESSION = /hooks\/kirunak-session\.mjs["']?$/;

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

// One hook block's change to the settings: { changed, json, block, note }. A block of ours from another checkout is
// pointed here, never added twice.
function planBlock(json, path, event, block, own) {
  const command = block.hooks[0].command;
  const hooks = json.hooks ?? {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw refuse(`${path}: "hooks" is not an object`);
  const list = hooks[event] ?? [];
  if (!Array.isArray(list)) throw refuse(`${path}: "hooks.${event}" is not a list`);
  for (const b of list) {
    for (const h of b?.hooks || []) {
      if (typeof h?.command !== 'string' || !own.test(h.command.trim())) continue;
      if (h.command === command) return { changed: false, json, block, note: `${path} already has the kirunak ${event} hook` };
      h.command = command;
      return { changed: true, json, block, note: `updated the kirunak ${event} hook in ${path} to ${command}` };
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

// install({ settingsPath, kirunakRoot, skillsDir, git, print, home, nodePath }) → { actions: [string] }
export function install({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  kirunakRoot = ROOT,
  skillsDir = join(homedir(), '.claude', 'skills'),
  git = null,
  print = false,
  home = kirunakHome(),
  nodePath = process.execPath,
} = {}) {
  const root = resolve(kirunakRoot);
  const hook = (name) => ({ type: 'command', command: `node ${quote(join(root, 'hooks', name))}`, timeout: 10 });

  const settings = readSettings(settingsPath);
  const s = planBlock(structuredClone(settings.json), settingsPath, 'PreToolUse', { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill', hooks: [hook('kirunak-freeze.mjs')] }, OWN);
  const ss = planBlock(s.json, settingsPath, 'SessionStart', { matcher: 'resume', hooks: [hook('kirunak-session.mjs')] }, OWN_SESSION);
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
  const blocked = links.filter((l) => l.plan !== 'ok' && l.plan !== 'make');

  if (print) {
    const actions = [];
    actions.push(s.changed ? `would add to ${settingsPath} hooks.PreToolUse: ${JSON.stringify(s.block)}` : s.note);
    for (const l of links) {
      if (l.plan === 'ok') actions.push(`${l.link} already links to ${l.target}`);
      else if (l.plan === 'make') actions.push(`would link ${l.link} -> ${l.target}`);
      else actions.push(`would refuse: ${l.plan}; move it or remove it, then run k install again`);
    }
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
  if (s.changed || ss.changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(ss.json, null, indentOf(settings.text)) + '\n');
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

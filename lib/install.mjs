import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { refuse } from './errors.mjs';

// `k install` (build-order.md, "What the owner wires, once"): the PreToolUse block, the skill links,
// and with `git` a repo's pre-commit hook and its SLAP hook (prepare-commit-msg). Everything is checked before anything is written.

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SKILLS = ['k-intake', 'k-done'];
const OWN = /hooks\/kirunak-freeze\.mjs["']?$/;

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

// The settings change: { changed, json, note }.
function planSettings(json, path, command) {
  const block = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Skill', hooks: [{ type: 'command', command, timeout: 10 }] };
  const hooks = json.hooks ?? {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw refuse(`${path}: "hooks" is not an object`);
  const pre = hooks.PreToolUse ?? [];
  if (!Array.isArray(pre)) throw refuse(`${path}: "hooks.PreToolUse" is not a list`);
  for (const b of pre) {
    for (const h of b?.hooks || []) {
      if (typeof h?.command !== 'string' || !OWN.test(h.command.trim())) continue;
      if (h.command === command) return { changed: false, json, block, note: `${path} already has the kirunak PreToolUse hook` };
      h.command = command;
      return { changed: true, json, block, note: `updated the kirunak PreToolUse hook in ${path} to ${command}` };
    }
  }
  const next = { ...json, hooks: { ...hooks, PreToolUse: [...pre, block] } };
  return { changed: true, json: next, block, note: `added the kirunak PreToolUse hook to ${path}` };
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

// One plan per hook: write it (none there), already (it runs ours), or add (the repo's own hook: print the line).
function planHook(hook, name, write, line, kirunakRoot) {
  if (!existsSync(hook)) return { hook, write };
  const text = readFileSync(hook, 'utf8');
  if (text.split('\n').some((l) => l.trim() === line || l.includes(`${kirunakRoot}/hooks/${name}`))) return { hook, already: true };
  return { hook, add: line };
}

function planGit(repo, kirunakRoot) {
  const dir = hooksDir(repo);
  const node = (name) => `node ${quote(join(kirunakRoot, 'hooks', name))}`;
  return [
    planHook(join(dir, 'pre-commit'), 'git-pre-commit.mjs', `#!/bin/sh\n${node('git-pre-commit.mjs')} || exit 1\n`,
      `${node('git-pre-commit.mjs')} || exit 1`, kirunakRoot),
    planHook(join(dir, 'prepare-commit-msg'), 'git-prepare-commit-msg.mjs', `#!/bin/sh\nexec ${node('git-prepare-commit-msg.mjs')} "$@"\n`,
      `${node('git-prepare-commit-msg.mjs')} "$@" || exit 1`, kirunakRoot),
  ].map((p) => ({ repo, ...p }));
}

// install({ settingsPath, kirunakRoot, skillsDir, git, print }) → { actions: [string] }
export function install({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  kirunakRoot = ROOT,
  skillsDir = join(homedir(), '.claude', 'skills'),
  git = null,
  print = false,
} = {}) {
  const root = resolve(kirunakRoot);
  const command = `node ${quote(join(root, 'hooks', 'kirunak-freeze.mjs'))}`;

  const settings = readSettings(settingsPath);
  const s = planSettings(structuredClone(settings.json), settingsPath, command);
  const links = SKILLS.map((name) => {
    const target = join(root, 'skills', name);
    const link = join(skillsDir, name);
    return { name, target, link, plan: planLink(link, target) };
  });
  const repos = (Array.isArray(git) ? git : git ? [git] : []).flatMap((r) => planGit(resolve(r), root));
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
      if (r.write) actions.push(`would write ${r.hook} (mode 755): ${JSON.stringify(r.write)}`);
      else if (r.already) actions.push(`${r.hook} already runs kirunak's hook`);
      else actions.push(`add this line to ${r.hook}: ${r.add}`);
    }
    return { actions };
  }

  if (blocked.length) {
    throw refuse(`${blocked.map((l) => l.plan).join('; ')}. Nothing was written; move or remove it, then run k install again`);
  }

  const actions = [];
  if (s.changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(s.json, null, indentOf(settings.text)) + '\n');
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
      actions.push(`wrote ${r.hook}`);
    } else if (r.already) {
      actions.push(`${r.hook} already runs kirunak's hook`);
    } else {
      actions.push(`${r.hook} is the repo's own hook; add this line to it: ${r.add}`);
    }
  }
  return { actions };
}

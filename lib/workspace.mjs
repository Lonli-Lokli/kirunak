import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { refuse, usage } from './errors.mjs';
import { expandHome, kirunakHome } from './home.mjs';
import { SEAMS } from './seams.mjs';
import storageGit from '../plugins/storage-git.mjs';
import handoffNotes from '../plugins/handoff-notes.mjs';

const DEFAULTS = {
  machine: { maxAgents: 2, maxHeavy: 1 },
  models: {},
  budget: { calls: 100, minutes: 40, usd: 3 },
  runner: { permissionMode: 'auto' },
  keeper: { intervalMinutes: 50 },
  baseline: null,
};

// The core's own implementations: used for a one-policy seam no workspace plugin provides, and loaded
// first for a many-policy seam (plugins.md §2).
const CORE_DEFAULTS = [
  { module: 'kirunak/plugins/storage-git.mjs', make: storageGit },
  { module: 'kirunak/plugins/handoff-notes.mjs', make: handoffNotes },
];

// Reads the pointer ($KIRUNAK_HOME/workspace), imports the workspace module and its plugins (plugins.md §3).
export async function loadWorkspace(pointer = join(kirunakHome(), 'workspace')) {
  if (!existsSync(pointer)) {
    throw usage(`no workspace: ${pointer} does not exist; run \`k init --workspace <path to the workspace module>\``);
  }
  const modulePath = resolve(expandHome(readFileSync(pointer, 'utf8').trim()));
  return loadWorkspaceModule(modulePath);
}

export async function loadWorkspaceModule(modulePath) {
  if (!existsSync(modulePath)) throw refuse(`the workspace module ${modulePath} does not exist`);
  let config;
  try {
    config = (await import(pathToFileURL(modulePath).href)).default;
  } catch (e) {
    throw refuse(`the workspace module ${modulePath} failed to load: ${e.message}`);
  }
  if (!config || !Array.isArray(config.repos) || !config.queue) {
    throw refuse(`the workspace module ${modulePath} must default-export { repos, queue, ... }`);
  }
  const base = dirname(modulePath);
  // Real paths, so a path compared with git's own (which resolves links such as /var → /private/var) matches.
  const at = (p) => {
    const abs = resolve(base, expandHome(p));
    return existsSync(abs) ? realpathSync(abs) : abs;
  };
  const ws = {
    ...DEFAULTS,
    ...config,
    modulePath,
    home: kirunakHome(),
    repos: config.repos.map(({ name, root }) => ({ name, root: at(root) })),
    queue: at(config.queue),
    plugins: (config.plugins || []).map(at),
    baseline: config.baseline ? at(config.baseline) : null,
  };
  ws.seams = await loadPlugins(ws);
  return ws;
}

// Validates every `provides` entry against its seam, applies the policies, and returns
// { storage: impl, checklist: [impl], ..., loaded: [{ seam, plugin, module }] }.
export async function loadPlugins(ws) {
  const found = {};
  for (const path of ws.plugins) {
    let plugin;
    try {
      plugin = (await import(pathToFileURL(path).href)).default;
      if (typeof plugin === 'function') plugin = await plugin(ws);
    } catch (e) {
      throw refuse(`plugin ${path} failed to load: ${e.message}`);
    }
    if (!plugin || typeof plugin.provides !== 'object') {
      throw refuse(`plugin ${path} must default-export { name, version, provides: { <seam>: implementation } }`);
    }
    for (const [seam, impl] of Object.entries(plugin.provides)) {
      validate(seam, impl, path);
      (found[seam] ||= []).push({ seam, plugin: plugin.name || path, module: path, impl });
    }
  }
  const core = {};
  for (const { module, make } of CORE_DEFAULTS) {
    const plugin = make(ws);
    for (const [seam, impl] of Object.entries(plugin.provides)) {
      validate(seam, impl, module);
      (core[seam] ||= []).push({ seam, plugin: plugin.name, module, impl });
    }
  }
  const seams = { loaded: [] };
  for (const [seam, { policy }] of Object.entries(SEAMS)) {
    const own = found[seam] || [];
    if (policy === 'one') {
      if (own.length > 1) {
        throw refuse(`seam ${seam} takes one implementation; two are loaded: ${own[0].module} and ${own[1].module}`);
      }
      const chosen = own[0] || (core[seam] || [])[0];
      if (chosen) {
        seams[seam] = chosen.impl;
        seams.loaded.push(strip(chosen));
      }
    } else {
      const all = [...(core[seam] || []), ...own];
      seams[seam] = all.map((x) => x.impl);
      seams.loaded.push(...all.map(strip));
    }
  }
  return seams;
}

const strip = ({ seam, plugin, module }) => ({ seam, plugin, module });

export function validate(seamName, impl, module = 'a plugin') {
  const seam = SEAMS[seamName];
  if (!seam) throw refuse(`${module} provides an unknown seam: ${seamName}`);
  if (!impl || typeof impl !== 'object') throw refuse(`${module}: seam ${seamName} must be an object of functions`);
  for (const fn of seam.functions) {
    if (typeof impl[fn] !== 'function') {
      throw refuse(`${module}: seam ${seamName} is missing the function ${fn}`);
    }
  }
  return impl;
}

const ID = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([a-z0-9-]{1,40})$/;

export function parseId(id) {
  const m = ID.exec(id || '');
  if (!m) throw usage(`not a task id: ${id} (want <repo>/<slug>, the slug lower-case letters, digits, hyphens, at most 40)`);
  return { repo: m[1], slug: m[2] };
}

// Where a task's files are (task-files.md §1).
export function taskPaths(ws, id) {
  const { repo, slug } = parseId(id);
  const r = ws.repos.find((x) => x.name === repo);
  if (!r) throw refuse(`unknown repo ${repo}: the workspace lists ${ws.repos.map((x) => x.name).join(', ')}`);
  const dir = join(r.root, 'kirunak', 'tasks', slug);
  return {
    id,
    repo,
    slug,
    root: r.root,
    dir,
    task: join(dir, 'task.md'),
    record: join(r.root, 'kirunak', 'approvals', `${slug}.json`),
    rel: (name) => `kirunak/tasks/${slug}/${name}`,
    recordRel: `kirunak/approvals/${slug}.json`,
  };
}

// Every aspect id the loaded checklists supply, in load order.
export async function aspectsOf(ws, task = null) {
  const out = [];
  for (const c of ws.seams.checklist) {
    for (const a of await c.aspects(task)) out.push(a);
  }
  return out;
}

// Every task id in the workspace's repos (or one repo), in repo order then slug order.
export function allTaskIds(ws, repo = null) {
  const ids = [];
  for (const r of ws.repos) {
    if (repo && r.name !== repo) continue;
    const dir = join(r.root, 'kirunak', 'tasks');
    if (!existsSync(dir)) continue;
    for (const slug of readdirSync(dir).sort()) {
      if (existsSync(join(dir, slug, 'task.md'))) ids.push(`${r.name}/${slug}`);
    }
  }
  return ids;
}

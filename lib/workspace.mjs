import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { refuse, usage } from './errors.mjs';
import { expandHome, kirunakHome } from './home.mjs';
import { SEAMS } from './seams.mjs';
import { checkLadder, DEFAULT_HOOK, DEFAULT_LADDER } from './ladder.mjs';
import { checkCompact, DEFAULT_COMPACT } from './compact.mjs';
import { checkUsage, DEFAULT_USAGE, mergeUsage } from './usage/week.mjs';
import storageGit from '../plugins/storage-git.mjs';
import handoffNotes from '../plugins/handoff-notes.mjs';
import resourceGuardLocal from '../plugins/resource-guard-local.mjs';
import machineGuardPids from '../plugins/machine-guard-pids.mjs';
import pricesDefault from '../plugins/prices-default.mjs';
import runnerClaude from '../plugins/runner-claude.mjs';

const DEFAULTS = {
  machine: { maxAgents: 2, maxHeavy: 1 },
  models: {},
  budget: { calls: 100, minutes: 40, usd: 3 },
  runner: { permissionMode: 'auto' },
  keeper: { intervalMinutes: 50 },
  baseline: null,
  // The ladder a failed step climbs (lib/ladder.mjs), and the escalation hook's switches (AC-29, E-6).
  ladder: DEFAULT_LADDER,
  hook: DEFAULT_HOOK,
  // The handover's settings (orchestrator.md §5, R7.1): the handover size, the mid-step limit, the folders besides the
  // repos that get the handover window, and the switch.
  compact: DEFAULT_COMPACT,
  // The weekly usage review's settings (gulnya/k-usage D-2, D-7, D-8): the limit week's start, the reviews' folder
  // and baseline, the rate-limit log, and the stale-session hook's minutes and context.
  usage: DEFAULT_USAGE,
};

// The core's own implementations: used for a one-policy seam no workspace plugin provides, and loaded
// first for a many-policy seam (plugins.md §2).
const CORE_DEFAULTS = [
  { module: 'kirunak/plugins/storage-git.mjs', make: storageGit },
  { module: 'kirunak/plugins/handoff-notes.mjs', make: handoffNotes },
  { module: 'kirunak/plugins/resource-guard-local.mjs', make: resourceGuardLocal },
  { module: 'kirunak/plugins/machine-guard-pids.mjs', make: machineGuardPids },
  { module: 'kirunak/plugins/prices-default.mjs', make: pricesDefault },
  { module: 'kirunak/plugins/runner-claude.mjs', make: runnerClaude },
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
  // models.escalate still loads, though nothing reads it: k doctor names it (plugins.md §3).
  const problems = checkLadder(config.ladder ?? DEFAULTS.ladder);
  if (problems.length) throw refuse(`the workspace module ${modulePath}: its ladder: ${problems.join('; ')}`);
  const own = config.compact;
  const compact = own === undefined ? DEFAULT_COMPACT : own && typeof own === 'object' && !Array.isArray(own) ? { ...DEFAULT_COMPACT, ...own } : own;
  const wrong = checkCompact(compact);
  if (wrong.length) throw refuse(`the workspace module ${modulePath}: ${wrong.join('; ')}`);
  const use = mergeUsage(config.usage);
  const badUse = checkUsage(use);
  if (badUse.length) throw refuse(`the workspace module ${modulePath}: ${badUse.join('; ')}`);
  const records = config.records ?? [];
  if (!Array.isArray(records) || records.some((p) => typeof p !== 'string' || !p.trim())) {
    throw refuse(`the workspace module ${modulePath}: records must be a list of paths, a folder ending with a slash`);
  }
  const base = dirname(modulePath);
  // Real paths, so a path compared with git's own (which resolves links such as /var → /private/var) matches; one that
  // does not exist yet, such as a record not written, is made real through the nearest folder that does.
  const real = (abs) => (existsSync(abs) ? realpathSync(abs) : join(real(dirname(abs)), basename(abs)));
  const at = (p) => real(resolve(base, expandHome(p)));
  const ws = {
    ...DEFAULTS,
    ...config,
    modulePath,
    home: kirunakHome(),
    repos: config.repos.map(({ name, root }) => ({ name, root: at(root) })),
    queue: at(config.queue),
    // The order the drafts wait in (task-files.md §1, owner 2026-10-27): beside the queue, in the repo that holds it.
    draftOrder: join(dirname(at(config.queue)), 'drafts-order.md'),
    // More of kirunak's records (approval.md §3, AC-5): a folder keeps its slash.
    records: records.map((p) => at(p) + (p.endsWith('/') ? '/' : '')),
    plugins: (config.plugins || []).map(at),
    baseline: config.baseline ? at(config.baseline) : null,
    // kirunak's own checkout, the repo a fix to kirunak is made in (gulnya/kirunak-bugs): the folder above lib/ of the
    // code that runs, unless the workspace names another.
    kirunakRoot: config.kirunakRoot ? at(config.kirunakRoot) : null,
    hook: { ...DEFAULTS.hook, ...config.hook },
    compact: { ...compact, alsoIn: compact.alsoIn.map(at) },
    usage: usageOf(use, config.bugs, base),
  };
  ws.seams = await loadPlugins(ws);
  return ws;
}

// The `usage` block with its paths resolved as `bugs.limitsLog` is (lib/limits.mjs): against the workspace module's
// folder, or ~/... The rate-limit log is `usage.limitsLog`, else `bugs.limitsLog` (its older name, Quad Damage's), else
// $KIRUNAK_HOME/rate-limits.log.
function usageOf(use, bugs, base) {
  const path = (p) => (typeof p === 'string' && p.trim() ? resolve(base, expandHome(p.trim())) : null);
  return {
    ...use,
    reviews: path(use.reviews),
    baseline: path(use.baseline),
    limitsLog: path(use.limitsLog) ?? path(bugs?.limitsLog) ?? join(kirunakHome(), 'rate-limits.log'),
  };
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

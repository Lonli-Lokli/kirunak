import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SLACK } from '../hooks/compact-rules.mjs';
import { compactOf, rootsOf } from './compact.mjs';

// The handover window in each root's own .claude/settings.local.json (orchestrator.md §5, R8.2): what k install writes
// there and what k doctor checks. The user's settings file is never written here and is read only for its `env` block:
// its autoCompactWindow is the user's own window, the mid-step limit.

export const LOCAL = '.claude/settings.local.json';
export const EXCLUDE_LINE = '/.claude/settings.local.json';
export const ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const indentOf = (text) => /\n([ \t]+)"/.exec(text || '')?.[1] ?? '  ';
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A settings file: { text, json } (missing: text null, json {}), or { error } when it is not a JSON object.
function readFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { text: null, json: {} };
  }
  try {
    const json = text.trim() ? JSON.parse(text) : {};
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    return { text, json };
  } catch (e) {
    return { text, error: e.message };
  }
}

// The windows a file sets: its top-level value, and each model's in modelSettings (a value not a number counts as none).
export function windowsOf(json) {
  const ms = json?.modelSettings && typeof json.modelSettings === 'object' ? json.modelSettings : {};
  return { top: num(json?.autoCompactWindow), models: Object.entries(ms).map(([m, e]) => [m, num(e?.autoCompactWindow)]).filter(([, v]) => v) };
}
const envOf = (json) => num(Number(json?.env?.[ENV]));

// The user's own window in their settings file, and each model's there, named as theirs and kept, for k install and
// k doctor alike (R8.2, R8.3). `json` is the file as read; left out, it is read here.
export function userWindowLines(userPath, json = readFile(userPath).json) {
  const { top, models } = windowsOf(json);
  const out = top ? [`${userPath}: autoCompactWindow ${top}, yours (the mid-step limit); kirunak never writes it`] : [];
  for (const [m, v] of models) {
    out.push(`${userPath}: modelSettings.${m}.autoCompactWindow ${v}, yours (the mid-step limit for ${m}); kirunak never writes it`);
  }
  return out;
}

// R8.2 steps 1-4 for one root: the file Claude Code reads there (R2.7), whether git tracks or ignores it, what it
// sets, and the shared project file of the root.
function inspect({ name, root, dir }) {
  const file = join(dir, LOCAL);
  const r = { name, root, dir, file };
  if (!existsSync(dir)) return { ...r, missing: true };
  const t = git(dir, ['ls-files', '--error-unmatch', LOCAL]);
  const inGit = t.status === 0 || t.status === 1;
  const tracked = t.status === 0;
  const ignored = inGit && !tracked && git(dir, ['check-ignore', '-q', LOCAL]).status === 0;
  const sharedFile = join(root, '.claude', 'settings.json');
  return { ...r, git: inGit, tracked, ignored, local: readFile(file), shared: { file: sharedFile, ...readFile(sharedFile) } };
}

// R8.2 step 5's case: the first that matches. With the handover off: remove kirunak's own window, keep any other.
function caseOf(r, { enabled, wanted, previous }) {
  if (r.missing) return 'missing';
  if (r.tracked) return 'tracked';
  if (r.local.error) return 'unreadable';
  const v = windowsOf(r.local.json).top;
  if (!enabled) return v == null ? 'off' : v === wanted || v === previous ? 'remove' : 'kept';
  if (v == null) {
    const s = r.shared.json ? windowsOf(r.shared.json) : { top: null, models: [] };
    return s.top || s.models.length ? 'e' : 'a';
  }
  return v === wanted ? 'b' : v === previous ? 'c' : 'd';
}

// What decides the window in every root: [{ ...inspect, kase, v }], with the facts each line needs.
function survey(ws, previous) {
  const c = compactOf(ws);
  const wanted = c.handoverSize + SLACK;
  const facts = { enabled: c.enabled, wanted, previous, handoverSize: c.handoverSize };
  const roots = rootsOf(ws).map(inspect).map((r) => ({ ...r, kase: caseOf(r, facts), v: r.local?.json ? windowsOf(r.local.json).top : null }));
  return { facts, roots };
}

const sharedLine = (r, wanted) => {
  const s = windowsOf(r.shared.json);
  const [key, v] = s.top ? ['autoCompactWindow', s.top] : [`modelSettings.${s.models[0][0]}.autoCompactWindow`, s.models[0][1]];
  return `${r.shared.file} sets ${key} ${v} (the repo's own, committed); kept. For the handover set it to ${wanted} there, ` +
    `or put ${wanted} in ${r.file} yourself`;
};
const envLine = (v, where) => `${ENV}=${v} in ${where} beats every setting: the handover window is not in force while it is set`;

// The lines one root's case says, for k install and k doctor alike: { line, fail } (fail: k doctor's FAIL).
function says(r, { wanted, previous, handoverSize }) {
  switch (r.kase) {
    case 'missing': return { line: `${r.root} does not exist; the window was not written`, fail: true };
    case 'tracked': return { line: `${r.file} is tracked by git: a window there would be committed; untrack it (git rm --cached ${LOCAL}) or set ${wanted} in it yourself`, fail: true };
    case 'unreadable': return { line: `${r.file} is not a JSON object (${r.local.error}): fix it; the window was not written`, fail: true };
    case 'a': return { line: `set autoCompactWindow ${wanted} in ${r.file} (handover size ${handoverSize} + ${SLACK})`, write: wanted };
    case 'b': return { line: `${r.file}: autoCompactWindow is already ${wanted}` };
    case 'c': return { line: `replaced autoCompactWindow ${r.v} with ${wanted} in ${r.file} (kirunak's own, the handover size changed)`, write: wanted };
    case 'd': return { line: `${r.file}: autoCompactWindow is ${r.v}, yours; kept. The handover window is ${wanted}: set it there yourself, or remove the key and run k install again`, fail: true };
    case 'e': return { line: sharedLine(r, wanted), fail: true };
    case 'remove': return { line: `removed autoCompactWindow ${r.v} from ${r.file} (compact.enabled: false)`, write: null };
    case 'kept': return { line: `${r.file}: autoCompactWindow is ${r.v}, yours; kept (compact.enabled: false)` };
    default: return { line: `${r.file}: no handover window (compact.enabled: false)` };
  }
}

// The lines named beside a root's case: f (a per-model window in its local file) and g (the variable in a project
// file's env), and once for all roots g in the shell and in the user's file.
function besides(r, wanted) {
  if (!r.local?.json || r.kase === 'off' || r.kase === 'remove' || r.kase === 'kept') return [];
  const out = windowsOf(r.local.json).models.map(([m, v]) =>
    `${r.file}: modelSettings.${m}.autoCompactWindow ${v} beats the handover window for ${m}; remove it, or set it to ${wanted}`);
  for (const [path, json] of [[r.file, r.local.json], [r.shared.file, r.shared.json]]) {
    const v = envOf(json);
    if (v) out.push(envLine(v, `${path} env`));
  }
  return out;
}
function everywhere(env, userPath) {
  const out = [];
  const shell = envOf({ env });
  if (shell) out.push(envLine(shell, 'the shell'));
  const user = userPath ? envOf(readFile(userPath).json) : null;
  if (user) out.push(envLine(user, `${userPath} env`));
  return out;
}

const WOULD = { set: 'would set', replaced: 'would replace', removed: 'would remove', added: 'would add' };
const would = (line) => line.replace(/^(set|replaced|removed|added)\b/, (w) => WOULD[w]);

// k install's part (R8.2): { items: [{ line, run }] }, each `run` the write its line says, done after every check.
// `previous` is config.json's compact.window as the last k install wrote it.
export function planWindows({ ws, previous = null, userPath, env = process.env }) {
  if (!ws) return [{ line: 'no workspace yet: the handover window is written into each repo\'s .claude/settings.local.json by the next k install' }];
  const { facts, roots } = survey(ws, previous);
  const items = everywhere(env, userPath).map((line) => ({ line }));
  for (const r of roots) {
    const s = says(r, facts);
    if (r.dir !== r.root && !r.missing) items.push({ line: `${r.root} is a worktree: sessions there read ${r.file}` });
    const writes = 'write' in s;
    const exists = writes ? s.write !== null : r.local?.text != null;
    const ignoreStep = facts.enabled && r.git && !r.tracked && !r.local?.error && exists && ['a', 'b', 'c', 'd'].includes(r.kase);
    const item = { line: s.line + (ignoreStep && r.ignored ? '; ignored by git' : ''), run: writes ? () => writeWindow(r, s.write) : null };
    items.push(item);
    items.push(...besides(r, facts.wanted).map((line) => ({ line })));
    if (ignoreStep && !r.ignored) items.push(excludeItem(r));
  }
  return items;
}

export const printWindows = (items) => items.map((i) => (i.run ? would(i.line) : i.line));
export function runWindows(items) {
  return items.map((i) => (i.run?.() ?? i.line));
}

function writeWindow(r, value) {
  const json = { ...r.local.json };
  if (value === null) delete json.autoCompactWindow;
  else json.autoCompactWindow = value;
  mkdirSync(dirname(r.file), { recursive: true });
  writeFileSync(r.file, JSON.stringify(json, null, indentOf(r.local.text)) + '\n');
}

// R8.2 step 6: the file is not ignored, so the repo's own excludes file gets the line (shared by a main checkout and
// its worktrees, never committed); never the committed .gitignore, and never the global excludes file, Claude Code's.
function excludeItem(r) {
  const out = git(r.dir, ['rev-parse', '--git-path', 'info/exclude']);
  const path = resolve(r.dir, out.stdout.trim() || '.git/info/exclude');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.split('\n').includes(EXCLUDE_LINE)) {
    return { line: `${r.file} is not ignored by git although ${path} lists ${EXCLUDE_LINE}: a later rule takes it back; ignore it yourself` };
  }
  return {
    line: `added ${EXCLUDE_LINE} to ${path} (or put it in the repo's .gitignore yourself)`,
    run: () => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
    },
  };
}

// k doctor's lines per root (R8.3): [ok, line]. `previous` is config.json's compact.window.
export function windowChecks({ ws, previous = null, userPath, env = process.env }) {
  const { facts, roots } = survey(ws, previous);
  const out = everywhere(env, userPath).map((line) => [false, line]);
  for (const r of roots) {
    const head = `${r.name}:`;
    if (r.kase === 'b') {
      if (r.git && !r.ignored) out.push([false, `${head} ${r.file} is not ignored by git (run k install)`]);
      else out.push([true, `${head} autoCompactWindow ${facts.wanted} in ${r.file}${r.git ? ', ignored by git' : ', not in a git repository'}`]);
    } else if (r.kase === 'a') out.push([false, `${head} autoCompactWindow not set in ${r.file} (run k install)`]);
    else if (r.kase === 'c') out.push([false, `${head} autoCompactWindow ${r.v} in ${r.file} is kirunak's earlier window (run k install)`]);
    else if (r.kase === 'remove') out.push([false, `${head} autoCompactWindow ${r.v} in ${r.file} is kirunak's, and compact.enabled is false (run k install)`]);
    else {
      const s = says(r, facts);
      out.push([!s.fail, `${head} ${s.line}`]);
    }
    out.push(...besides(r, facts.wanted).map((line) => [false, `${head} ${line}`]));
  }
  return out;
}

import { strict as assert } from 'node:assert';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPACT } from '../../../lib/compact.mjs';
import { install } from '../../../lib/install.mjs';
import { DEFAULT_HOOK, DEFAULT_LADDER } from '../../../lib/ladder.mjs';
import { FIXTURES, gitCommitAll, gitInit, KIRUNAK } from '../../helpers.mjs';

// The scratch workspace k install's and k doctor's compact tests share (orchestrator.md §5, R8.2, R8.3).

// This machine's own git excludes stay out: a scratch global config whose excludes file is empty.
const GIT = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-compact-git-')));
writeFileSync(join(GIT, 'ignore'), '');
writeFileSync(join(GIT, 'gitconfig'), `[core]\n\texcludesFile = ${join(GIT, 'ignore')}\n`);
process.env.GIT_CONFIG_GLOBAL = join(GIT, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

export const LOCAL = ['.claude', 'settings.local.json'];
export const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
export const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const put = (p, x) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n');
};

// Two scratch repos (weather, hub), a user file with the owner's 500000, the hooks wired once before any case, so the
// user file's bytes are known: { ..., go(opts) → actions, local(name), user() }.
export function setup({ compact = {}, repos = null, user = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-compact-install-')));
  const root = (name) => {
    const r = join(dir, name);
    mkdirSync(r);
    gitInit(r);
    writeFileSync(join(r, 'README'), `${name}\n`);
    gitCommitAll(r);
    return r;
  };
  const weather = root('weather');
  const hub = root('hub');
  const paths = { settingsPath: join(dir, 'user', 'settings.json'), kirunakRoot: KIRUNAK, skillsDir: join(dir, 'skills'), agentsDir: join(dir, 'agents'), home: join(dir, 'state') };
  put(paths.settingsPath, { autoCompactWindow: 500000, modelSettings: { opus: { autoCompactWindow: 400000 } }, ...user });
  install({ ...paths, ws: null });
  const ws = {
    ladder: DEFAULT_LADDER, hook: { ...DEFAULT_HOOK }, modulePath: join(hub, 'kirunak', 'workspace.mjs'), home: paths.home,
    repos: repos ?? [{ name: 'weather', root: weather }, { name: 'hub', root: hub }], compact: { ...DEFAULT_COMPACT, ...compact },
  };
  const before = readFileSync(paths.settingsPath);
  const go = (opts = {}) => {
    const { actions } = install({ ...paths, ws, ...opts });
    assert.ok(readFileSync(paths.settingsPath).equals(before), 'the user\'s file is byte-identical');
    return actions;
  };
  return { dir, weather, hub, ws, paths, go, local: (r) => join(r, ...LOCAL) };
}

// A task in weather whose plan runs S-1 on opus and S-2, S-3 on sonnet, with the given progress.md, for the variable
// k run sets inside a step (R7.4): → (step, value) the environment such a step runs with.
const STEP_PLAN = ['### S-1 Build [agent, opus]', '### S-2 Test [agent, sonnet]', '### S-3 Docs [agent, sonnet]']
  .map((h, i) => `${h}\ncovers: all\ninputs: task\noutputs: steps/S-${i + 1}/report.md\n`).join('\n');
export function stepTask(s, progress = '') {
  const dir = join(s.weather, 'kirunak', 'tasks', 'offline-forecast');
  cpSync(join(FIXTURES, 'workspace', 'weather', 'kirunak', 'tasks', 'offline-forecast'), dir, { recursive: true });
  put(join(dir, 'plan.md'), STEP_PLAN);
  put(join(dir, 'progress.md'), progress);
  return (step, value) => ({ KIRUNAK_TASK: 'weather/offline-forecast', KIRUNAK_STEP: step, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(value) });
}

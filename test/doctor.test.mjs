import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { frontmatter, ladderChecks } from '../lib/doctor.mjs';
import { install } from '../lib/install.mjs';
import { k, KIRUNAK, ladderWorkspace } from './helpers.mjs';

// gulnya/enforced-escalation S-2 design R6.4: k doctor's lines on the ladder, its agents, settings.json's
// modelSettings, the escalation hook's wiring, its config.json and its switches.

// A workspace with the given keys, k installed for it into temp settings and agents folders.
async function installed(extra = {}) {
  const w = await ladderWorkspace(extra);
  const paths = { settingsPath: join(w.dir, 'settings.json'), agentsDir: join(w.dir, 'agents'), skillsDir: join(w.dir, 'skills') };
  install({ ...paths, kirunakRoot: KIRUNAK, home: w.home, ws: w.ws });
  const check = (ws = w.ws) => ladderChecks({ ws, settingsPath: paths.settingsPath, agentsDir: paths.agentsDir });
  const fails = (ws) => check(ws).filter(([ok]) => !ok).map(([, line]) => line);
  const settings = (change) => {
    const json = JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
    change(json);
    writeFileSync(paths.settingsPath, JSON.stringify(json, null, 2));
  };
  return { ...w, ...paths, check, fails, settings };
}

test('after k install every ladder line is ok, the ladder first', async () => {
  const w = await installed();
  const lines = w.check();
  assert.deepEqual(lines.filter(([ok]) => !ok), []);
  assert.deepEqual(lines.map(([, l]) => l), [
    'ladder: sonnet → opus (high, build) → fable (high, design)',
    `rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')}, opus, high`,
    `rung agent fable-step: ${join(w.agentsDir, 'fable-step.md')}, fable, high`,
    'escalation hook: wired on 7 events',
    'escalate/config.json matches the workspace',
  ]);
});

test('a rung agent missing, of another family or at another effort FAILs, naming k install', async () => {
  const w = await installed();
  rmSync(join(w.agentsDir, 'opus-step.md'));
  const fable = join(w.agentsDir, 'fable-step.md');
  writeFileSync(fable, readFileSync(fable, 'utf8').replace('effort: high', 'effort: xhigh'));
  assert.deepEqual(w.fails(), [
    `rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')} is missing (run k install)`,
    `rung agent fable-step: ${fable}, fable, xhigh: the ladder says high (run k install)`,
  ]);
  writeFileSync(fable, readFileSync(fable, 'utf8').replace('model: fable', 'model: claude-opus-5-5'));
  assert.ok(w.fails().includes(`rung agent fable-step: ${fable}, claude-opus-5-5, xhigh: its model is not of the fable family (run k install)`));
});

test('the workspace\'s own agents on a rung are checked the same, through a link, and fixed by hand', async () => {
  const ladder = [{ model: 'sonnet' }, { model: 'opus', effort: 'high' }, { model: 'fable', id: 'claude-fable-5-1', effort: 'high', mode: 'design', agents: ['music-deep'] }];
  const w = await installed({ ladder });
  const path = join(w.agentsDir, 'music-deep.md');
  assert.ok(w.fails().includes(`rung agent music-deep (the workspace's own): ${path} is missing (write it, or take it off the fable rung's agents)`));
  const repo = join(w.dir, 'portfolio');
  mkdirSync(repo);
  writeFileSync(join(repo, 'music-deep.md'), '---\nname: music-deep\nmodel: claude-fable-5-1\neffort: xhigh\ntools: "*"\n---\nMusic.\n');
  symlinkSync(join(repo, 'music-deep.md'), path);
  const real = realpathSync(path);
  assert.deepEqual(w.fails(), [`rung agent music-deep (the workspace's own): ${path} → ${real}, claude-fable-5-1, xhigh: the ladder says high (set it in ${real})`]);
  writeFileSync(real, readFileSync(real, 'utf8').replace('xhigh', 'high'));
  assert.deepEqual(w.fails(), []);
  assert.ok(w.check().some(([ok, l]) => ok && l === `rung agent fable-step: ${join(w.agentsDir, 'fable-step.md')}, claude-fable-5-1, high`));
});

test('modelSettings: Opus at xhigh disagrees with the rung at high, and any effort for Fable FAILs (AC-19, AC-20)', async () => {
  const w = await installed();
  w.settings((json) => {
    json.modelSettings = { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'high' } };
  });
  assert.deepEqual(w.fails(), [
    'settings.json modelSettings claude-opus-5-5: effortLevel xhigh disagrees with the opus rung (high): remove it, or set the rung\'s effort to xhigh',
    'settings.json modelSettings claude-fable-5-1: effortLevel high, but settings name no effort for fable: remove it',
  ]);
});

test('modelSettings: an entry at the rung\'s effort is ok; one of no rung\'s family, or naming no effort, says nothing', async () => {
  const w = await installed();
  w.settings((json) => {
    json.modelSettings = { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-haiku-4-5': { effortLevel: 'low' }, 'claude-fable-5-1': {} };
  });
  const lines = w.check().filter(([, l]) => l.startsWith('settings.json'));
  assert.deepEqual(lines, [[true, 'settings.json modelSettings claude-opus-5-5: effortLevel high, as the opus rung']]);
});

test('the escalation hook not wired, or wired with the matcher of another ladder, FAILs naming the events', async () => {
  const w = await installed();
  const was = readFileSync(w.settingsPath, 'utf8');
  w.settings((json) => {
    delete json.hooks.UserPromptExpansion;
    delete json.hooks.PostModelSwitch;
  });
  assert.deepEqual(w.fails(), ['escalation hook: not wired on UserPromptExpansion, PostModelSwitch (run k install)']);
  writeFileSync(w.settingsPath, was);
  const { ws } = await ladderWorkspace({ ladder: [{ model: 'sonnet' }, { model: 'opus', effort: 'high' }] });
  ws.home = w.home;
  assert.ok(w.fails(ws).includes('escalation hook: not wired on SubagentStop (matcher opus-step|fable-step, the ladder\'s opus-step) (run k install)'));
  writeFileSync(w.settingsPath, '{}');
  assert.match(w.fails().find((l) => l.startsWith('escalation hook')), /not wired on PostToolUseFailure, PostToolUse, SubagentStop, UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch/);
});

test('config.json missing, disagreeing with the workspace, or older than its module FAILs', async () => {
  const w = await installed();
  const path = join(w.home, 'escalate', 'config.json');
  const was = readFileSync(path, 'utf8');
  const line = (ws) => w.check(ws).find(([, l]) => l.startsWith('escalate/config.json'));
  rmSync(path);
  assert.deepEqual(line(), [false, `escalate/config.json: ${path} is missing or not JSON (run k install)`]);
  writeFileSync(path, was.replace('"repeats": 2', '"repeats": 3'));
  assert.deepEqual(line(), [false, 'escalate/config.json disagrees with the workspace (run k install)']);
  writeFileSync(path, was);
  const later = new Date(Date.now() + 60_000);
  utimesSync(w.modulePath, later, later);
  assert.deepEqual(line(), [false, `escalate/config.json is older than ${w.modulePath} (run k install)`]);
});

test('the hook off and the block off are FAIL lines, so k doctor says when either is off (AC-29)', async () => {
  const w = await installed({ hook: { enabled: false, block: false } });
  assert.deepEqual(w.fails(), [`hook off (hook.enabled: false in ${w.modulePath})`, `block off (hook.block: false in ${w.modulePath})`]);
});

test('a workspace still naming models.escalate gets the FAIL line of R1.4', async () => {
  const w = await installed({ models: { escalate: { model: 'fable', effort: 'xhigh' } } });
  assert.deepEqual(w.fails(), [`models.escalate is no longer read: the ladder's rungs replace it; remove it from ${w.modulePath}`]);
});

test('frontmatter reads the key: value lines, quotes off, and nothing past the closing line', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "x: y"\nmodel: claude-opus-5-5\nexperimental:\n  cacheTtl: 1h\n---\nmodel: no\n'),
    { name: 'a', description: 'x: y', model: 'claude-opus-5-5' });
  assert.deepEqual(frontmatter('no front matter\n'), {});
});

test('k doctor --settings --agents prints the ladder lines', async () => {
  const w = await installed({ models: { escalate: { model: 'fable' } } });
  writeFileSync(join(w.home, 'workspace'), w.modulePath + '\n');
  const r = k(w.home, ['doctor', '--settings', w.settingsPath, '--agents', w.agentsDir]);
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /^ok {3}ladder: sonnet → opus \(high, build\) → fable \(high, design\)$/m);
  assert.ok(out.includes(`ok   rung agent opus-step: ${join(w.agentsDir, 'opus-step.md')}, opus, high`));
  assert.match(out, /^ok {3}escalation hook: wired on 7 events$/m);
  assert.match(out, /^ok {3}hook kirunak-escalate\.mjs$/m);
  assert.match(out, /^FAIL models\.escalate is no longer read/m);
});

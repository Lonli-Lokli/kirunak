import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  above, agentsOf, attemptsOf, buildRungFor, checkLadder, DEFAULT_HOOK, DEFAULT_LADDER, describeLadder, familyOf, modeOf, rungOf,
} from '../lib/ladder.mjs';
import { escalateConfig, install } from '../lib/install.mjs';
import { ladderWorkspace } from './helpers.mjs';

// gulnya/enforced-escalation S-2 design §1: the ladder's shape, its refusals at load, and the rules that read it.

const FABLE = { model: 'fable', id: 'claude-fable-5-1', effort: 'high', mode: 'design', agents: ['music-deep'], cacheTtl: '1h' };
const GULNYA = [{ model: 'sonnet' }, { model: 'opus', effort: 'high', mode: 'build' }, FABLE];
// E-18: Haiku at the bottom, and nothing in the code names a model.
const HAIKU = [{ model: 'haiku' }, { model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high', mode: 'design' }];

test('a workspace that names no ladder gets the default: Sonnet, Opus building at high, Fable designing at high', async () => {
  const { ws } = await ladderWorkspace();
  assert.deepEqual(ws.ladder, [
    { model: 'sonnet' },
    { model: 'opus', effort: 'high', mode: 'build', attempts: 1 },
    { model: 'fable', effort: 'high', mode: 'design', attempts: 1 },
  ]);
  assert.equal(ws.ladder, DEFAULT_LADDER);
  assert.deepEqual(ws.hook, { enabled: true, block: true, repeats: 2, commands: [] });
  assert.equal(describeLadder(ws.ladder), 'sonnet → opus (high, build) → fable (high, design)');
  assert.deepEqual(checkLadder(DEFAULT_LADDER), []);
});

test('a workspace\'s ladder replaces the default whole; its hook switches are merged over the defaults', async () => {
  const { ws } = await ladderWorkspace({ ladder: HAIKU, hook: { block: false } });
  assert.deepEqual(ws.ladder, HAIKU);
  assert.deepEqual(ws.hook, { ...DEFAULT_HOOK, block: false });
  assert.deepEqual(checkLadder(GULNYA), []);
  assert.deepEqual(checkLadder(HAIKU), []);
});

test('a workspace that still names models.escalate loads (k doctor names it)', async () => {
  const { ws } = await ladderWorkspace({ models: { agent: { model: 'opus' }, escalate: { model: 'fable', effort: 'xhigh' } } });
  assert.deepEqual(ws.models.escalate, { model: 'fable', effort: 'xhigh' });
  assert.equal(ws.ladder, DEFAULT_LADDER);
});

test('a bad ladder refuses the workspace at load, naming the module and every problem', async () => {
  await assert.rejects(ladderWorkspace({ ladder: [{ model: 'sonnet', mode: 'build' }, { model: 'opus', effort: 'huge' }] }), (e) => {
    assert.equal(e.code, 1);
    assert.match(e.message, /workspace\.mjs: its ladder: rung 1 is the lowest: it names no mode/);
    assert.match(e.message, /rung 2: unknown effort "huge"; the levels are low, medium, high, xhigh, max/);
    return true;
  });
});

test('refused: a ladder that is not a non-empty list, or a rung that is not an object', () => {
  for (const bad of [undefined, null, {}, 'sonnet', []]) {
    assert.deepEqual(checkLadder(bad), ['the ladder must be a non-empty list of rungs, lowest first']);
  }
  assert.match(checkLadder([{ model: 'sonnet' }, 'opus'])[0], /^rung 2 is not an object/);
});

test('refused: a rung without a model alias, or one that repeats a model', () => {
  assert.match(checkLadder([{ effort: 'high' }])[0], /^rung 1 needs a model alias .*not undefined/);
  assert.match(checkLadder([{ model: 'Claude Opus' }])[0], /^rung 1 needs a model alias/);
  assert.match(checkLadder([{ model: 'claude-opus-5-5' }])[0], /^rung 1 needs a model alias/);
  assert.deepEqual(checkLadder([{ model: 'sonnet' }, { model: 'opus' }, { model: 'opus' }]), ['rung 3 repeats the model opus']);
});

test('refused: an id of another family than the rung\'s model', () => {
  assert.deepEqual(checkLadder([{ model: 'sonnet' }, { model: 'opus', id: 'claude-opus-5-5' }]), []);
  assert.deepEqual(checkLadder([{ model: 'sonnet' }, { model: 'opus', id: 'claude-fable-5-1' }]),
    ['rung 2: id "claude-fable-5-1" is not of the opus family (claude-opus-…)']);
  assert.match(checkLadder([{ model: 'sonnet', id: 7 }])[0], /^rung 1: id 7 is not of the sonnet family/);
});

test('refused: an unknown effort, a mode other than build or design, attempts not a whole number of 1 or more', () => {
  const top = (r) => checkLadder([{ model: 'sonnet' }, { model: 'opus', ...r }]);
  assert.match(top({ effort: 'extreme' })[0], /^rung 2: unknown effort "extreme"/);
  assert.match(top({ mode: 'review' })[0], /^rung 2: mode must be build or design, not "review"/);
  for (const attempts of [0, -1, 1.5, '2']) assert.match(top({ attempts })[0], /^rung 2: attempts must be a whole number of 1 or more/);
  assert.deepEqual(top({ effort: 'max', mode: 'design', attempts: 3 }), []);
});

test('refused: the lowest rung naming mode, attempts or agents (its two attempts are k run\'s)', () => {
  assert.deepEqual(checkLadder([{ model: 'sonnet', mode: 'build', attempts: 2, agents: ['x'] }]),
    ['rung 1 is the lowest: it names no mode, attempts, agents (the step\'s own two attempts are k run\'s)']);
  assert.deepEqual(checkLadder([{ model: 'sonnet', effort: 'medium' }]), [], 'its effort is allowed');
});

test('refused: a design rung directly above another; a design rung above a build rung is fine', () => {
  const ladder = [{ model: 'haiku' }, { model: 'sonnet', mode: 'design' }, { model: 'opus', mode: 'design' }];
  assert.deepEqual(checkLadder(ladder), ['rung 3 designs, and so does the rung below it: a design needs a build rung directly below it']);
  assert.deepEqual(checkLadder([{ model: 'haiku' }, { model: 'sonnet', mode: 'design' }, { model: 'opus' }]), []);
});

test('refused: agents that are not names, a cacheTtl other than 5m or 1h', () => {
  const top = (r) => checkLadder([{ model: 'sonnet' }, { model: 'opus', ...r }]);
  assert.deepEqual(top({ agents: ['music-deep', 'a_b2'], cacheTtl: '1h' }), []);
  for (const agents of ['music-deep', ['music deep'], ['../x'], [3]]) assert.match(top({ agents })[0], /^rung 2: agents must be a list of agent names/);
  assert.match(top({ cacheTtl: '30m' })[0], /^rung 2: cacheTtl must be 5m or 1h, not "30m"/);
});

test('familyOf: the word after claude-, the alias itself, a context suffix left off', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-fable-5-1[1m]'), 'fable');
  assert.equal(familyOf('Sonnet'), 'sonnet');
  assert.equal(familyOf(undefined), '');
});

test('rungOf: by alias, by the rung\'s pinned id, and by an id\'s family; null for a model on no rung', () => {
  assert.equal(rungOf(GULNYA, 'opus'), GULNYA[1]);
  assert.equal(rungOf(GULNYA, 'claude-fable-5-1'), GULNYA[2]);
  assert.equal(rungOf(GULNYA, 'claude-fable-6-0'), GULNYA[2], 'another id of the family');
  assert.equal(rungOf(GULNYA, 'claude-sonnet-4-6'), GULNYA[0]);
  assert.equal(rungOf(GULNYA, 'claude-haiku-4-5'), null);
  assert.equal(rungOf(GULNYA, ''), null);
  const pinned = [{ model: 'sonnet' }, { model: 'opus', id: 'claude-opus-5-5' }];
  assert.equal(rungOf(pinned, 'claude-opus-5-5'), pinned[1]);
});

test('above: the next rung up, by rung or by alias; null at the top and for a model on no rung', () => {
  assert.equal(above(DEFAULT_LADDER, DEFAULT_LADDER[0]), DEFAULT_LADDER[1]);
  assert.equal(above(DEFAULT_LADDER, 'opus'), DEFAULT_LADDER[2]);
  assert.equal(above(DEFAULT_LADDER, 'fable'), null);
  assert.equal(above(DEFAULT_LADDER, 'haiku'), null);
});

test('agentsOf: none on the lowest; the generated <model>-step, then the workspace\'s own', () => {
  assert.deepEqual(agentsOf(GULNYA, GULNYA[0]), []);
  assert.deepEqual(agentsOf(GULNYA, 'opus'), ['opus-step']);
  assert.deepEqual(agentsOf(GULNYA, FABLE), ['fable-step', 'music-deep']);
  assert.deepEqual(agentsOf(GULNYA, 'haiku'), []);
});

test('buildRungFor: a build rung builds itself; a design rung\'s build run is the rung directly below', () => {
  assert.equal(buildRungFor(DEFAULT_LADDER, 'opus'), DEFAULT_LADDER[1]);
  assert.equal(buildRungFor(DEFAULT_LADDER, 'fable'), DEFAULT_LADDER[1], 'Fable designs, a fresh Opus run builds (AC-4)');
  assert.equal(buildRungFor(HAIKU, 'opus'), HAIKU[1]);
  const low = [{ model: 'sonnet' }, { model: 'opus', mode: 'design' }];
  assert.equal(buildRungFor(low, 'opus'), low[0], 'a design rung just above the lowest is built on the lowest');
  assert.equal(buildRungFor(low, 'haiku'), null);
});

test('modes and attempts default to build and 1; k doctor\'s line names attempts above 1', () => {
  assert.equal(modeOf({ model: 'opus' }), 'build');
  assert.equal(attemptsOf({ model: 'opus' }), 1);
  assert.equal(describeLadder([{ model: 'haiku', effort: 'low' }, { model: 'sonnet', attempts: 2 }]), 'haiku (low) → sonnet (build, 2 attempts)');
});

test('E-18: Haiku at the bottom makes sonnet-step and opus-step, and a failed Haiku step climbs to Sonnet', () => {
  assert.equal(above(HAIKU, rungOf(HAIKU, 'claude-haiku-4-5')).model, 'sonnet');
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-e18-'));
  const agentsDir = join(dir, 'agents');
  install({ settingsPath: join(dir, 'settings.json'), skillsDir: join(dir, 'skills'), agentsDir, kirunakRoot: dir, home: join(dir, 'state'), ws: { ladder: HAIKU } });
  assert.ok(!existsSync(join(agentsDir, 'haiku-step.md')));
  assert.match(readFileSync(join(agentsDir, 'sonnet-step.md'), 'utf8'), /^name: sonnet-step\nd.*One rung up from haiku.*\nmodel: sonnet\neffort: high\n/m);
  assert.match(readFileSync(join(agentsDir, 'opus-step.md'), 'utf8'), /^model: opus\neffort: high\n[\s\S]*Design and review only/m);
  assert.deepEqual(escalateConfig({ ladder: HAIKU }).ladder.map((r) => r.agents), [[], ['sonnet-step'], ['opus-step']]);
});

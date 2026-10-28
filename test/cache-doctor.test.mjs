import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cacheChecks } from '../lib/doctor.mjs';
import { ladderWorkspace } from './helpers.mjs';

// gulnya/k-usage AC-5, D-6, E-2: k doctor's cache lines, one per key the workspace's `cache` block names.

async function checked(cache, settings) {
  const w = await ladderWorkspace(cache === undefined ? {} : { cache });
  const settingsPath = join(w.dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { ...w, settingsPath, lines: cacheChecks({ ws: w.ws, settingsPath }) };
}

test('a key equal to the workspace\'s is ok, and a key not named gets no line', async () => {
  const w = await checked({ promptCacheTtl: '1h', syncClaudeAiSkills: false }, { promptCacheTtl: '1h', syncClaudeAiSkills: false, subagentPromptCacheTtl: '5m' });
  assert.deepEqual(w.lines, [
    [true, 'settings.json promptCacheTtl: "1h", as the workspace\'s cache'],
    [true, 'settings.json syncClaudeAiSkills: false, as the workspace\'s cache'],
  ]);
});

test('a different value, or one missing, fails naming both', async () => {
  const w = await checked({ promptCacheTtl: '1h', syncClaudeAiSkills: false }, { promptCacheTtl: '5m' });
  assert.deepEqual(w.lines, [
    [false, `settings.json promptCacheTtl: "5m", but ${w.modulePath} wants "1h": set it in ${w.settingsPath}`],
    [false, `settings.json syncClaudeAiSkills: absent, but ${w.modulePath} wants false: set it in ${w.settingsPath}`],
  ]);
});

test('null wants the key absent: ok when absent, a failure naming the value when present', async () => {
  const absent = await checked({ subagentPromptCacheTtl: null }, { promptCacheTtl: '1h' });
  assert.deepEqual(absent.lines, [[true, 'settings.json subagentPromptCacheTtl: absent, as the workspace\'s cache wants']]);
  const present = await checked({ subagentPromptCacheTtl: null }, { subagentPromptCacheTtl: '1h' });
  assert.deepEqual(present.lines, [[false,
    `settings.json subagentPromptCacheTtl: "1h", but ${present.modulePath} wants it absent: remove it from ${present.settingsPath}`]]);
});

test('no cache block, or an empty one, gets no line (E-2)', async () => {
  assert.deepEqual((await checked(undefined, { promptCacheTtl: '1h' })).lines, []);
  assert.deepEqual((await checked({}, { promptCacheTtl: '1h' })).lines, []);
});

test('a wrong type or an unknown key in the cache block is refused', async () => {
  for (const [cache, why] of [
    [{ promptCacheTtl: 60 }, /cache\.promptCacheTtl must be a non-empty string or null/],
    [{ syncClaudeAiSkills: 'no' }, /cache\.syncClaudeAiSkills must be a boolean or null/],
    [{ autoCompactWindow: 500000 }, /cache\.autoCompactWindow is not a key kirunak checks/],
    [['1h'], /cache must be an object/],
  ]) await assert.rejects(ladderWorkspace({ cache }), (e) => why.test(e.message), JSON.stringify(cache));
});

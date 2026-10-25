import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as steps from '../lib/steps.mjs';
import { approvedWorkspace } from './helpers.mjs';

// A k run step's climb up the ladder (gulnya/enforced-escalation, S-2 design R2.2, R2.6, R2.7), driven through
// steps.start, fail, climb and escalate as k run drives them, on kirunak's default ladder: sonnet, opus (high,
// build), fable (high, design).

const plan = (bracket, extra = '') => `---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [${bracket}]
covers: AC-1, AC-2, E-1, D-1
inputs: task, docs/offline.md
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv
${extra}
### S-2 Review [review]
needs: S-1
covers: all
inputs: task, diff, evidence/
outputs: review.md
`;

const put = (w, rel, text = 'x') => {
  mkdirSync(join(w.p.dir, rel, '..'), { recursive: true });
  writeFileSync(join(w.p.dir, rel), text);
};
const progress = (w) => readFileSync(join(w.p.dir, 'progress.md'), 'utf8');
const state = (w) => steps.load(w.ws, w.id).states.get('S-1');
// Where the step stands: its state, the rung its next attempt runs on (null: its own) and that attempt's phase.
const where = (w) => {
  const s = state(w);
  return [s.state, s.retry?.rung?.model ?? null, s.retry?.phase ?? null];
};
const fail = async (w, why = 'the cache test does not build') => {
  await steps.start({ ws: w.ws, id: w.id, step: 'S-1' });
  return steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why });
};
// A run noted by hand, for the kinds k step start asks more of (a review's session and inputs).
const noteFail = (w) => (steps.note(w.p, 'S-1', 'started (by hand)'), steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'exit 1' }));
const climb = (w) => steps.climb({ ws: w.ws, id: w.id, step: 'S-1' });
const reports = (n) => Array.from({ length: n }, (_, i) => `steps/S-1/failure-${i + 1}.md`);

test('a Sonnet step: sonnet twice, opus building, fable designing, then the stop; a stop between attempts never counts (E-3)', async () => {
  const w = await approvedWorkspace(plan('agent, sonnet'));
  assert.deepEqual(where(w), ['ready', null, null]);
  await fail(w);
  assert.deepEqual(where(w), ['ready', null, 'build']);
  await fail(w);
  assert.deepEqual([...where(w), state(w).why], ['failed', null, null, 'failed 2 times']);
  await assert.rejects(steps.start({ ws: w.ws, id: w.id, step: 'S-1' }), /S-1 is failed: failed 2 times/, 'a failed step does not start');
  const up = climb(w);
  assert.deepEqual([up.to.model, up.from, up.failures], ['opus', 'sonnet', 2]);
  assert.match(progress(w), /S-1 escalated: to opus \(high, build\) after 2 failures on sonnet\n$/);
  assert.deepEqual(where(w), ['ready', 'opus', 'build']);
  assert.deepEqual(state(w).retry.reports, reports(2), 'a rung attempt reads every report');
  // Stopped on Opus: not a failure of its own, so Opus still has its one attempt.
  await fail(w, steps.STOPPED.bySignal('SIGTERM'));
  assert.deepEqual(where(w), ['ready', 'opus', 'build']);
  await fail(w);
  assert.deepEqual([...where(w), state(w).why], ['failed', null, null, 'failed 1 time on opus']);
  assert.equal(climb(w).to.model, 'fable');
  assert.match(progress(w), /S-1 escalated: to fable \(high, design\) after 1 failure on opus\n$/);
  assert.deepEqual(where(w), ['ready', 'fable', 'design']);
  assert.deepEqual(state(w).retry.reports, reports(3));
  // The design attempt is two runs, one attempt: its design run, then a fresh Opus build run, then one failure.
  steps.note(w.p, 'S-1', 'started (fable high, session d-1, rung fable design)');
  put(w, 'steps/S-1/design-1.md');
  steps.note(w.p, 'S-1', 'started (opus high, session b-1, rung fable build on opus high)');
  assert.equal(steps.fail({ ws: w.ws, id: w.id, step: 'S-1', why: 'the build from the design fails' }).failures, 1);
  assert.equal(state(w).state, 'failed');
  assert.deepEqual(climb(w), { to: null, from: 'fable', failures: 1 });
  const e = steps.escalate({ ws: w.ws, id: w.id, step: 'S-1' });
  assert.deepEqual(e, { failures: reports(4), last: 'steps/S-1/failure-4.md', why: 'failed on every rung (sonnet 2, opus 1, fable 1)' });
  assert.match(readFileSync(join(w.p.dir, 'plan.md'), 'utf8'), /^### S-1 .* \[agent, sonnet\] \[escalate\]\n(?:.+\n)*failures: steps\/S-1\/failure-1\.md, steps\/S-1\/failure-2\.md, steps\/S-1\/failure-3\.md, steps\/S-1\/failure-4\.md\n/m);
  assert.equal(state(w).state, 'escalated');
});

test('an Opus step: opus twice, then fable designing, then the stop; a Fable step: fable twice, then the stop', async () => {
  const o = await approvedWorkspace(plan('agent, opus, high'));
  await fail(o);
  await fail(o);
  assert.deepEqual([climb(o).to.model, where(o)], ['fable', ['ready', 'fable', 'design']]);
  assert.match(progress(o), /S-1 escalated: to fable \(high, design\) after 2 failures on opus\n$/);
  await fail(o);
  assert.equal(climb(o).to, null);
  assert.equal(steps.escalate({ ws: o.ws, id: o.id, step: 'S-1' }).why, 'failed on every rung (opus 2, fable 1)');

  const f = await approvedWorkspace(plan('agent, fable'));
  await fail(f);
  assert.deepEqual(where(f), ['ready', null, 'build']);
  await fail(f);
  const before = progress(f);
  assert.deepEqual(climb(f), { to: null, from: 'fable', failures: 2 });
  assert.equal(progress(f), before, 'past the top a climb writes nothing');
  assert.equal(steps.escalate({ ws: f.ws, id: f.id, step: 'S-1' }).why, 'failed on every rung (fable 2)');
});

test('the model a step ran on: the newest run record\'s when the plan and models.<kind> name none; a model on no rung climbs from the lowest', async () => {
  const w = await approvedWorkspace(plan('agent'));
  const usage = (input) => ({ inputTokens: input, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  put(w, 'steps/S-1/run-1.json', JSON.stringify({ session_id: 'a', modelUsage: { 'claude-sonnet-4-5': usage(9e6) }, kirunak: { result: true } }));
  put(w, 'steps/S-1/run-2.json', JSON.stringify({ session_id: 'b', modelUsage: { 'claude-opus-5-5': usage(5000), 'claude-haiku-4-5': usage(20) }, kirunak: { result: true } }));
  put(w, 'steps/S-1/run-3.json', JSON.stringify({ session_id: 'c', kirunak: { result: false } }));
  assert.equal(steps.ranOn(w.ws, w.p, steps.load(w.ws, w.id).plan.steps[0]).model, 'opus', 'run-3 has no result; run-2 is mostly Opus');
  await fail(w);
  await fail(w);
  assert.equal(climb(w).to.model, 'fable');
  assert.match(progress(w), /S-1 escalated: to fable \(high, design\) after 2 failures on opus\n$/);
  // models.<kind> comes before the record.
  w.ws.models = { agent: { model: 'sonnet' } };
  assert.equal(steps.ranOn(w.ws, w.p, steps.load(w.ws, w.id).plan.steps[0]).model, 'sonnet');

  const h = await approvedWorkspace(plan('agent, haiku'));
  assert.deepEqual(steps.ranOn(h.ws, h.p, steps.load(h.ws, h.id).plan.steps[0]), { model: 'haiku', rung: h.ws.ladder[0], onRung: false });
  await fail(h);
  await fail(h);
  assert.equal(climb(h).to.model, 'opus');
  assert.match(progress(h), /S-1 escalated: to opus \(high, build\) after 2 failures on haiku \(model haiku is on no rung\)\n$/);
});

test('a rung\'s attempts are the workspace\'s (AC-5); a review climbs in build mode; a heavy step stops after two with no rung', async () => {
  const w = await approvedWorkspace(plan('agent, sonnet'));
  w.ws.ladder = [{ model: 'sonnet' }, { model: 'opus', effort: 'high', mode: 'build', attempts: 2 }, { model: 'fable', effort: 'high', mode: 'design', attempts: 1 }];
  await fail(w);
  await fail(w);
  climb(w);
  await fail(w);
  assert.deepEqual(where(w), ['ready', 'opus', 'build'], 'Opus has a second attempt');
  await fail(w);
  assert.equal(state(w).state, 'failed');

  const r = await approvedWorkspace(plan('review, opus'));
  noteFail(r);
  noteFail(r);
  assert.equal(climb(r).to.model, 'fable');
  assert.match(progress(r), /S-1 escalated: to fable \(high, build\) after 2 failures on opus\n$/);
  assert.deepEqual(where(r), ['ready', 'fable', 'build']);

  const hv = await approvedWorkspace(plan('heavy', 'command: npm test\n'));
  noteFail(hv);
  noteFail(hv);
  assert.equal(state(hv).state, 'failed');
  assert.deepEqual(climb(hv), { to: null, from: null, failures: 2 });
  assert.equal(steps.escalate({ ws: hv.ws, id: hv.id, step: 'S-1' }).why, 'failed 2 times');
});

test('historyOf: the rung of the last climb, a design attempt counted once, stops never, and any other escalated line starts afresh', () => {
  const at = (lines) => lines.map((l, i) => `2026-11-03 1${i % 10}:00 S-1 ${l}`).join('\n') + '\n';
  const climbed = at([
    'started (default model, session a)', 'failed: exit 1', 'started (default model, session b)', 'failed: exit 1',
    'escalated: to opus (high, build) after 2 failures on sonnet', 'started (opus high, session c, rung opus)', 'failed: exit 1',
    'escalated: to fable (high, design) after 1 failure on opus',
    'started (fable high, session d, rung fable design)', 'started (opus high, session e, rung fable build on opus high)',
    `failed: ${steps.STOPPED.bySignal('SIGINT')}`,
  ]);
  const h = steps.historyOf(climbed, 'S-1');
  assert.deepEqual(h, {
    last: 'failed', failures: 0, stopped: true, rung: 'fable', total: 3, building: true,
    climbs: [{ to: 'opus', after: 2, from: 'sonnet' }, { to: 'fable', after: 1, from: 'opus' }],
  });
  // The build run's failure ends the attempt: one failure, the design run's start not another.
  const failed = steps.historyOf(`${climbed}2026-11-03 12:00 S-1 started (opus high, session f, rung fable build on opus high)\n2026-11-03 12:30 S-1 failed: exit 1\n`, 'S-1');
  assert.deepEqual([failed.failures, failed.total, failed.building], [1, 4, false]);
  // An old plan's escalated line, or a stop's, starts the count afresh on the step's own rung.
  for (const old of ['escalated', 'escalated: opus, xhigh', 'escalated: stopped for the owner, failed on every rung (sonnet 2, opus 1, fable 1)']) {
    const after = steps.historyOf(`${climbed}2026-11-03 13:00 S-1 ${old}\n`, 'S-1');
    assert.deepEqual([after.rung, after.failures, after.total, after.climbs], [null, 0, 0, []], old);
  }
  assert.deepEqual(steps.historyOf(climbed.replaceAll('S-1 ', 'S-10 '), 'S-1').last, null, 'S-10 is not S-1');
});

test('an old plan\'s [escalate: fable, xhigh] still means stopped; after a stopped build run the design attempt resumes at its build', async () => {
  const w = await approvedWorkspace(plan('agent, sonnet'));
  writeFileSync(join(w.p.dir, 'plan.md'), plan('agent, sonnet').replace('[agent, sonnet]', '[agent, sonnet] [escalate: fable, xhigh]'));
  steps.note(w.p, 'S-1', 'failed: exit 1');
  steps.note(w.p, 'S-1', 'failed: exit 1');
  steps.note(w.p, 'S-1', 'escalated: fable, xhigh');
  assert.equal(state(w).state, 'escalated');

  const d = await approvedWorkspace(plan('agent, opus'));
  await fail(d);
  await fail(d);
  climb(d);
  steps.note(d.p, 'S-1', 'started (fable high, session d-1, rung fable design)');
  put(d, 'steps/S-1/design-1.md');
  put(d, 'steps/S-1/design-2.md');
  steps.note(d.p, 'S-1', 'started (opus high, session b-1, rung fable build on opus high)');
  steps.fail({ ws: d.ws, id: d.id, step: 'S-1', why: steps.STOPPED.orphan });
  assert.deepEqual(state(d).retry, { reports: reports(2), rung: d.ws.ladder[2], phase: 'build', design: 'steps/S-1/design-2.md' });
});

test('the briefs: the own retry names its report in the inputs; a rung attempt lists every report in order; a build after a design reads the design first; a design run writes design-<k>.md', async () => {
  const w = await approvedWorkspace(plan('agent, sonnet'));
  const rel = (f) => `kirunak/tasks/offline-forecast/steps/S-1/${f}`;
  const brief = (retry) => steps.brief({ ws: w.ws, id: w.id, step: 'S-1', retry });
  await fail(w);
  const own = (await brief(state(w).retry)).text;
  assert.ok(own.includes(`- ${rel('failure-1.md')} (the last attempt failed: read why first)`), own);
  assert.doesNotMatch(own, /Why this step is yours|\{\{/);
  await fail(w);
  climb(w);
  await fail(w);
  climb(w);
  const retry = state(w).retry;
  const build = (await brief({ ...retry, phase: 'build' })).text;
  assert.ok(build.includes(`## Why this step is yours\n\nIt failed 3 times (sonnet 2, opus 1). Read every report first, in order: each says what that attempt tried.\n\n- ${rel('failure-1.md')}\n- ${rel('failure-2.md')}\n- ${rel('failure-3.md')}\n\n## Outputs: write every one`), build);
  assert.doesNotMatch(build, /the last attempt failed|\{\{/, 'a rung attempt names its reports once, in its own section');

  const designed = await brief(retry);
  assert.deepEqual([designed.path, designed.design], [join(w.p.dir, 'steps/S-1/design-brief.md'), 'steps/S-1/design-1.md']);
  for (const s of [`\`${rel('design-1.md')}\`: the files and functions to change`, `Design only: write \`${rel('design-1.md')}\` and nothing under the step's outputs; the caller builds.`,
    `- ${rel('failure-3.md')}\n`, 'kirunak/tasks/offline-forecast/evidence/S-1-cache-sizes.tsv', '- docs/offline.md']) {
    assert.ok(designed.text.includes(s), s);
  }
  assert.doesNotMatch(designed.text, /\{\{|Build exactly this design/);

  const after = (await brief({ ...retry, phase: 'build', design: 'steps/S-1/design-1.md' })).text;
  assert.ok(after.includes(`Read the design first, then every report, in order: each says what that attempt tried.\n\n- ${rel('design-1.md')}: the design. Build exactly this design; where it is wrong, say so in the report.\n- ${rel('failure-1.md')}\n- ${rel('failure-2.md')}\n- ${rel('failure-3.md')}\n`), after);
});

test('historyOf takes under 5 ms on a progress.md of 2,000 lines (it runs on every pass)', () => {
  const verbs = ['started (opus high, session 7c1e, rung opus)', 'failed: exit 1', 'waiting for a heavy job: tests', 'resumed (session 7c1e)', 'finished'];
  const text = Array.from({ length: 2000 }, (_, i) => `2026-11-03 14:${String(i % 60).padStart(2, '0')} S-${(i % 12) + 1} ${verbs[i % verbs.length]}`).join('\n') + '\n';
  for (let i = 0; i < 20; i++) steps.historyOf(text, 'S-3');
  const times = Array.from({ length: 50 }, () => {
    const t0 = process.hrtime.bigint();
    steps.historyOf(text, 'S-3');
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }).sort((a, b) => a - b);
  assert.ok(times[25] < 5, `median ${times[25].toFixed(3)} ms`);
});

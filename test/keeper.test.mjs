import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakEven, costOf, decide, readSession, record, removeSession, ruleFor, updateSession } from '../lib/keeper.mjs';
import pricesDefault, { BASE } from '../plugins/prices-default.mjs';

const prices = (base) => ({ weights: () => base });
const wsWith = (p = pricesDefault().provides.prices, keeper = { intervalMinutes: 50 }) => ({ seams: { prices: p }, keeper });

test('the break-even comes from the prices seam: 19 intervals at 1h, 11.5 at 5m', async () => {
  const w = await pricesDefault().provides.prices.weights('opus');
  assert.equal(breakEven(w, '1h'), 19);
  assert.equal(breakEven(w, '5m'), 11.5);
  const sonnet = await pricesDefault().provides.prices.weights('sonnet');
  assert.equal(breakEven(sonnet, '1h'), 19, 'the model multiplier cancels');
});

test('the threshold is 950 minutes at 50-minute intervals, 52 under the 5-minute cache; a changed price moves it', async () => {
  const hour = await ruleFor(wsWith(), '1h');
  assert.deepEqual([hour.breakEven, hour.intervalMinutes, hour.thresholdMinutes, hour.marginMinutes], [19, 50, 950, 10]);
  const five = await ruleFor(wsWith(), '5m');
  assert.deepEqual([five.breakEven, five.intervalMinutes, Math.round(five.thresholdMinutes), five.marginMinutes], [11.5, 4.5, 52, 0.5]);
  const at55 = await ruleFor(wsWith(undefined, { intervalMinutes: 55 }), '1h');
  assert.deepEqual([at55.thresholdMinutes, at55.marginMinutes], [1045, 5], '17.4 hours at 55 minutes, a keep-alive 5 minutes before the expiry');
  const dearer = await ruleFor(wsWith(prices({ ...BASE, write1h: 3 })), '1h');
  assert.deepEqual([dearer.breakEven, dearer.thresholdMinutes], [29, 1450]);
  const cheaperReads = await ruleFor(wsWith(prices({ ...BASE, cacheRead: 0.05 })), '1h');
  assert.equal(cheaperReads.breakEven, 39);
  assert.equal(await ruleFor(wsWith(), '10m'), null, 'an unknown lifetime has no rule');
});

const NOW = new Date('2026-11-03T12:00:00Z');
const min = (m) => new Date(NOW.getTime() + m * 60000).toISOString();
const conv = (over) => ({ ttl: '1h', lastCall: min(-20), expiresAt: min(40), context: 200000, waitsFor: 'heavy', willResume: true, expectedWaitMin: 90, ...over });

test('the decision table', async () => {
  const rule = await ruleFor(wsWith(), '1h');
  const keep = decide(conv(), NOW, rule);
  assert.equal(keep.action, 'keepalive');
  assert.equal(keep.kind, 'keepalive');
  assert.equal(keep.at.toISOString(), min(30), 'at expires_at − 10 min, every 50 minutes');
  assert.equal(decide(conv({ waitsFor: 'k run', expectedWaitMin: 949 }), NOW, rule).action, 'keepalive', 'just under the threshold');

  const owner = decide(conv({ waitsFor: 'owner', willResume: false, expectedWaitMin: null }), NOW, rule);
  assert.deepEqual([owner.action, owner.kind, owner.reason], ['skip', 'skip', 'owner']);

  const expired = decide(conv({ expiresAt: min(-1) }), NOW, rule);
  assert.deepEqual([expired.action, expired.kind], ['none', 'miss']);
  assert.equal(decide(conv({ expiresAt: min(0), waitsFor: 'owner' }), NOW, rule).kind, 'miss', 'expired at the very minute');

  const over = decide(conv({ expectedWaitMin: 950 }), NOW, rule);
  assert.deepEqual([over.action, over.kind], ['skip', 'skip']);
  assert.match(over.reason, /over the break-even, 950 min/);
  assert.equal(decide(conv({ expectedWaitMin: null }), NOW, rule).action, 'skip', 'an unknown wait is not under the threshold');

  assert.deepEqual([decide(conv({ willResume: false }), NOW, rule).action, decide(conv({ willResume: false }), NOW, rule).kind], ['none', null]);
  assert.equal(decide(conv({ waitsFor: null }), NOW, rule).action, 'none', 'a conversation at work waits for nothing');
  assert.equal(decide(conv({ expiresAt: null }), NOW, rule).action, 'none');
  assert.equal(decide(conv(), NOW, null).action, 'none', 'no rule without a known lifetime');

  const five = await ruleFor(wsWith(), '5m');
  const short = decide(conv({ ttl: '5m', expiresAt: min(3), expectedWaitMin: 30 }), NOW, five);
  assert.deepEqual([short.action, short.at.toISOString()], ['keepalive', min(2.5)]);
  assert.equal(decide(conv({ ttl: '5m', expiresAt: min(3), expectedWaitMin: 60 }), NOW, five).action, 'skip', 'an hour is over 52 minutes');
});

test('what a keep-alive, a hit and a miss cost, in weight', async () => {
  const rule = await ruleFor(wsWith(), '1h');
  assert.equal(costOf('keepalive', 200000, rule), 20000);
  assert.equal(costOf('hit', 200000, rule), 20000);
  assert.equal(costOf('miss', 200000, rule), 400000);
  assert.equal(costOf('miss', 200000, await ruleFor(wsWith(), '5m')), 250000);
  assert.equal(costOf('skip', 200000, rule), 0);
  assert.equal(costOf('miss', null, rule), null);
});

test('a session file is merged and written whole; a bad id is refused; keeper.jsonl gets one line each', () => {
  const home = mkdtempSync(join(tmpdir(), 'kirunak-keeper-'));
  updateSession(home, 's-1', { task: 'weather/x', step: null });
  updateSession(home, 's-1', { context: 5, ttl: '1h' });
  assert.deepEqual(readSession(home, 's-1'), { task: 'weather/x', step: null, context: 5, ttl: '1h' });
  assert.throws(() => updateSession(home, '../escape', {}), /not a session id/);
  assert.equal(readSession(home, '../escape'), null);
  removeSession(home, 's-1');
  assert.equal(readSession(home, 's-1'), null);
  record(home, { session: 's-1', kind: 'skip' });
  record(home, { session: 's-1', kind: 'miss' });
  assert.equal(readFileSync(join(home, 'keeper.jsonl'), 'utf8').trim().split('\n').length, 2);
});

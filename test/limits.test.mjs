import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitsLine, logLimits } from '../lib/limits.mjs';

// gulnya/quad-damage AC-9, AC-10: a limits reading appended to the log the status line keeps, in its own format.

const READING = { fiveHour: { used: 1.5, resetsAt: 1793142600 }, week: { used: 53.99, resetsAt: 1793545200 }, overage: false };
const AT = new Date('2026-10-27T23:18:51.456Z');
const RESETS = '2026-11-01T15:00:00Z\t2026-10-27T23:10:00Z';

test('the line: the UTC time to the second, the week, the 5-hour window, each cut to a whole percent, the label, and the windows\' resets', () => {
  assert.equal(limitsLine(READING, { label: 'quad-damage', now: AT }), `2026-10-27T23:18:51Z\t53\t1\tquad-damage\t${RESETS}`);
  assert.equal(limitsLine({ ...READING, week: { used: 100 } }, { now: AT }), '2026-10-27T23:18:51Z\t100\t1\t-\t-\t2026-10-27T23:10:00Z');
  assert.equal(limitsLine(READING, { label: ' quad\tdamage\n', now: AT }), `2026-10-27T23:18:51Z\t53\t1\tquad damage\t${RESETS}`);
});

test('logLimits appends to the workspace\'s bugs.limitsLog, beside its module, and writes nothing without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-limits-'));
  const ws = { modulePath: join(dir, 'workspace.mjs'), bugs: { limitsLog: 'state/rate-limits.log' } };
  const log = join(dir, 'state', 'rate-limits.log');
  assert.equal(logLimits(ws, READING, { label: 'quad-damage', now: AT }), `2026-10-27T23:18:51Z\t53\t1\tquad-damage\t${RESETS}`);
  logLimits(ws, { ...READING, fiveHour: { used: 90.2 } }, { now: new Date('2026-10-28T01:00:00Z') });
  assert.equal(readFileSync(log, 'utf8'), `2026-10-27T23:18:51Z\t53\t1\tquad-damage\t${RESETS}\n2026-10-28T01:00:00Z\t53\t90\t-\t2026-11-01T15:00:00Z\t-\n`);
  const elsewhere = join(dir, 'abs.log');
  assert.ok(logLimits({ ...ws, bugs: { limitsLog: elsewhere } }, READING, { now: AT }));
  assert.equal(readFileSync(elsewhere, 'utf8'), `2026-10-27T23:18:51Z\t53\t1\t-\t${RESETS}\n`);

  assert.equal(logLimits({ modulePath: ws.modulePath }, READING), null);
  assert.equal(logLimits({ ...ws, bugs: { limitsLog: ' ' } }, READING), null);
  assert.equal(logLimits(ws, { error: 'the session gave no rate_limit_event' }), null);
  mkdirSync(join(dir, 'a-folder'));
  assert.equal(logLimits({ ...ws, bugs: { limitsLog: 'a-folder' } }, READING), null, 'a failed write is swallowed, as the status line does');
  assert.equal(readFileSync(log, 'utf8').split('\n').length, 3);
});

test('logLimits: a plan with no 5-hour window (fiveHour null) logs -1 for it, as the status line tracker does (gulnya/five-hour-optional)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-limits-'));
  const ws = { modulePath: join(dir, 'workspace.mjs'), bugs: { limitsLog: 'rate-limits.log' } };
  const line = logLimits(ws, { ...READING, fiveHour: null }, { label: 'quad-damage', now: AT });
  assert.deepEqual(line.split('\t').slice(0, 4), ['2026-10-27T23:18:51Z', '53', '-1', 'quad-damage']);
  assert.equal(readFileSync(join(dir, 'rate-limits.log'), 'utf8'), `${line}\n`);
});

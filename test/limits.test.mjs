import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitsLine, logLimits } from '../lib/limits.mjs';

// gulnya/quad-damage AC-9, AC-10: a limits reading appended to the log the status line keeps, in its own format.

const READING = { fiveHour: { used: 1.5, resetsAt: 1793142600 }, week: { used: 53.99, resetsAt: 1793545200 }, overage: false };
const AT = new Date('2026-10-27T23:18:51.456Z');

test('the line: the UTC time to the second, the week, the 5-hour window, each cut to a whole percent, and the label', () => {
  assert.equal(limitsLine(READING, { label: 'quad-damage', now: AT }), '2026-10-27T23:18:51Z\t53\t1\tquad-damage');
  assert.equal(limitsLine({ ...READING, week: { used: 100 } }, { now: AT }), '2026-10-27T23:18:51Z\t100\t1\t-');
  assert.equal(limitsLine(READING, { label: ' quad\tdamage\n', now: AT }), '2026-10-27T23:18:51Z\t53\t1\tquad damage');
});

test('logLimits appends to the workspace\'s bugs.limitsLog, beside its module, and writes nothing without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kirunak-limits-'));
  const ws = { modulePath: join(dir, 'workspace.mjs'), bugs: { limitsLog: 'state/rate-limits.log' } };
  const log = join(dir, 'state', 'rate-limits.log');
  assert.equal(logLimits(ws, READING, { label: 'quad-damage', now: AT }), '2026-10-27T23:18:51Z\t53\t1\tquad-damage');
  logLimits(ws, { ...READING, fiveHour: { used: 90.2 } }, { now: new Date('2026-10-28T01:00:00Z') });
  assert.equal(readFileSync(log, 'utf8'), '2026-10-27T23:18:51Z\t53\t1\tquad-damage\n2026-10-28T01:00:00Z\t53\t90\t-\n');
  const elsewhere = join(dir, 'abs.log');
  assert.ok(logLimits({ ...ws, bugs: { limitsLog: elsewhere } }, READING, { now: AT }));
  assert.equal(readFileSync(elsewhere, 'utf8'), '2026-10-27T23:18:51Z\t53\t1\t-\n');

  assert.equal(logLimits({ modulePath: ws.modulePath }, READING), null);
  assert.equal(logLimits({ ...ws, bugs: { limitsLog: ' ' } }, READING), null);
  assert.equal(logLimits(ws, { error: 'the session gave no rate_limit_event' }), null);
  mkdirSync(join(dir, 'a-folder'));
  assert.equal(logLimits({ ...ws, bugs: { limitsLog: 'a-folder' } }, READING), null, 'a failed write is swallowed, as the status line does');
  assert.equal(readFileSync(log, 'utf8').split('\n').length, 3);
});

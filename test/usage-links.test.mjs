// links.jsonl, the append-only log of k start's links (gulnya/usage-improve-11-22 AC-1, AC-2, E-1, E-2): k start
// appends { session, task, since }, the release { session, task, until } before it deletes the live file, a /clear's
// carry a `since` for the new id, and k usage's joinOf reads the log beside the live files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start } from '../lib/handoff.mjs';
import { byTask } from '../lib/usage/bytask.mjs';
import { joinOf } from '../lib/usage/tasks.mjs';
import { clearFire, onEnd } from '../hooks/compact-clear.mjs';
import handoffNotes from '../plugins/handoff-notes.mjs';
import { makeWorkspace, tempDir } from './helpers.mjs';

const ID = 'weather/offline-forecast';
const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const logOf = (home) => readFileSync(join(home, 'sessions', 'links.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const release = (w, session) => handoffNotes(w.ws).provides.handoff.release({ session });
const noTasks = () => new Map();

test('k start links a session in links.jsonl, the release ends it, and a call between joins the task (AC-1)', async () => {
  const w = await makeWorkspace();
  const t0 = Date.now() - 3600_000;
  start({ ws: w.ws, id: ID, session: S, now: new Date(t0) });
  release(w, S);
  const log = logOf(w.home);
  assert.deepEqual(log[0], { session: S, task: ID, since: new Date(t0).toISOString() });
  assert.equal(log[1].session, S);
  assert.equal(log[1].task, ID);
  assert.ok(Date.parse(log[1].until) >= t0, 'the release appends its until');
  const of = joinOf({ tasks: noTasks(), home: w.home, sessions: new Set([S]) });
  assert.deepEqual(of(S, t0 + 60_000), { task: ID, step: null });
});

test('a call after the release joins no task, though the session ran a step of it before (AC-2)', async () => {
  const w = await makeWorkspace();
  const t0 = Date.now() - 3600_000;
  const tasks = new Map([[ID, { id: ID, dirs: [], steps: [{ task: ID, step: 'S-1', named: S, start: t0 - 7200_000, end: t0 - 5400_000 }] }]]);
  start({ ws: w.ws, id: ID, session: S, now: new Date(t0) });
  release(w, S);
  const of = joinOf({ tasks, home: w.home, sessions: new Set([S]) });
  assert.deepEqual(of(S, t0 - 6000_000), { task: ID, step: 'S-1' });
  assert.deepEqual(of(S, t0 + 60_000), { task: ID, step: null });
  assert.deepEqual(of(S, Date.now() + 60_000), { task: null, step: null });
});

test('a links.jsonl line that is not JSON or lacks a session or task is skipped and counted (E-1)', () => {
  const home = tempDir();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'links.jsonl'), [
    '{"session":"' + S + '","task":"' + ID + '","since":"2026-11-20T10:00:00.000Z"}',
    '{not json',
    '{"session":"' + S + '","since":"2026-11-20T11:00:00.000Z"}',
    '[1,2]',
    '',
  ].join('\n'));
  const of = joinOf({ tasks: noTasks(), home, sessions: new Set([S]) });
  assert.equal(of.skipped, 3);
  assert.deepEqual(of(S, Date.parse('2026-11-20T12:00:00Z')), { task: ID, step: null });
  const rows = [{ kind: 'call', ts: '2026-11-20T12:00:00.000Z', session: S, model: 'claude-opus-5-5', input: 10, output: 1 }];
  const r = byTask({ rows, tasks: noTasks(), home, from: '2026-11-16T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' });
  assert.match(r.text.split('\n')[0], /, 3 links\.jsonl lines skipped$/);
  assert.equal(r.tasks[0].name, ID);
});

test('a session linked twice holds the later task from its since (E-2)', () => {
  const home = tempDir();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const B = 'weather/radar';
  writeFileSync(join(home, 'sessions', 'links.jsonl'), [
    { session: S, task: ID, since: '2026-11-20T10:00:00.000Z' },
    { session: S, task: B, since: '2026-11-20T12:00:00.000Z' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const of = joinOf({ tasks: noTasks(), home, sessions: new Set([S]) });
  assert.equal(of.skipped, 0);
  assert.deepEqual(of(S, Date.parse('2026-11-20T09:00:00Z')), { task: null, step: null });
  assert.deepEqual(of(S, Date.parse('2026-11-20T11:00:00Z')), { task: ID, step: null });
  assert.deepEqual(of(S, Date.parse('2026-11-20T13:00:00Z')), { task: B, step: null });
});

test("a /clear's successor holds the task in links.jsonl, after the release too (E-2)", async () => {
  const w = await makeWorkspace();
  const T = 'bbbbbbbb-1111-2222-3333-444444444444';
  const t0 = Date.now() - 3600_000, t1 = Date.now() - 1800_000;
  start({ ws: w.ws, id: ID, session: S, now: new Date(t0) });
  onEnd({ reason: 'clear', session_id: S, cwd: w.weather }, w.home, new Date(t1));
  const r = await clearFire(w.home, { source: 'clear', session_id: T, cwd: w.weather }, 'state', new Date(t1 + 1000));
  assert.equal(r.put, true);
  assert.deepEqual(logOf(w.home).find((l) => l.session === T), { session: T, task: ID, since: new Date(t1 + 1000).toISOString() });
  release(w, T);
  const of = joinOf({ tasks: noTasks(), home: w.home, sessions: new Set([S, T]) });
  assert.deepEqual(of(T, t1 + 60_000), { task: ID, step: null });
  assert.deepEqual(of(T, Date.now() + 60_000), { task: null, step: null });
});

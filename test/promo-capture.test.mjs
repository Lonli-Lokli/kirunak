import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, checkDir } from '../promo/capture/check.mjs';
import { COLS, ROWS, collect, record, refusal } from '../promo/capture/fresh-home.mjs';
import { intakeDialogs, read } from '../promo/capture/read.mjs';

const START = Date.UTC(2026, 9, 22, 9, 0);
const NAMES = ['someones-mac'];
const temp = () => mkdtempSync(join(tmpdir(), 'capture-'));
const jsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lines = (pieces) => pieces.map((p) => JSON.stringify(p) + '\n').join('');

// A raw session made by hand: each [ms after START, text] is one chunk the terminal showed.
function session(chunks, { dialogs = [], events = [], transcript = null, end = true, name = '01-setup', sessionId = 'sess-1', kirunakCommit = null } = {}) {
  const dir = temp();
  let o = 0;
  const bufs = [];
  const times = [];
  for (const [t, text] of chunks) {
    const b = Buffer.from(text);
    bufs.push(b);
    times.push({ o, n: b.length, t: START + t });
    o += b.length;
  }
  if (end) times.push({ end: true, code: 0, t: START + chunks.at(-1)[0] + 10 });
  writeFileSync(join(dir, 'terminal.raw'), Buffer.concat(bufs));
  writeFileSync(join(dir, 'terminal.times.jsonl'), lines(times));
  writeFileSync(join(dir, 'dialogs.jsonl'), lines(dialogs));
  writeFileSync(join(dir, 'events.jsonl'), lines(events));
  mkdirSync(join(dir, 'transcripts'));
  if (transcript) writeFileSync(join(dir, 'transcripts', `${sessionId}.jsonl`), lines(transcript));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, start: START, end: START + 60_000, cols: COLS, rows: ROWS, home: '/Users/Shared/home', cwd: '/Users/Shared/home', sessionId, claudeVersion: '2.1.307 (Claude Code)', kirunakCommit, shell: '/bin/zsh' }));
  return dir;
}

const TRANSCRIPT = [
  { type: 'user', timestamp: new Date(START + 1000).toISOString(), message: { content: '<command-name>/k-approve</command-name>' } },
  { type: 'assistant', timestamp: new Date(START + 2000).toISOString(), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ header: 'Goal', question: 'Who is the page for?', options: [{ label: 'Anyone' }, { label: 'Lawyers' }] }] } }] } },
  { type: 'user', timestamp: new Date(START + 5000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'answered' }] }, toolUseResult: { answers: { 'Who is the page for?': 'Anyone' } } },
];
const DIALOG = { t: START + 3000, session: 'sess-1', command: 'k-approve', header: 'Approve', text: ['app/redact: Real redaction.'], question: 'Approve it?', choices: ['Approve app/redact', 'Back'], tap: 'Approve app/redact', tAnswer: START + 4000, end: 'approve app/redact --via mod' };
const SCRIPTED = [
  [0, '~ % '],
  [100, 'k'], [150, ' d'], [200, 'octor\r\n'],
  [300, '⠋ Checking\r'], [400, '⠙ Checking\r'], [500, '⠹ Checking\r'],
  [600, '\x1b[2Kk doctor: all green\r\n~ % '],
];

test('a scripted session is read back line by line, in order, with its times; typing and a spinner are one line each, a cleared line ends', async () => {
  const out = temp();
  const r = await read(session(SCRIPTED, { transcript: TRANSCRIPT }), out, { names: NAMES, complete: true });
  assert.deepEqual(r.problems, []);
  const got = jsonl(join(out, 'lines.jsonl'));
  assert.deepEqual(got.map((l) => [l.id, l.t, l.row, l.text]), [
    ['01-setup:0001', 0, 0, '~ % k doctor'],
    ['01-setup:0002', 300, 1, '⠋ Checking'],
    ['01-setup:0003', 600, 1, 'k doctor: all green'],
    ['01-setup:0004', 600, 2, '~ %'],
  ]);
  assert.equal(got[1].tEnd, 600, 'the spinner line ends when the line is cleared');
  assert.equal(got[0].tEnd, 600);
});

test('the ids are stable: reading the same raw again gives the same files', async () => {
  const raw = session(SCRIPTED, { transcript: TRANSCRIPT, dialogs: [DIALOG] });
  const [a, b] = [temp(), temp()];
  await read(raw, a, { names: NAMES });
  await read(raw, b, { names: NAMES });
  for (const f of ['lines.jsonl', 'dialogs.jsonl', 'manifest.json']) assert.equal(readFileSync(join(a, f), 'utf8'), readFileSync(join(b, f), 'utf8'), f);
});

test('a mod dialog and an intake question are read back with what they drew, the tap and their times from the start', async () => {
  const out = temp();
  const r = await read(session(SCRIPTED, { transcript: TRANSCRIPT, dialogs: [DIALOG], events: [{ time: new Date(START + 4200).toISOString(), kind: 'approved', task: 'app/redact' }] }), out, { names: NAMES, complete: true });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(jsonl(join(out, 'dialogs.jsonl')), [
    { id: '01-setup:d001', t: 2000, command: 'AskUserQuestion', header: 'Goal', text: [], question: 'Who is the page for?', choices: ['Anyone', 'Lawyers'], tap: 'Anyone', tAnswer: 5000, end: null, source: 'intake' },
    { id: '01-setup:d002', t: 3000, command: 'k-approve', header: 'Approve', text: ['app/redact: Real redaction.'], question: 'Approve it?', choices: ['Approve app/redact', 'Back'], tap: 'Approve app/redact', tAnswer: 4000, end: 'approve app/redact --via mod', source: 'mod' },
  ]);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.start, '2026-10-22T09:00:00.000Z');
});

test('an intake call that asks two questions is two dialogs, each with its own answer', () => {
  const at = (ms) => new Date(START + ms).toISOString();
  const two = [
    { type: 'assistant', timestamp: at(2000), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'AskUserQuestion', input: { questions: [{ header: 'Goal', question: 'Who is the page for?', options: [{ label: 'Anyone' }, { label: 'Lawyers' }] }, { header: 'Size', question: 'How long?', options: [{ label: 'One page' }, { label: 'Two' }] }] } }] } },
    { type: 'user', timestamp: at(6000), message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'answered' }] }, toolUseResult: { answers: { 'Who is the page for?': 'Lawyers', 'How long?': 'as short as it can be' } } },
  ];
  assert.deepEqual(intakeDialogs(two).map((d) => [d.t - START, d.header, d.question, d.choices, d.tap, d.typed ?? null, d.end, d.tAnswer - START]), [
    [2000, 'Goal', 'Who is the page for?', ['Anyone', 'Lawyers'], 'Lawyers', null, null, 6000],
    [2000, 'Size', 'How long?', ['One page', 'Two'], null, 'as short as it can be', 'typed', 6000],
  ]);
});

test('the check refuses a planted token, a PEM key, a private path, a machine name and a deny word; a digest and the fresh home pass', () => {
  const planted = [
    { id: 'a', text: 'export KEY=sk-ant-api03-abc' },
    { id: 'b', text: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    { id: 'c', text: 'cd /Users/someone/code' },
    { id: 'd', text: 'someones-mac:~ dev$' },
    { id: 'e', text: 'built for Acmeworks' },
    { id: 'f', text: 'seed MC4CAQAwBQYDK2VwBCIEIGx9bq0dVsl1n0tXgLqk' },
    { id: 'ok', text: '~/code/app % ls /Users/Shared/home/code/app; review.md sha256:3f2a000000000000000000000000000000000000000000000000000000000000' },
  ];
  const found = check(planted, { deny: ['acmeworks'], names: NAMES });
  assert.deepEqual(found.map((f) => [f.id, f.what]), [['a', 'an Anthropic key'], ['b', 'a PEM block'], ['c', 'a private path'], ['d', 'a name of this machine'], ['e', 'a denied word'], ['f', 'a long base64 run']]);
  assert.ok(found.every((f) => f.excerpt.includes('***')), 'a refusal masks what it found');
});

test('a real manifest passes: its UUID session id and 40-hex commit are known values, the same shapes elsewhere are refused', async () => {
  const sessionId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const kirunakCommit = 'dd0e21f0c3a1b2d4e5f60718293a4b5c6d7e8f90';
  const out = temp();
  const r = await read(session([...SCRIPTED, [700, `session ${sessionId}\r\n`]], { transcript: TRANSCRIPT, sessionId, kirunakCommit }), out, { names: NAMES, complete: true });
  assert.deepEqual([r.refused, r.problems], [[], []]);
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).kirunakCommit, kirunakCommit);
  assert.deepEqual(checkDir(out, { names: NAMES }), [], 'the check run alone passes the written folder too');
  const other = [{ id: 'a', text: `ref ${'e'.repeat(40)}` }, { id: 'b', text: `id ${sessionId.replace('7c9e', '0000')}` }];
  assert.deepEqual(check(other, { names: NAMES, known: [sessionId, kirunakCommit] }).map((f) => f.what), ['a long hex run', 'a long base64 run']);
});

test('the check refuses a secret by its shape and passes the words in prose', () => {
  const items = [
    { id: 'a', text: 'export CLIENT_SECRET=x' },
    { id: 'b', text: 'client_secret: x' },
    { id: 'c', text: 'set GITHUB_SECRET in the function' },
    { id: 'd', text: 'PRIVATE KEY written' },
    { id: 'e', text: 'OAUTH_TOKEN' },
    { id: 'f', text: 'oauthClientId = x' },
    { id: 'ok1', text: "the private key stays in the function's secret store" },
    { id: 'ok2', text: 'Log in with OAuth' },
  ];
  assert.deepEqual(check(items, { names: NAMES }).map((f) => [f.id, f.what]), [['a', 'a secret'], ['b', 'a secret'], ['c', 'a secret'], ['d', 'a private key'], ['e', 'an OAuth token'], ['f', 'an OAuth setting']]);
  assert.deepEqual(check([{ id: 'b', text: '-----BEGIN OPENSSH PRIVATE KEY-----' }], { names: NAMES }).map((f) => f.what), ['a PEM block']);
});

test('the reader writes nothing when a line holds a secret', async () => {
  const out = join(temp(), 'pub');
  const r = await read(session([[0, '~ % echo ghp_abc\r\n']], { transcript: TRANSCRIPT }), out, { names: NAMES });
  assert.equal(r.refused[0].what, 'a GitHub token');
  assert.equal(existsSync(out), false);
});

test('a session is not complete without the exit, a transcript, a tap or end on every dialog, a dialog before each verb, or with a resize', async () => {
  const raw = session(SCRIPTED, { end: false, dialogs: [{ ...DIALOG, tap: null, end: null }], events: [{ time: new Date(START + 100).toISOString(), kind: 'accepted', task: 'app/other' }] });
  appendResize(raw);
  const r = await read(raw, temp(), { names: NAMES, complete: true });
  assert.equal(r.ok, false);
  assert.equal(existsSync(join(raw, 'complete.json')), false);
  for (const want of [/does not end with the shell's exit/, /resized to 120x40/, /no Claude Code transcript/, /d001 has no tap and no end/, /accepted app\/other .* has no dialog/]) assert.ok(r.problems.some((p) => want.test(p)), `${want}: ${r.problems.join(' | ')}`);
});

test('an approval with only a typed /k-approve before it and no dialog logged is not complete', async () => {
  const raw = session(SCRIPTED, { transcript: TRANSCRIPT, events: [{ time: new Date(START + 1500).toISOString(), kind: 'approved', task: 'app/redact' }] });
  const r = await read(raw, temp(), { names: NAMES, complete: true });
  assert.deepEqual(r.problems, ['events: approved app/redact at 2026-10-22T09:00:01.500Z: typed /k-approve at 2026-10-22T09:00:01.000Z but no dialog was logged']);
  assert.equal(existsSync(join(raw, 'complete.json')), false);
});

test('a dialog the mod logged with no time is collected from the fresh home and is a problem of its own', async () => {
  const home = temp();
  mkdirSync(join(home, '.kirunak'));
  writeFileSync(join(home, '.kirunak', 'dialogs.jsonl'), lines([{ ...DIALOG, t: null }, DIALOG, { ...DIALOG, t: START - 60_000 }]));
  const raw = session(SCRIPTED, { transcript: TRANSCRIPT });
  collect(home, raw, START, START + 60_000);
  assert.deepEqual(jsonl(join(raw, 'dialogs.jsonl')).map((d) => d.t), [null, START + 3000]);
  const r = await read(raw, temp(), { names: NAMES, complete: true });
  assert.deepEqual(r.problems, ['01-setup:d001 has no time: the mod could not read its clock when it asked']);
});

function appendResize(raw) {
  writeFileSync(join(raw, 'terminal.times.jsonl'), readFileSync(join(raw, 'terminal.times.jsonl'), 'utf8') + JSON.stringify({ resize: [120, 40], t: START + 700 }) + '\n');
}

test('the launcher refuses a wrong size, a capture whose newest session is not checked complete, and a numbered session while ahead', () => {
  const capture = temp();
  const base = { capture, name: '02-t1-intake', cols: COLS, rows: ROWS, ahead: null };
  assert.equal(refusal(base), null);
  assert.match(refusal({ ...base, cols: 80 }), /80x32/);
  assert.match(refusal({ ...base, ahead: 'master...origin/master [ahead 7]' }), /ahead/);
  assert.equal(refusal({ ...base, name: 'probe', ahead: 'master...origin/master [ahead 7]' }), null, 'the probe is not filmed');
  mkdirSync(join(capture, '01-setup'));
  assert.match(refusal(base), /01-setup is not checked complete/);
  writeFileSync(join(capture, '01-setup', 'complete.json'), '{}');
  assert.equal(refusal(base), null);
});

test('the recorder keeps every byte through script with each chunk timed, and ends with the exit', async () => {
  const raw = join(temp(), 'probe');
  const code = await record(raw, ['/bin/sh', '-c', 'printf "one\\n"; sleep 0.3; printf "two\\n"'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'inherit'] });
  assert.equal(code, 0);
  const bytes = readFileSync(join(raw, 'terminal.raw'));
  const marks = jsonl(join(raw, 'terminal.times.jsonl'));
  const chunks = marks.filter((m) => m.n !== undefined);
  assert.equal(chunks.reduce((s, c) => s + c.n, 0), bytes.length);
  assert.match(bytes.toString(), /one\r\ntwo\r\n/);
  const two = chunks.find((c) => bytes.subarray(c.o, c.o + c.n).toString().includes('two'));
  assert.ok(two.t - chunks[0].t >= 250, `each chunk is stamped as it arrives (${two.t - chunks[0].t} ms apart)`);
  assert.equal(marks.at(-1).end, true);
});

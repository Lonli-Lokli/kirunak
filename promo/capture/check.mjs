#!/usr/bin/env node
// What a capture's public part must never hold (kirunak-docs-promo S-1 §5): a token or key, a private path, this
// machine's user and host names, and the words of a private deny file. The reader runs it before it writes; run alone,
// `node promo/capture/check.mjs <public session dir> [--deny <file>]` checks a written one. The names of this machine
// are read at check time and never stored.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A file digest k prints (`sha256:<hex>`) is a hash of a public file, not a secret.
const DIGEST = /sha256:[0-9a-f]{64}/g;

// The manifest's own session id (a UUID) and kirunak commit (a git SHA) are public values the check knows: their exact
// strings are marked out of every item before the rules run, as a digest is, while their shapes stay refused anywhere
// else (a 40-hex run in a line can still be an old GitHub token) (S-3 F-1).
export const knownOf = (manifest) => [manifest?.sessionId, manifest?.kirunakCommit].filter((v) => typeof v === 'string' && v);

// The span's own Claude Code sessions are known values too (review N-1): each copied transcript's id (its file name,
// the UUID `claude --resume` prints at each exit), the session ids its lines carry, and Remote Control's id for it,
// which a `bridge-session` line carries as `cse_<id>` and the terminal prints as https://claude.ai/code/session_<id>.
// The reader shows each as `<session-n>` in the public part; any other long run is still refused. A value too short to
// be refused is left as it is, so no word is ever taken for one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionsOf(transcripts) {
  const ids = new Set();
  for (const t of transcripts) {
    ids.add(t.id);
    for (const e of t.entries) {
      for (const v of [e.sessionId, e.session_id]) if (typeof v === 'string' && UUID.test(v)) ids.add(v);
      if (typeof e.bridgeSessionId === 'string') ids.add(e.bridgeSessionId.replace(/^[a-z]+_/, ''));
      const url = typeof e.url === 'string' ? e.url.match(/\/code\/session_([A-Za-z0-9]+)/) : null;
      if (url) ids.add(url[1]);
    }
  }
  return [...ids].filter((v) => v.length >= 16);
}

// Each of `sessions` met in `texts`, numbered in order of first appearance, → the function that writes each as its
// `<session-n>`; the same raw gives the same numbers.
export function placeholdersOf(sessions, texts) {
  const names = new Map();
  for (const text of texts) {
    const met = sessions.filter((v) => !names.has(v) && text.includes(v)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
    for (const v of met) names.set(v, `<session-${names.size + 1}>`);
  }
  const order = [...names].sort(([a], [b]) => b.length - a.length);
  return (text) => order.reduce((s, [v, name]) => s.replaceAll(v, name), text);
}

const SHAPES = [
  ['an Anthropic key', /sk-ant-/],
  ['a GitHub token', /\bgh[pousr]_/],
  ['a bearer token', /Bearer\s/],
  ['a JWT', /eyJ[A-Za-z0-9_-]{8,}/],
  ['a PEM block', /-----BEGIN/],
  // A secret has a shape, a word is not one (S-3 F-3): the PEM header's words, a secret given a value, an env name
  // and an OAuth token or setting are refused, while "the private key stays in the secret store" or "Log in with OAuth"
  // passes.
  ['a private key', /PRIVATE KEY/],
  ['a secret', /secret\s*[=:]\s*\S/i],
  ['a secret', /(?<![A-Za-z0-9])SECRET(?![A-Za-z0-9])/],
  ['a token in a URL', /token=/i],
  ['an OAuth token', /oauth[_-]?token/i],
  ['an OAuth setting', /oauth\S*\s*[=:]/i],
  ['a credentials file', /\.credentials\.json/],
  ['a long hex run', /[0-9a-fA-F]{32,}/],
  ['a long base64 run', /[A-Za-z0-9+=_-]{32,}/],
  ['a private path', /\/Users\/(?!Shared(?:\/|\b))[^\s/'"]+/],
  ['a private path', /(?<![\w./-])\/home\/(?!dev\b)[^\s/'"]+/],
  ['nvm', /\.nvm\b/],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (s) => new RegExp(`(?<![A-Za-z0-9])${escape(s)}(?![A-Za-z0-9])`, 'i');

// This machine's names: its user, its host name, its short host name and its local host name.
export function machineNames() {
  const names = new Set([userInfo().username, hostname(), hostname().split('.')[0]]);
  try {
    names.add(execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // Not a Mac: the host name alone.
  }
  return [...names].filter((n) => n && n.length > 2);
}

export function denyWords(file) {
  if (!file) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

// `masked`: the match with its middle starred, so the refusal itself does not print a whole secret.
const masked = (s) => (s.length <= 6 ? `${s[0]}***` : `${s.slice(0, 3)}***${s.slice(-2)}`);

// Each item is { id, text }; the answer is one refusal per offending item: its id, what it looks like and a masked
// excerpt.
export function check(items, { deny = [], names = machineNames(), known = [] } = {}) {
  const rules = [...SHAPES, ...names.map((n) => ['a name of this machine', word(n)]), ...deny.map((w) => ['a denied word', word(w)])];
  const found = [];
  for (const { id, text } of items) {
    const plain = known.reduce((s, k) => s.replaceAll(k, '<known>'), String(text).replace(DIGEST, 'sha256:'));
    for (const [what, re] of rules) {
      const m = plain.match(re);
      if (m) {
        found.push({ id, what, excerpt: masked(m[0]) });
        break;
      }
    }
  }
  return found;
}

const manifestOf = (dir) => (existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null);

// Every text of a public session folder: each line, each string of each dialog and each manifest field.
export function itemsOf(dir) {
  const jsonl = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const items = jsonl('lines.jsonl').map((l) => ({ id: l.id, text: l.text }));
  for (const d of jsonl('dialogs.jsonl')) items.push({ id: d.id, text: [d.command, d.header, ...(d.text ?? []), d.question, ...(d.choices ?? []), d.tap, d.typed, d.end].filter((x) => x != null).join('\n') });
  for (const [k, v] of Object.entries(manifestOf(dir) ?? {})) items.push({ id: `manifest.${k}`, text: JSON.stringify(v) });
  return items;
}

// A written public folder checked as the reader checked it, its manifest's known values included.
export function checkDir(dir, { deny = [], names } = {}) {
  return check(itemsOf(dir), { deny, known: knownOf(manifestOf(dir)), ...(names && { names }) });
}

export function report(found) {
  return found.map((f) => `${f.id}: ${f.what} (${f.excerpt})`).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--deny');
  if (!dir) {
    console.error('usage: check.mjs <public session dir> [--deny <file>]');
    process.exit(2);
  }
  const found = checkDir(dir, { deny: denyWords(at >= 0 ? rest[at + 1] : null) });
  if (found.length) {
    console.error(`refused, ${found.length} item(s) hold what a capture must not:\n${report(found)}`);
    process.exit(1);
  }
  console.log(`${dir}: nothing private`);
}

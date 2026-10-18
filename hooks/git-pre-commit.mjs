#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The pre-commit hook (approval.md §3). It reads the index and refuses a commit when:
// 1. a staged task.md no longer matches its approval record's hash, unless KIRUNAK_APPROVING names the task;
// 2. it stages what only the owner's commands write (approvals/, done.json, hold.md, an amendment's stamp), unless
//    KIRUNAK_APPROVING, KIRUNAK_ACCEPTING or KIRUNAK_HOLDING names the task;
// 3. a staged intake.md is not an append of the committed one.
// The owner's commands set those variables on the one `git commit` they run. A mistake guard, not a lock.

const TASK = /^kirunak\/tasks\/([^/]+)\/task\.md$/;
const INTAKE = /^kirunak\/tasks\/([^/]+)\/intake\.md$/;
const OWNED = /^kirunak\/tasks\/([^/]+)\/(done\.json|hold\.md)$/;
const RECORD = /^kirunak\/approvals\/(?:.*\/)?([^/]+?)(?:\.json)?$/;
const AMENDMENT = /^kirunak\/tasks\/([^/]+)\/amendments\/[^/]+$/;
const STAMP = /^(applied|declined):/gm;
const OWNER_VARS = ['KIRUNAK_APPROVING', 'KIRUNAK_ACCEPTING', 'KIRUNAK_HOLDING'];

const hashBytes = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

// A variable names the task when it is its id (`<repo>/<slug>`) or its slug.
const names = (value, slug) => typeof value === 'string' && value !== '' && value.split('/').pop() === slug;

const stamps = (buf) => (buf ? (buf.toString('utf8').match(STAMP) ?? []).length : 0);

/**
 * The problems that refuse a commit. `staged` are the staged paths (relative to the repo root), `show(spec)` returns
 * the bytes of `:path` (the index) or `HEAD:path`, or null when there are none.
 */
export function check({ staged, show, env = process.env }) {
  const read = (spec) => {
    const b = show(spec);
    return b == null ? null : Buffer.from(b);
  };
  const byOwner = (slug) => OWNER_VARS.some((v) => names(env[v], slug));
  const problems = [];
  for (const path of staged) {
    let m;
    if ((m = TASK.exec(path))) {
      const slug = m[1];
      const where = `kirunak/approvals/${slug}.json`;
      const raw = read(`:${where}`) ?? read(`HEAD:${where}`);
      if (!raw) continue;
      let rec;
      try {
        rec = JSON.parse(raw.toString('utf8'));
      } catch {
        rec = {};
      }
      const bytes = read(`:${path}`);
      const id = typeof rec.task === 'string' ? rec.task : slug;
      if ((!bytes || hashBytes(bytes) !== rec.hash) && !names(env.KIRUNAK_APPROVING, slug)) {
        problems.push(`kirunak: ${path}: task.md changed after approval; ` +
          `\`k approve ${id} --amendment A-n\` applies an approved amendment and re-hashes`);
      }
    } else if ((m = RECORD.exec(path) ?? OWNED.exec(path))) {
      if (!byOwner(m[1])) problems.push(`kirunak: ${path}: written by the owner's command only`);
    } else if ((m = AMENDMENT.exec(path))) {
      if (stamps(read(`:${path}`)) > stamps(read(`HEAD:${path}`)) && !byOwner(m[1])) {
        problems.push(`kirunak: ${path}: its applied:/declined: stamp is written by the owner's command only`);
      }
    } else if (INTAKE.test(path)) {
      const before = read(`HEAD:${path}`);
      if (!before) continue;
      const after = read(`:${path}`);
      if (!after || after.length < before.length || !after.subarray(0, before.length).equals(before)) {
        problems.push(`kirunak: ${path}: intake.md is append-only; use \`k intake\``);
      }
    }
  }
  return problems;
}

function main() {
  const git = (args, encoding) =>
    execFileSync('git', args, { encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const staged = git(['diff', '--cached', '--name-only', '--no-renames', '-z'], 'utf8').split('\0');
  const ours = staged.filter((p) => p.startsWith('kirunak/'));
  if (!ours.length) return;
  const show = (spec) => {
    try {
      return git(['cat-file', 'blob', spec], 'buffer');
    } catch {
      return null;
    }
  };
  const problems = check({ staged: ours, show, env: process.env });
  if (!problems.length) return;
  process.stderr.write(problems.join('\n') + '\n');
  process.exitCode = 1;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) main();

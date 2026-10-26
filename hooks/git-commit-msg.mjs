#!/usr/bin/env node
// commit-msg: a commit whose message names a task the owner accepted is refused unless it stages only kirunak's
// records (AC-8, E-1, approval.md §3), now on the message the commit keeps, typed in the editor or given with -m or -F:
// prepare-commit-msg runs before the editor. Its paths are taken against the base prepare-commit-msg left in the git
// folder; with none, a merge or a replay that hook let through, nothing is checked. git skips this hook under
// --no-verify, where prepare-commit-msg's check of a message given with -m or -F is all that runs.
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_FILE, doneNamed, doneRefusal } from '../lib/records.mjs';
import { repoInfo } from '../lib/slap.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [msgFile] = argv;
  const info = repoInfo(process.cwd());
  const baseFile = join(info.gitDir, BASE_FILE);
  let base;
  try {
    base = readFileSync(baseFile, 'utf8').trim();
  } catch {
    return 0;
  }
  rmSync(baseFile, { force: true });
  const done = await doneNamed(info, readFileSync(msgFile, 'utf8'), base, env);
  if (!done) return 0;
  console.error(doneRefusal(done));
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`kirunak: the commit-msg hook failed: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
